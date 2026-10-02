#!/usr/bin/env bash
# Serves site/ locally for a quick look at http://localhost:4173.
# This is a plain static server: it does not resolve anything from Walrus.
# To test the real Walrus resolution, deploy and use a portal (see
# docs/WALRUS_SITES.md).
set -euo pipefail

cd "$(dirname "$0")/.."
PORT="${PORT:-4173}"

if command -v npx >/dev/null 2>&1; then
  exec npx --yes serve site -l "$PORT"
elif command -v python3 >/dev/null 2>&1; then
  echo "Serving on http://localhost:$PORT"
  exec python3 -m http.server "$PORT" --directory site
elif command -v python >/dev/null 2>&1; then
  echo "Serving on http://localhost:$PORT"
  exec python -m http.server "$PORT" --directory site
else
  echo "error: install Node.js or Python to preview the site" >&2
  exit 1
fi
