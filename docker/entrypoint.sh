#!/bin/sh
set -eu

# Every node in the Docker Compose demo starts from the same checked-in genesis line
# (fixtures/docker-genesis.jsonl) rather than each generating its own — three
# independently-generated genesis lines would each get a different chain ID and never
# converge. Real deployments distribute genesis out-of-band for the same reason (see
# spec/schema.md); this is that out-of-band step, just automated for the demo.
LOG_PATH="${DOGFOODCHAIN_LOG:-/data/log.jsonl}"
if [ ! -f "$LOG_PATH" ]; then
  mkdir -p "$(dirname "$LOG_PATH")"
  cp /app/fixtures/docker-genesis.jsonl "$LOG_PATH"
fi

# Listen on all interfaces inside the container; docker-compose.yml publishes the
# port on the host's loopback only. The API token is read from DOGFOODCHAIN_API_TOKEN.
set -- node dist/cli.js serve --port "$DOGFOODCHAIN_PORT" --log "$LOG_PATH" --peers "$DOGFOODCHAIN_PEERS" \
  --host 0.0.0.0 --cors-origin "${DOGFOODCHAIN_CORS_ORIGINS:-http://localhost:5173}"
if [ -n "${DOGFOODCHAIN_IDENTITY:-}" ]; then
  set -- "$@" --identity "$DOGFOODCHAIN_IDENTITY"
fi

exec "$@"
