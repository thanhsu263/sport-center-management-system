#!/bin/sh
set -eu
cd /workspace
if [ -f /workspace/.secrets/gemini ]; then
  GEMINI_API_KEY="$(tr -d '\n\r' < /workspace/.secrets/gemini)"
  export GEMINI_API_KEY
fi
node scripts/preview.mjs stop || true
if curl -sf -o /dev/null --max-time 2 http://127.0.0.1:8080/; then
  exit 0
fi
npm run dev >>/tmp/app-startup.log 2>&1 &
