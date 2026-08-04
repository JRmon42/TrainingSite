#!/usr/bin/env bash
# Install dependencies for the Certification Trainer.
set -euo pipefail
cd "$(dirname "$0")"

PYTHON="${PYTHON:-python3}"
DO_PYTHON=1

usage() {
  cat <<EOF
Usage: ./install.sh [--no-python] [--help]

  --no-python   Skip the Python/PDF-import dependencies (Node only).
  --help        Show this help.

Env:
  PYTHON=...    Python interpreter to use (default: python3).
EOF
}

for arg in "$@"; do
  case "$arg" in
    --no-python) DO_PYTHON=0 ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown option: $arg" >&2; usage; exit 1 ;;
  esac
done

# ---- Node (required) ----
if ! command -v node >/dev/null 2>&1; then
  echo "ERROR: Node.js is required but not found. Install Node >= 18 from https://nodejs.org" >&2
  exit 1
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
if (( NODE_MAJOR < 18 )); then
  echo "ERROR: Node >= 18 required (found $(node -v))." >&2
  exit 1
fi
if ! command -v npm >/dev/null 2>&1; then
  echo "ERROR: npm is required but not found." >&2
  exit 1
fi

echo "Installing Node dependencies…"
if [[ -f package-lock.json ]]; then
  npm ci || npm install
else
  npm install
fi

# ---- Python (optional, for PDF import) ----
if (( DO_PYTHON )); then
  if command -v "$PYTHON" >/dev/null 2>&1; then
    echo "Installing Python PDF-import dependencies with $PYTHON…"
    PKGS="pdfplumber pymupdf rapidocr-onnxruntime numpy pillow"
    if ! "$PYTHON" -m pip install --user $PKGS 2>/dev/null; then
      echo "  (retrying with --break-system-packages for PEP-668 environments)"
      "$PYTHON" -m pip install --user --break-system-packages $PKGS || \
        echo "  WARNING: Python deps failed to install. PDF import will be unavailable until fixed." >&2
    fi
  else
    echo "WARNING: '$PYTHON' not found — skipping Python deps. PDF import will be unavailable." >&2
  fi
fi

chmod +x start.sh stop.sh install.sh 2>/dev/null || true

cat <<EOF

✓ Install complete.
Next steps:
  ./start.sh          # start the server (default port 3000)
  open http://localhost:3000
  ./stop.sh           # stop the server
EOF
