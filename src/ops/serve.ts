/**
 * The pre-auth operational endpoints as one request handler, shared by the API
 * (src/api/http.ts, before its bearer and tenant checks) and the worker
 * (src/worker/main.ts, which serves nothing else).
 *
 *  - `GET /healthz`, `GET /readyz`: no credentials.
 *  - `GET /metrics`: its own bearer, `ARIADNE_METRICS_TOKEN`, which is not the
 *    API token (the API token does not open it, the metrics token opens
 *    nothing else). With no token configured the route is a 404 and is never
 *    served open.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { checkBearer } from "../api/auth.js";
import type { Db } from "../db/client.js";
import { healthz, readyz } from "./health.js";
import { METRICS_CONTENT_TYPE, renderMetrics } from "./metrics.js";

export interface OpsOptions {
  db: Pick<Db, "execute">;
  /** `ARIADNE_METRICS_TOKEN`; null or absent: `/metrics` is a 404. */
  metricsToken: string | null | undefined;
  log: (line: string) => void;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

/** The path of a request target, or null when it is not one. */
function pathOf(req: IncomingMessage): string | null {
  try {
    return new URL(req.url ?? "/", "http://ariadne.invalid").pathname;
  } catch {
    return null;
  }
}

/**
 * Answer the request if it is `GET /healthz`, `/readyz` or `/metrics`; resolve
 * false (answering nothing) otherwise.
 */
export async function serveOps(req: IncomingMessage, res: ServerResponse, opts: OpsOptions): Promise<boolean> {
  if (req.method !== "GET") return false;
  const path = pathOf(req);
  if (path === "/healthz") {
    const out = healthz();
    sendJson(res, out.status, out.body);
    return true;
  }
  if (path === "/readyz") {
    const out = await readyz(opts.db);
    sendJson(res, out.status, out.body);
    return true;
  }
  if (path === "/metrics") {
    if (opts.metricsToken === null || opts.metricsToken === undefined) {
      sendJson(res, 404, { error: "metrics are not configured (ARIADNE_METRICS_TOKEN is unset)" });
      return true;
    }
    const auth = checkBearer(req.headers.authorization, opts.metricsToken);
    if (!auth.ok) {
      res.setHeader("www-authenticate", 'Bearer realm="ariadne-metrics"');
      sendJson(res, 401, { error: auth.error });
      return true;
    }
    try {
      const text = await renderMetrics(opts.db);
      res.writeHead(200, { "content-type": METRICS_CONTENT_TYPE });
      res.end(text);
    } catch (error) {
      opts.log(`ops: /metrics failed — ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
      sendJson(res, 500, { error: "metrics unavailable" });
    }
    return true;
  }
  return false;
}
