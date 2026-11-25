#!/bin/sh
# The command picks the role. Unknown commands fail loudly.
# ARIADNE_HEAP_MB is the V8 old-space cap (MB) node is started with; the process
# verifies it at boot (src/runtime/heap-cap.ts). Validated first, so a bad value
# never reaches node.
set -eu
case "${ARIADNE_HEAP_MB:-}" in
  ''|*[!0-9]*|0*)
    echo "ariadne: ARIADNE_HEAP_MB must be a positive whole number (MB), got '${ARIADNE_HEAP_MB:-}'" >&2
    exit 64 ;;
esac
case "${1:-}" in
  api)     exec node --max-old-space-size="$ARIADNE_HEAP_MB" --import tsx src/api/serve.ts ;;
  worker)  exec node --max-old-space-size="$ARIADNE_HEAP_MB" --import tsx src/worker/serve.ts ;;
  migrate) exec node --max-old-space-size="$ARIADNE_HEAP_MB" --import tsx src/db/migrate.ts ;;
  *) echo "ariadne: unknown command '${1:-}' (expected api, worker or migrate)" >&2; exit 64 ;;
esac
