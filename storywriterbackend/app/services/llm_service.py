import httpx
import json
import re
from typing import AsyncGenerator, Optional
from app.models import Settings

# Temperature for non-creative utility calls: summarisation, memory/fact
# extraction, speaker routing and image-prompt writing. These are structured
# extraction tasks where creativity is actively harmful — a "creative" summary
# is simply a wrong summary, and its output is fed back into later prompts.
# They must NOT inherit the user's creative temperature.
UTILITY_TEMPERATURE = 0.3

# Providers known to accept the OpenRouter-style `reasoning: {"enabled": true}`
# request flag. OpenAI itself rejects unknown params with a 400, so the flag is
# only ever sent to these.
REASONING_FLAG_HOSTS = ("nano-gpt.com", "openrouter.ai")


def supports_reasoning_flag(api_base_url: str) -> bool:
    return any(h in (api_base_url or "") for h in REASONING_FLAG_HOSTS)


class ReasoningChunk(str):
    """A streamed piece of the model's native reasoning (delta.reasoning /
    delta.reasoning_content), as opposed to its visible reply. Only yielded
    when generate() is called with yield_reasoning=True."""


# [NATIVE-REASONING 2026-10-01] ──────────────────────────────────────────────
# GLM 5.x on nano-gpt never emits <think>/</think> as text: they are special
# tokens the provider strips. Without the reasoning flag the model either wrote
# its CoT steps as untagged visible text (which the text heuristics in chat.py
# then had to guess the end of — the source of </think> landing mid-paragraph)
# or reasoned silently and the provider dropped it. Measured 2026-10-01: 0/44
# Roleplay replies tagged without the flag vs 49/49 clean with it, and prose
# appears no later. With reasoning requested, the steps arrive in a separate
# field; this wraps them in <think> tags at the source so the frontends, the
# stored text and history stripping all keep working unchanged. Used by
# Roleplay chat and Adventure.
async def with_think_tags(chunks):
    """Turn generate(..., yield_reasoning=True) output into plain text with the
    reasoning wrapped as a leading <think>…</think> block.

    When a model stops right after reasoning, nano-gpt copies the reasoning
    into the reply field (seen with GLM 5.2, DeepSeek R1 and Mistral). Reply
    text is therefore held back while it is still just a replay of the
    reasoning, and dropped if it never becomes anything else — leaving no prose
    after </think>, which callers detect with needs_prose()."""
    in_think = False
    prose_started = False
    reasoning = ""
    echo = None  # reply text held back while it matches the reasoning so far
    async for chunk in chunks:
        if isinstance(chunk, ReasoningChunk):
            if prose_started or echo is not None:
                continue  # reasoning arriving after the reply began would split the prose
            reasoning += chunk
            if not in_think:
                in_think = True
                chunk = "<think>\n" + chunk
            yield str(chunk)
            continue
        if in_think:
            chunk = chunk.lstrip()
            if not chunk:
                continue  # the provider's leading blank lines between reasoning and reply
            in_think = False
            yield "\n</think>\n"
            echo = ""
        if echo is not None:
            echo += chunk
            if reasoning.strip().startswith(echo.strip()):
                continue
            # Diverged. If the whole reasoning was replayed first, drop that copy.
            copied = echo.lstrip()
            if reasoning.strip() and copied.startswith(reasoning.strip()):
                copied = copied[len(reasoning.strip()):].lstrip()
            chunk, echo = copied, None
            if not chunk:
                continue
        prose_started = True
        yield chunk
    if in_think:
        yield "\n</think>\n"


def needs_prose(text: str) -> bool:
    """True when a generation produced reasoning but no reply after it."""
    return "</think>" in text and not strip_think(text)


async def prose_after_reasoning(llm: "LLMService", messages: list, plan: str, instruction: str, **gen_kwargs):
    """Follow-up call for a generation that stopped after its reasoning: hand
    the plan back and ask for just the reply. Reasoning stays on (so plain GLM
    doesn't write steps as text again) but is discarded. Yields reply text."""
    follow_up = messages + [
        {"role": "assistant", "content": plan.strip()},
        {"role": "user", "content": instruction},
    ]
    started = False
    async for chunk in llm.generate(follow_up, stream=True, request_reasoning=True, **gen_kwargs):
        if not started:
            chunk = chunk.lstrip()
            if not chunk:
                continue
            started = True
        yield chunk


_THINK_BLOCK_RE = re.compile(r'<think>[\s\S]*?</think>\s*', re.IGNORECASE)


