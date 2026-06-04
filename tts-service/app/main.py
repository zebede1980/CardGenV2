"""
Coqui TTS Bridge Service

A lightweight FastAPI wrapper around the Coqui TTS library.
Provides REST endpoints for text-to-speech synthesis with
support for multiple voices and models.
"""
import io
import logging
import os
import threading
from typing import Optional

from fastapi import FastAPI, HTTPException
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("tts-bridge")

app = FastAPI(title="Coqui TTS Bridge", version="1.0.0")

# ── Global state ────────────────────────────────────────────────────────────────
_tts_instance = None
_model_lock = threading.Lock()
_current_model_name: Optional[str] = None
_model_status: str = "unloaded"  # "unloaded" | "loading" | "ready" | "error"
_model_error: Optional[str] = None

DEFAULT_MODEL = os.environ.get("TTS_MODEL_NAME", "tts_models/en/vctk/vits")
DEVICE = os.environ.get("TTS_DEVICE", "cpu")


class SynthesizeRequest(BaseModel):
    text: str = Field(..., min_length=1, max_length=2000, description="Text to synthesize")
    voice: str = Field(default="p230", description="Speaker ID for multi-speaker models")
    speed: float = Field(default=1.0, ge=0.5, le=3.0, description="Playback speed multiplier")


class ModelInfo(BaseModel):
    name: str
    status: str
    speakers: list[str] = []
    error: Optional[str] = None


# ── Model helpers ────────────────────────────────────────────────────────────────

def _get_model_names() -> list[str]:
    """List available TTS models on disk (cached by Coqui's manager)."""
    try:
        from TTS.api import TTS
        manager = TTS().list_models()
        # manager.list_models() returns a list of model name strings
        if callable(manager):
            return manager()
        return list(manager) if manager else []
    except Exception:
        return []


def _get_tts():
    """Get or create the TTS singleton, loading the model if needed."""
    global _tts_instance, _current_model_name, _model_status, _model_error
    model_name = os.environ.get("TTS_MODEL_NAME", DEFAULT_MODEL)

    if _tts_instance is not None and _current_model_name == model_name:
        return _tts_instance

    with _model_lock:
        # Double-check after acquiring lock
        if _tts_instance is not None and _current_model_name == model_name:
            return _tts_instance

        _model_status = "loading"
        _model_error = None
        logger.info(f"Loading TTS model: {model_name} on device: {DEVICE}")

        try:
            from TTS.api import TTS
            _tts_instance = TTS(model_name=model_name).to(DEVICE)
            _current_model_name = model_name
            _model_status = "ready"
            logger.info(f"TTS model '{model_name}' loaded successfully on {DEVICE}")
            return _tts_instance
        except Exception as e:
            _model_status = "error"
            _model_error = str(e)
            logger.error(f"Failed to load TTS model '{model_name}': {e}")
            raise


def _get_available_speakers() -> list[str]:
    """Get available speaker IDs from the loaded model."""
    try:
        tts = _get_tts()
        if hasattr(tts, 'speakers') and tts.speakers:
            return list(tts.speakers)
        if hasattr(tts, 'synthesizer') and hasattr(tts.synthesizer, 'speakers'):
            return list(tts.synthesizer.speakers)
    except Exception as e:
        logger.warning(f"Could not enumerate speakers: {e}")
    return []


# ── Routes ────────────────────────────────────────────────────────────────────────

@app.get("/health")
async def health():
    """Health check endpoint. Returns model status and GPU availability."""
    gpu_available = False
    try:
        import torch
        gpu_available = torch.cuda.is_available()
    except Exception:
        pass

    return {
        "status": "ok",
        "model_status": _model_status,
        "current_model": _current_model_name,
        "device": DEVICE,
        "gpu_available": gpu_available,
    }


