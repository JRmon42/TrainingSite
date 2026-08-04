#!/usr/bin/env bash
# Stop the Certification Trainer server.
set -euo pipefail
cd "$(dirname "$0")"

PIDFILE="server.pid"
if [[ ! -f "$PIDFILE" ]]; then
  echo "No server.pid found — nothing to stop."
  exit 0
fi

PID="$(cat "$PIDFILE" 2>/dev/null || true)"
if [[ -z "$PID" ]] || ! kill -0 "$PID" 2>/dev/null; then
  echo "Process not running. Cleaning up pid file."
  rm -f "$PIDFILE"
  exit 0
fi

echo "Stopping server (PID $PID)…"
kill "$PID" 2>/dev/null || true
for _ in $(seq 1 10); do
  if ! kill -0 "$PID" 2>/dev/null; then
    rm -f "$PIDFILE"
    echo "✓ Stopped."
    exit 0
  fi
  sleep 0.5
done

echo "Forcing stop…"
kill -9 "$PID" 2>/dev/null || true
rm -f "$PIDFILE"
echo "✓ Stopped (forced)."
