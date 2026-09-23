#!/usr/bin/env bash
#
# Idempotent setup for the Python sidecar + bundled assets used by the dashboard.
#   - bin/venv/                              — Python venv with opencv + numpy
#   - bin/models/face_detection_yunet_*.onnx — YuNet face detector model (~340 KB)
#   - config/captions/fonts/Fraunces-144ptBlack.ttf — display serif for caption "large" emphasis
#
# Safe to re-run. Does nothing if already set up.
#
# Usage:
#   bash bin/setup.sh

set -euo pipefail

cd "$(dirname "$0")"
VENV_DIR="venv"
MODELS_DIR="models"
YUNET_FILE="face_detection_yunet_2023mar.onnx"
YUNET_URL="https://github.com/opencv/opencv_zoo/raw/main/models/face_detection_yunet/${YUNET_FILE}"

FONTS_DIR="../config/captions/fonts"
# DM Serif Display — high-contrast display serif used for caption "large" emphasis
# (numbers, names, dates). Closest free analogue to Editorial New.
SERIF_FILE="DMSerifDisplay-Regular.ttf"
SERIF_URL="https://github.com/google/fonts/raw/main/ofl/dmserifdisplay/DMSerifDisplay-Regular.ttf"

if [ ! -d "$VENV_DIR" ]; then
  echo "→ creating venv at bin/$VENV_DIR/..."
  python3 -m venv "$VENV_DIR"
fi

echo "→ installing Python dependencies (opencv-python, numpy)..."
"$VENV_DIR/bin/pip" install --upgrade pip --quiet
"$VENV_DIR/bin/pip" install -r requirements.txt --quiet

echo "→ verifying import..."
"$VENV_DIR/bin/python" -c "import cv2, numpy; print('  opencv', cv2.__version__); print('  numpy', numpy.__version__)"

mkdir -p "$MODELS_DIR"
if [ ! -f "$MODELS_DIR/$YUNET_FILE" ]; then
  echo "→ downloading YuNet face detector model..."
  curl -fsSL -o "$MODELS_DIR/$YUNET_FILE" "$YUNET_URL"
  echo "  saved bin/$MODELS_DIR/$YUNET_FILE"
else
  echo "→ YuNet model already present (bin/$MODELS_DIR/$YUNET_FILE)"
fi

mkdir -p "$FONTS_DIR"
if [ ! -f "$FONTS_DIR/$SERIF_FILE" ]; then
  echo "→ downloading DM Serif Display (used for caption 'large' impact words)..."
  curl -fsSL -o "$FONTS_DIR/$SERIF_FILE" "$SERIF_URL"
  echo "  saved config/captions/fonts/$SERIF_FILE"
else
  echo "→ DM Serif Display font already present"
fi

echo ""
echo "✓ Setup complete."
echo "  • Smart vertical crop enabled (YuNet)."
echo "  • Serif 'large' caption emphasis enabled (DM Serif Display)."
echo "  • Test detector: bin/venv/bin/python bin/detect-subject.py --help"
