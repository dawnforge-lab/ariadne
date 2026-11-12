#!/bin/sh
# The command picks the role. Unknown commands fail loudly.
set -eu
case "${1:-}" in
  api)     exec node --import tsx src/api/serve.ts ;;
  worker)  exec node --import tsx src/worker/serve.ts ;;
  migrate) exec node --import tsx src/db/migrate.ts ;;
  *) echo "ariadne: unknown command '${1:-}' (expected api, worker or migrate)" >&2; exit 64 ;;
esac
