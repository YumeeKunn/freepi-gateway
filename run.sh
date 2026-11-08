#!/usr/bin/env bash
# Start the free-pi gateway.
#
#   ./run.sh                    # 127.0.0.1:8788
#   ./run.sh -p 8099            # 127.0.0.1:8099
#   ./run.sh --port 8099 --host 0.0.0.0
#   ./run.sh --key secret       # require this API key
#
# Any GATEWAY_* environment variable still works as before; flags win over it.
set -euo pipefail
cd "$(dirname "$0")"

usage() {
  cat <<'EOF'
Usage: ./run.sh [options]

  -p, --port <n>   listen port            (default 8788, or $GATEWAY_PORT)
      --host <ip>  bind address           (default 127.0.0.1, or $GATEWAY_HOST)
  -k, --key <s>    require this API key   (default none, or $GATEWAY_API_KEY)
  -h, --help       show this help

Examples:
  ./run.sh -p 8099
  ./run.sh --port=8099
  GATEWAY_PORT=8099 ./run.sh
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    -p|--port)
      [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }
      GATEWAY_PORT="$2"; shift 2 ;;
    --port=*) GATEWAY_PORT="${1#*=}"; shift ;;
    --host)
      [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }
      GATEWAY_HOST="$2"; shift 2 ;;
    --host=*) GATEWAY_HOST="${1#*=}"; shift ;;
    -k|--key)
      [ $# -ge 2 ] || { echo "error: $1 needs a value" >&2; exit 2; }
      GATEWAY_API_KEY="$2"; shift 2 ;;
    --key=*) GATEWAY_API_KEY="${1#*=}"; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "error: unknown option: $1" >&2; usage >&2; exit 2 ;;
  esac
done

case "${GATEWAY_PORT:-8788}" in
  ''|*[!0-9]*) echo "error: port must be a number" >&2; exit 2 ;;
esac
if [ "${GATEWAY_PORT:-8788}" -lt 1 ] || [ "${GATEWAY_PORT:-8788}" -gt 65535 ]; then
  echo "error: port must be 1-65535" >&2
  exit 2
fi

GATEWAY_PORT="${GATEWAY_PORT:-8788}"
export GATEWAY_PORT
[ -n "${GATEWAY_HOST:-}" ] && export GATEWAY_HOST
[ -n "${GATEWAY_API_KEY:-}" ] && export GATEWAY_API_KEY

exec node src/server.js
