"""OpenAI-compatible speech server around AkinVox Faster Kokoro.

Speaks the same two routes CardGen's proxy uses on Kokoro-FastAPI, so it can
stand in for it:

  POST /v1/audio/speech   {input, voice, speed, response_format: "wav" | "pcm"}
  GET  /v1/audio/voices   {"voices": [...]}

Voices can be blended the Kokoro-FastAPI way: "af_bella+af_sky" (equal parts)
or "af_bella(2)+af_sky(1)" (weighted).

Requests are synthesised one at a time: on a CPU two at once are each slower
than one alone. The text is spoken a sentence-sized piece at a time, and if the
caller hangs up between pieces the rest is dropped, so an abandoned request
frees the engine within one piece instead of finishing in the background.
"""
import asyncio
import io
import logging
import os
import re
import time
import wave
from pathlib import Path

import numpy as np
import torch
from fastapi import FastAPI, Request
from fastapi.responses import JSONResponse, Response

from faster_kokoro import FasterKokoro
from faster_kokoro.constants import KOKORO_REPO, KOKORO_REVISION, SAMPLE_RATE

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
log = logging.getLogger("faster-kokoro")

torch.set_num_threads(int(os.environ.get("TORCH_THREADS", os.cpu_count() or 4)))

MAX_INPUT_CHARS = int(os.environ.get("MAX_INPUT_CHARS", "5000"))
# Languages whose phonemiser is installed in the image. Japanese and Mandarin
# need extra misaki packages and dictionaries, so they are left out; a request
# for one gets a 400 and CardGen falls back to the stock Kokoro server.
SUPPORTED_LANGS = set(os.environ.get("SUPPORTED_LANGS", "a,b,e,f,h,i,p").split(","))

tts = FasterKokoro(device="cpu")
engine_lock = asyncio.Lock()


def _voice_files() -> dict[str, str]:
    """Voice name -> .pt file, from the pinned Kokoro revision baked into the image.

    KPipeline would fetch voices from the repo's main branch by name, so
    voices are always handed to it as file paths.
    """
    from huggingface_hub import snapshot_download

    root = Path(snapshot_download(KOKORO_REPO, revision=KOKORO_REVISION, allow_patterns=["voices/*.pt"]))
    return {p.stem: str(p) for p in sorted((root / "voices").glob("*.pt")) if p.stem[0] in SUPPORTED_LANGS}


VOICE_FILES = _voice_files()
VOICES = list(VOICE_FILES)
VOICE_SET = set(VOICES)
BLEND_PART = re.compile(r"^\s*([a-z]{2}_[a-z0-9_]+)\s*(?:\(\s*([0-9]*\.?[0-9]+)\s*\))?\s*$")


class BadRequest(Exception):
    pass


def _parse_voice(spec: str) -> list[tuple[str, float]]:
    parts = []
    for raw in re.split(r"[+,]", spec or ""):
        if not raw.strip():
            continue
        m = BLEND_PART.match(raw)
        if not m or m.group(1) not in VOICE_SET:
            raise BadRequest(f"Voice '{raw.strip()}' not found. Available voices: {', '.join(VOICES)}")
        weight = float(m.group(2)) if m.group(2) else 1.0
        if weight <= 0:
            raise BadRequest(f"Voice weight must be above zero in '{raw.strip()}'")
        parts.append((m.group(1), weight))
    if not parts:
        raise BadRequest("No voice given")
    return parts


_pack_cache: dict[str, torch.Tensor] = {}


def _voice_pack(spec: str, parts: list[tuple[str, float]]):
    lang = parts[0][0][0]
    pipeline = tts._pipeline(lang)
    if spec not in _pack_cache:
        total = sum(w for _, w in parts)
        pack = sum(pipeline.load_single_voice(VOICE_FILES[name]) * (w / total) for name, w in parts)
        if len(_pack_cache) > 64:
            _pack_cache.clear()
        _pack_cache[spec] = pack.to(tts.device)
    return pipeline, _pack_cache[spec]


def _pieces(pipeline, text: str) -> list[str]:
    return [r.phonemes for r in pipeline(text) if r.phonemes]


def _wav_bytes(audio: np.ndarray) -> bytes:
    pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(SAMPLE_RATE)
        w.writeframes(pcm)
    return buf.getvalue()


app = FastAPI(title="Faster Kokoro TTS API", version="1.0.0")


def _error(status: int, message: str, kind: str = "validation_error"):
    return JSONResponse(status_code=status, content={"detail": {"error": kind, "message": message}})


@app.get("/health")
def health():
    return {"status": "healthy", "engine": "faster-kokoro", "voices": len(VOICES)}


@app.get("/v1/audio/voices")
def voices():
    return {"voices": VOICES}


@app.get("/v1/models")
def models():
    return {"object": "list", "data": [{"id": "kokoro", "object": "model", "owned_by": "akinvox-faster-kokoro"}]}


@app.post("/v1/audio/speech")
async def speech(request: Request):
    try:
        body = await request.json()
    except Exception:
        return _error(400, "Body must be JSON")
    text = str(body.get("input") or "").strip()
    voice = str(body.get("voice") or "af_heart")
    fmt = str(body.get("response_format") or "wav").lower()
    try:
        speed = float(body.get("speed") or 1.0)
    except (TypeError, ValueError):
        return _error(400, "speed must be a number")
    if not text:
        return _error(400, "input is empty")
    if len(text) > MAX_INPUT_CHARS:
        return _error(400, f"input is longer than {MAX_INPUT_CHARS} characters")
    if fmt not in ("wav", "pcm"):
        return _error(400, f"response_format '{fmt}' is not supported here (wav or pcm)")
    if not 0.25 <= speed <= 4.0:
        return _error(400, "speed must be between 0.25 and 4.0")
    try:
        parts = _parse_voice(voice)
    except BadRequest as e:
        return _error(400, str(e))

    started = time.monotonic()
    async with engine_lock:
        waited = time.monotonic() - started
        if await request.is_disconnected():
            return Response(status_code=499)
        pipeline, pack = await asyncio.to_thread(_voice_pack, voice, parts)
        phonemes = await asyncio.to_thread(_pieces, pipeline, text)
        chunks = []
        for ph in phonemes:
            if await request.is_disconnected():
                log.info("caller left after %d/%d pieces, stopping", len(chunks), len(phonemes))
                return Response(status_code=499)
            chunks.append(await asyncio.to_thread(tts._waveform, ph, pack, speed))
    audio = torch.cat(chunks).numpy() if chunks else np.zeros(int(SAMPLE_RATE * 0.1), dtype=np.float32)
    took = time.monotonic() - started - waited
    seconds = len(audio) / SAMPLE_RATE
    log.info("%d chars, voice %s: %.2fs audio in %.2fs (waited %.2fs)", len(text), voice, seconds, took, waited)
    headers = {"X-TTS-Duration-Seconds": f"{seconds:.3f}", "Cache-Control": "no-cache"}
    if fmt == "pcm":
        pcm = (np.clip(audio, -1.0, 1.0) * 32767).astype("<i2").tobytes()
        return Response(pcm, media_type="audio/pcm", headers=headers)
    return Response(_wav_bytes(audio), media_type="audio/wav", headers=headers)


@app.on_event("startup")
async def warm():
    # Load the English pipelines and run the model once so the first real
    # request doesn't pay for it.
    for v in ("af_heart", "bf_emma"):
        pipeline, pack = _voice_pack(v, [(v, 1.0)])
        for ph in _pieces(pipeline, "Hello there."):
            tts._waveform(ph, pack, 1.0)
    log.info("ready: %d voices", len(VOICES))
