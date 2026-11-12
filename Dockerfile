# One image, three commands: `api`, `worker`, `migrate` (docker-entrypoint.sh).
# There is no build step; the image runs the TypeScript with tsx.
FROM node:22-bookworm-slim

ENV NODE_ENV=production \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright \
    npm_config_update_notifier=false

WORKDIR /app

# curl: the HEALTHCHECK and the smoke script's probes.
RUN apt-get update && apt-get install -y --no-install-recommends curl ca-certificates \
    && rm -rf /var/lib/apt/lists/*

COPY package.json package-lock.json ./
# Production dependencies only, exactly as package-lock.json pins them. tsx is a
# runtime dependency: with no build step it is the loader every role runs under.
# vitest, cheerio, drizzle-kit and typescript stay out.
RUN npm ci --omit=dev \
    && node --import tsx -e "console.log('tsx ok')"

# Chromium at the locked Playwright version, plus the system libraries and
# fonts-liberation (--with-deps, needs root, so it runs before USER). The
# browsers live outside /app so a bind-mounted /app cannot hide them.
RUN npx playwright install --with-deps chromium \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rX /ms-playwright

COPY tsconfig.json drizzle.config.ts ./
COPY drizzle ./drizzle
COPY src ./src
# Only the launch check docs/deploy.md runs in the image; the gate and trusted
# (allowPrivate) scripts stay out.
COPY scripts/render-launch-check.ts ./scripts/render-launch-check.ts
COPY docker-entrypoint.sh /usr/local/bin/ariadne
RUN chmod +x /usr/local/bin/ariadne

# Non-root. The crawl writes exports/ and renders/ under /app.
RUN useradd --create-home --uid 10001 ariadne \
    && mkdir -p /app/exports /app/renders \
    && chown -R ariadne:ariadne /app/exports /app/renders
USER ariadne

ARG ARIADNE_GIT_SHA=unknown
ENV ARIADNE_GIT_SHA=${ARIADNE_GIT_SHA}

# The API listens on ARIADNE_API_PORT (8787), a worker on ARIADNE_WORKER_HTTP_PORT.
# One check for both: whichever is set, otherwise the API default.
HEALTHCHECK --interval=15s --timeout=5s --start-period=20s --retries=3 \
    CMD curl -fsS "http://127.0.0.1:${ARIADNE_WORKER_HTTP_PORT:-${ARIADNE_API_PORT:-8787}}/healthz" || exit 1

ENTRYPOINT ["ariadne"]
CMD ["api"]
