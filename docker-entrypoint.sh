#!/usr/bin/env bash
# Seed the persistent data volume, then exec the server.
#
# /app/data (or DATA_DIR, e.g. /home/data on App Service) may start empty or may
# already hold data from a previous deployment. The image bakes the initial
# exams/history/images/pdfs into /app/seed-data. On startup we copy across any
# seed file that is *missing* in the data volume (add-only): a fresh deployment
# is usable immediately, newly shipped seed exams (e.g. dp-800) appear after a
# redeploy, and data the user already created is never overwritten.
set -euo pipefail

SEED_DIR="/app/seed-data"
DATA_DIR="${DATA_DIR:-/app/data}"

mkdir -p "$DATA_DIR"

if [[ -d "$SEED_DIR" ]]; then
  for sub in exams history images uploads pdfs; do
    mkdir -p "$DATA_DIR/$sub"
    [[ -d "$SEED_DIR/$sub" ]] || continue
    added=0
    while IFS= read -r -d '' f; do
      rel="${f#"$SEED_DIR/$sub/"}"
      dest="$DATA_DIR/$sub/$rel"
      if [[ ! -e "$dest" ]]; then
        mkdir -p "$(dirname "$dest")"
        cp -a "$f" "$dest" 2>/dev/null && added=$((added+1)) || true
      fi
    done < <(find "$SEED_DIR/$sub" -type f -print0)
    [[ "$added" -gt 0 ]] && echo "[entrypoint] seeded $added new file(s) into $sub"
  done
fi

exec "$@"
