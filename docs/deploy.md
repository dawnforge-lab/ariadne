# Deploying Ariadne

One image, three commands. `docker-entrypoint.sh` (installed as `ariadne`) picks the role:

| Command | Runs | Port |
|---|---|---|
| `api` (default) | `node --import tsx src/api/serve.ts` | `ARIADNE_API_PORT` (8787) |
| `worker` | `node --import tsx src/worker/serve.ts` | `ARIADNE_WORKER_HTTP_PORT` (required) |
| `migrate` | `node --import tsx src/db/migrate.ts` (one-shot) | none |

Any other command exits 64. There is no build step: the image runs the TypeScript with tsx.

## The image

- `node:22-bookworm-slim`, runs as the non-root user `ariadne` (uid 10001).
- Production dependencies only (`npm ci --omit=dev`) plus `tsx` at the version the lockfile pins. tsx is a devDependency but with no build step it is the runtime, so it is installed and copied in; vitest, cheerio, drizzle-kit and typescript are not in the image.
- Chromium at the locked Playwright version, with its system libraries and `fonts-liberation` (`npx playwright install --with-deps chromium`), under `/ms-playwright`.
- `HEALTHCHECK` curls `/healthz` on the worker port if `ARIADNE_WORKER_HTTP_PORT` is set, else the API port.
- Build: `docker build --build-arg ARIADNE_GIT_SHA=$(git rev-parse HEAD) -t ariadne .` (size about 1.3 GB, mostly Chromium).

## Environment

Common: `DATABASE_URL` (Postgres 16+), `ARIADNE_CREDENTIALS_KEY` (`<id>:<base64 of 32 bytes>`), `ARIADNE_ALLOWED_DOMAINS` (comma-separated; empty refuses every crawl), optional `ARIADNE_CREDENTIALS_KEY_PREVIOUS`, `ARIADNE_CREDENTIALS_RETENTION_DAYS`, `ARIADNE_METRICS_TOKEN` (must differ from the API token; unset means `/metrics` is 404).

API: `ARIADNE_API_TOKEN` (at least 16 characters), `ARIADNE_API_HOST=0.0.0.0` (the default 127.0.0.1 is unreachable from outside a container), `ARIADNE_API_PORT`, `ARIADNE_EXPORT_DIR`, `ARIADNE_RENDER_DIR`. The API runs no crawls; it accepts and answers, and runs a reaper.

Worker: `ARIADNE_WORKER_HTTP_PORT`, `ARIADNE_WORKER_CONCURRENCY` (default 1), `ARIADNE_TENANT_MAX_RUNNING`. Scale workers by running more containers.

`/healthz`, `/readyz` and `/metrics` are served before auth on the API port and on each worker's port.

## Compose (local and the 28b gate)

```
cp .env.compose.example .env.compose      # then replace every REPLACE-ME; it is git-ignored
docker compose --env-file .env.compose up -d --build
```

Services: `postgres` (16, own volume, **no host port**, reachable as `postgres:5432` inside the network), `migrate` (one-shot; `api` and `worker` wait for it to exit 0), `api` (published on `127.0.0.1:${ARIADNE_API_HOST_PORT:-18787}`), `worker` (2 replicas). Never commit `.env.compose` or any real key or token.

`scripts/compose-smoke.sh` generates throwaway secrets, brings the stack up under the project name `ariadne-smoke`, checks that migrate exits 0, that `/readyz` is 200 on the API and both workers and that two worker instances are live, stops the workers and checks both rows are no longer live with no crawl `running`, then runs `docker compose down -v` (its own containers and volumes only). Note the API registers its `instances` row lazily, on the first render or rules job it runs itself, so an idle API has no row.

## Chromium sandbox

Chromium's sandbox is never disabled: the renderer launches with its defaults and `--no-sandbox` appears nowhere. Verified on Docker 29.9 with the default seccomp profile, no added capabilities, as the non-root `ariadne` user: Chromium launches with its sandbox and renders a real page through the production renderer. No `security_opt` or `cap_add` is therefore set. To re-check on any host:

```
docker run --rm --entrypoint node ariadne:local --import tsx scripts/render-launch-check.ts https://example.com/
```

If a host's runtime forbids unprivileged user namespaces (some hardened kernels, rootless setups, older seccomp profiles), the browser cannot start. The render pass then fails loudly, recording `crawls.render_launch_error`, and the render rules report it. The fix is to permit user namespaces for the container (a seccomp profile that allows `clone`/`unshare` with `CLONE_NEWUSER`, or `security_opt: ["seccomp=<that profile>"]` in compose), because the sandbox needs them to isolate renderer processes. Do not add `--no-sandbox`, and do not run the container as root to get around it.

## CI

The `docker` job in `.github/workflows/ci.yml` builds the image on every PR and pushes nothing.
