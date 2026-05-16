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
        self.client = httpx.AsyncClient(timeout=120.0)

    async def generate(self, messages: list, stream: bool = False) -> AsyncGenerator[str, None]:
        url = f"{self.api_base_url}/chat/completions"
        headers = {
            "Authorization": f"Bearer {self.api_key}",
            "Content-Type": "application/json",
        }
        payload = {
            "model": self.model,
            "messages": messages,
            "max_tokens": self.max_tokens,
            "temperature": self.temperature,
            "stream": stream,
        }
        if stream:
            async with self.client.stream("POST", url, headers=headers, json=payload) as response:
                response.raise_for_status()
                async for line in response.aiter_lines():
                    if line.startswith("data: "):
                        data = line[6:]
                        if data == "[DONE]":
                            break
                        try:
                            chunk = json.loads(data)
                            delta = chunk["choices"][0].get("delta", {})
                            content = delta.get("content", "")
                            if content:
                                yield content
                        except Exception:
                            continue
        else:
            response = await self.client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            data = response.json()
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
