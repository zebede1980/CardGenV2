# AkinVox Faster Kokoro behind an OpenAI-compatible speech API (CPU).
# Kokoro-82M's text front-end and voices, with its waveform decoder replaced by
# a small mel head + Vocos: https://github.com/akinvox/faster-kokoro
FROM python:3.12-slim

ENV PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1 \
    HF_HOME=/models \
    HF_HUB_DISABLE_TELEMETRY=1

# espeak-ng: misaki's fallback for English words not in its dictionary, and
# the phonemiser for Spanish, French, Hindi, Italian and Portuguese voices.
RUN apt-get update \
 && apt-get install -y --no-install-recommends espeak-ng git curl \
 && rm -rf /var/lib/apt/lists/*

# CPU-only torch. Vocos needs torchaudio, and a plain pip install of it pulls
# a CUDA torch (+6 GB of NVIDIA libraries), so both come from the CPU index
# and a constraints file holds them there for everything installed after.
RUN pip install torch torchaudio --index-url https://download.pytorch.org/whl/cpu \
 && pip freeze | grep -E '^(torch|torchaudio)==' > /constraints.txt \
 && cat /constraints.txt

# Pinned to the commit that was reviewed and benchmarked.
ARG FASTER_KOKORO_REF=e633db6
RUN pip install -c /constraints.txt "git+https://github.com/akinvox/faster-kokoro.git@${FASTER_KOKORO_REF}" \
        fastapi==0.121.2 "uvicorn[standard]==0.38.0" \
 && python -m spacy download en_core_web_sm

# Bake every weight and voice into the image so the container starts offline.
RUN python - <<'EOF'
from huggingface_hub import snapshot_download
from faster_kokoro import FasterKokoro
from faster_kokoro.constants import KOKORO_REPO, KOKORO_REVISION
FasterKokoro(device="cpu")
snapshot_download(KOKORO_REPO, revision=KOKORO_REVISION, allow_patterns=["voices/*.pt"])
EOF
ENV HF_HUB_OFFLINE=1

WORKDIR /app
COPY server.py .
EXPOSE 8880
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s CMD curl -fs http://localhost:8880/health || exit 1
CMD ["uvicorn", "server:app", "--host", "0.0.0.0", "--port", "8880", "--workers", "1"]