def strip_think(text: str) -> str:
    """Remove <think>…</think> blocks. Anything fed back to a model — history,
    summaries, memory extraction — must not include them: the Draft step plans
    things the reply may not actually do, and would be recorded as fact."""
    return _THINK_BLOCK_RE.sub('', text or '').strip()


class LLMService:
    def __init__(self, settings: Settings):
        self.api_base_url = settings.api_base_url.rstrip("/")
        self.api_key = settings.api_key
        self.model = settings.model
        self.max_tokens = settings.max_tokens
        self.temperature = settings.temperature
        self.top_p = getattr(settings, "top_p", None)
        self.finish_reason: Optional[str] = None
        self.last_usage: Optional[dict] = None
        self.client = httpx.AsyncClient(
            timeout=httpx.Timeout(
                connect=30.0,   # fail fast if the API is unreachable
                read=None,      # no read timeout — LLM streams can take minutes (esp. with thinking)
                write=30.0,     # reasonable limit for sending the request body
                pool=10.0       # max wait for a connection from the pool
            )
        )


    async def generate(self, messages: list, stream: bool = False, max_tokens: int = None, temperature: float = None, repetition_penalty: float = None, top_p: float = None, request_reasoning: bool = False, yield_reasoning: bool = False) -> AsyncGenerator[str, None]:
        """request_reasoning: ask the provider to switch on the model's native
        reasoning (only sent to REASONING_FLAG_HOSTS).
        yield_reasoning: stream that reasoning back as ReasoningChunk items
        instead of discarding it (streaming only)."""
        url = f"{self.api_base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": max_tokens if max_tokens is not None else self.max_tokens,
            "temperature": temperature if temperature is not None else self.temperature,
            "stream": stream,
        }
        # Nucleus sampling. Without it the provider default of 1.0 applies, which
        # leaves the whole vocabulary tail reachable — at a high temperature a
        # single junk token derails the rest of the generation irrecoverably.
        # Long outputs (story chunks) are the most exposed: every extra token is
        # another chance to trip it.
        effective_top_p = top_p if top_p is not None else self.top_p
        if effective_top_p is not None and 0 < effective_top_p < 1.0:
            payload["top_p"] = effective_top_p
        if repetition_penalty is not None and repetition_penalty != 1.0:
            payload["repetition_penalty"] = repetition_penalty
        if request_reasoning and supports_reasoning_flag(self.api_base_url):
            payload["reasoning"] = {"enabled": True}
        if stream:
            # NOTE: Do NOT add stream_options here. It is an OpenAI-specific
            # extension that many compatible APIs (Nano-GPT, GLM, etc.) do not
            # support — sending it can cause them to emit garbage tokens or
            # error mid-stream. Usage is read opportunistically below.
            self.finish_reason = None
            self.last_usage = None
            async with self.client.stream("POST", url, headers=headers, json=payload) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        data = line[6:]
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                            if "error" in chunk:
                                err_msg = chunk["error"].get("message", str(chunk["error"])) if isinstance(chunk["error"], dict) else str(chunk["error"])
                                raise Exception(f"API Error: {err_msg}")
                            
                            if "usage" in chunk and chunk["usage"]:
                                self.last_usage = chunk["usage"]
                            
                            if "choices" in chunk and len(chunk["choices"]) > 0:
                                choice = chunk["choices"][0]
                                fr = choice.get("finish_reason")
                                if fr:
                                    self.finish_reason = fr
                                delta = choice.get("delta", {})
                                if yield_reasoning:
                                    reasoning = delta.get("reasoning") or delta.get("reasoning_content")
                                    if reasoning:
                                        yield ReasoningChunk(reasoning)
                                content = delta.get("content", "")
                                if content:
                                    yield content
                        except json.JSONDecodeError:
                            continue
        else:
            response = await self.client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()
            if "usage" in data:
                self.last_usage = data["usage"]
            content = data["choices"][0]["message"]["content"]
            yield content

    async def summarize(self, text: str) -> str:
        messages = [
            {"role": "system", "content": "You are a helpful assistant that summarizes story segments concisely while preserving key plot points, character actions, and narrative tone."},
            {"role": "user", "content": f"Summarize the following story segment in a few sentences:\n\n{text}"}
        ]
        result = ""
        async for chunk in self.generate(messages, stream=False, temperature=UTILITY_TEMPERATURE):
            result += chunk
        return result.strip()

    async def close(self):
        await self.client.aclose()
