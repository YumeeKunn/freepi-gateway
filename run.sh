#!/usr/bin/env bash
# Start the free-pi gateway on http://127.0.0.1:8788
set -euo pipefail
cd "$(dirname "$0")"
exec node src/server.js "$@"
