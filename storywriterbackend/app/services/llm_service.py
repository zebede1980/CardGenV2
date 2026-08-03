import httpx
import json
from typing import AsyncGenerator, Optional
from app.models import Settings

class LLMService:
    def __init__(self, settings: Settings):
        self.api_base_url = settings.api_base_url.rstrip("/")
        self.api_key = settings.api_key
        self.model = settings.model
        self.max_tokens = settings.max_tokens
        self.temperature = settings.temperature
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


    async def generate(self, messages: list, stream: bool = False, max_tokens: int = None, temperature: float = None, repetition_penalty: float = None) -> AsyncGenerator[str, None]:
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
        if repetition_penalty is not None and repetition_penalty != 1.0:
            payload["repetition_penalty"] = repetition_penalty
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
        async for chunk in self.generate(messages, stream=False):
            result += chunk
        return result.strip()

    async def close(self):
        await self.client.aclose()
