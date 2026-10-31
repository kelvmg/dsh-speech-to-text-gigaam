#!/usr/bin/env bash
# Prepare the Python side of the GigaAM provider.
#
#   ./setup.sh [model]
#
# Environment overrides:
#   GIGAAM_DATA_ROOT  where venv/ and models/ are created
#                     (default: ~/.dsh/speech-to-text/gigaam)
#   PYTHON            interpreter used to create the venv (default: python3)
#
# Creates a virtual environment, installs PyTorch, the GigaAM package and its
# runtime dependencies, then downloads and loads the selected model so the
# first voice message does not pay for it.
set -euo pipefail

DATA_ROOT="${GIGAAM_DATA_ROOT:-$HOME/.dsh/speech-to-text/gigaam}"
MODEL="${1:-${GIGAAM_MODEL:-v3_e2e_rnnt}}"
VENV="$DATA_ROOT/venv"
MODELS="$DATA_ROOT/models"
PYTHON="${PYTHON:-python3}"
HERE="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$DATA_ROOT" "$MODELS"

if [ ! -x "$VENV/bin/python" ]; then
  echo ">> creating venv at $VENV"
  "$PYTHON" -m venv "$VENV"
fi

echo ">> installing torch/torchaudio (large download on first run)"
"$VENV/bin/pip" install --no-cache-dir --upgrade pip >/dev/null
"$VENV/bin/pip" install --no-cache-dir torch torchaudio

echo ">> installing gigaam"
"$VENV/bin/pip" install --no-cache-dir --no-deps "git+https://github.com/salute-developers/GigaAM.git"
"$VENV/bin/pip" install --no-cache-dir hydra-core omegaconf sentencepiece soundfile tqdm "numpy<3"

echo ">> downloading and warming up $MODEL"
"$VENV/bin/python" "$HERE/gigaam_stt.py" --warmup --model "$MODEL" --download-root "$MODELS"

echo ">> ready: $DATA_ROOT"
