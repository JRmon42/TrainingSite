#!/usr/bin/env bash
# Seed the persistent data volume on first boot, then exec the server.
#
# /app/data may be an Azure Files mount that starts out empty. The image bakes
# the initial exams/history/images into /app/seed-data. On startup we copy any
# missing top-level data directories across so a fresh deployment is usable
# immediately, without ever clobbering data the user has already created.
set -euo pipefail

SEED_DIR="/app/seed-data"
DATA_DIR="${DATA_DIR:-/app/data}"

mkdir -p "$DATA_DIR"

if [[ -d "$SEED_DIR" ]]; then
  for sub in exams history images uploads; do
    mkdir -p "$DATA_DIR/$sub"
    if [[ -d "$SEED_DIR/$sub" ]] && [[ -z "$(ls -A "$DATA_DIR/$sub" 2>/dev/null)" ]]; then
      cp -a "$SEED_DIR/$sub/." "$DATA_DIR/$sub/" 2>/dev/null || true
      echo "[entrypoint] seeded $sub"
    fi
  done
fi

exec "$@"