@app.get("/voices")
async def list_voices():
    """List available speakers from the currently loaded model."""
    if _model_status == "loading":
        return {"status": "loading", "speakers": []}
    if _model_status == "error":
        return {"status": "error", "error": _model_error, "speakers": []}
    try:
        speakers = _get_available_speakers()
        return {"status": "ready", "speakers": speakers}
    except Exception as e:
        return {"status": "error", "error": str(e), "speakers": []}


@app.get("/models")
async def list_models():
    """List available TTS model names on disk."""
    try:
        model_names = _get_model_names()
        return {"models": model_names, "current": _current_model_name}
    except Exception as e:
        logger.error(f"Error listing models: {e}")
        return {"models": [], "current": _current_model_name, "error": str(e)}


@app.post("/models/load")
async def load_model(model_name: str = DEFAULT_MODEL):
    """Load a different TTS model at runtime."""
    global _tts_instance, _current_model_name, _model_status, _model_error
    with _model_lock:
        _tts_instance = None
        _current_model_name = None
        _model_status = "unloaded"
        _model_error = None

    os.environ["TTS_MODEL_NAME"] = model_name

    try:
        _get_tts()  # Triggers load
        speakers = _get_available_speakers()
        return {
            "status": "ready",
            "model": model_name,
            "speaker_count": len(speakers),
            "speakers": speakers[:20],  # Limit for response size
        }
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"Failed to load model: {str(e)}")


@app.post("/synthesize")
async def synthesize(req: SynthesizeRequest):
    """
    Synthesize text to speech and return WAV audio.
    Accepts a single sentence for low-latency streaming pipeline.
    """
    if _model_status == "loading":
        raise HTTPException(status_code=503, detail="TTS model is still loading. Please wait.")
    if _model_status == "error":
        raise HTTPException(status_code=500, detail=f"TTS model error: {_model_error}")

    try:
        tts = _get_tts()
    except Exception as e:
        raise HTTPException(status_code=500, detail=f"TTS model not available: {str(e)}")

    text = req.text.strip()
    if not text:
        raise HTTPException(status_code=400, detail="Text must not be empty")

    try:
        wav = tts.tts(
            text=text,
            speaker=req.voice,
            speed=req.speed,
        )
    except Exception as e:
        logger.error(f"Synthesis failed for text '{text[:80]}...': {e}")
        raise HTTPException(status_code=500, detail=f"Synthesis failed: {str(e)}")

    # Convert numpy array to WAV bytes
    import numpy as np

    if isinstance(wav, list):
        wav = np.array(wav, dtype=np.float32)

    # Normalize to [-1, 1] range if needed
    if wav.dtype != np.float32:
        wav = wav.astype(np.float32)
    peak = np.abs(wav).max()
    if peak > 1.0:
        wav = wav / peak

    # Convert float32 [-1,1] to int16 PCM
    wav_int16 = (wav * 32767).astype(np.int16)

    # Write WAV to buffer
    import soundfile as sf
    buf = io.BytesIO()
    sample_rate = getattr(tts, 'synthesizer', None)
    if sample_rate and hasattr(sample_rate, 'output_sample_rate'):
        sr = sample_rate.output_sample_rate
    else:
        sr = 22050  # Default for VITS

    sf.write(buf, wav_int16, sr, format='WAV', subtype='PCM_16')
    buf.seek(0)

    return StreamingResponse(
        buf,
        media_type="audio/wav",
        headers={
            "Content-Disposition": "inline",
            "X-TTS-Duration-Seconds": str(len(wav) / sr) if sr > 0 else "0",
        },
    )


# ── Startup ──────────────────────────────────────────────────────────────────────

@app.on_event("startup")
async def startup_event():
    """Pre-warm the TTS model on startup if configured."""
    preload = os.environ.get("TTS_PRELOAD", "true").lower() == "true"
    if preload:
        logger.info(f"Preloading TTS model on startup: {DEFAULT_MODEL}")
        try:
            _get_tts()
        except Exception as e:
            logger.warning(f"Model preload failed (will retry on first request): {e}")
    else:
        logger.info("TTS_PRELOAD=false — model will load on first request")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8500)
