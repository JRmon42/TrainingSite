#!/usr/bin/env bash
# Start the Certification Trainer server.
set -euo pipefail
cd "$(dirname "$0")"

PORT="${PORT:-3000}"
PIDFILE="server.pid"
LOGFILE="server.log"

if [[ -f "$PIDFILE" ]]; then
  OLDPID="$(cat "$PIDFILE" 2>/dev/null || true)"
  if [[ -n "${OLDPID}" ]] && kill -0 "$OLDPID" 2>/dev/null; then
    echo "Server already running (PID $OLDPID). Use ./stop.sh first." >&2
    exit 1
  fi
  rm -f "$PIDFILE"
fi

if [[ ! -d node_modules ]]; then
  echo "Installing Node dependencies (first run)…"
  npm install
fi

echo "Starting server on port $PORT…"
PORT="$PORT" nohup node server.js > "$LOGFILE" 2>&1 &
NEWPID=$!
echo "$NEWPID" > "$PIDFILE"

# wait for it to come up
for _ in $(seq 1 20); do
  if kill -0 "$NEWPID" 2>/dev/null && grep -q "running at" "$LOGFILE" 2>/dev/null; then
    echo "✓ Certification Trainer is up (PID $NEWPID)."
    echo "  Open http://localhost:$PORT"
    exit 0
  fi
  sleep 0.5
done

if kill -0 "$NEWPID" 2>/dev/null; then
  echo "Server started (PID $NEWPID) — see $LOGFILE. Open http://localhost:$PORT"
else
  echo "Server failed to start. Last log lines:" >&2
  tail -n 20 "$LOGFILE" >&2 || true
  rm -f "$PIDFILE"
  exit 1
fi
