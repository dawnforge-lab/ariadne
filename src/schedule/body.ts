/**
 * The schedule request bodies (Phase 28c): `POST /schedules` and `schedule_create`
 * take `{crawl, cron, timezone, enabled?, render?}`, `PATCH /schedules/:id` and
 * `schedule_update` the same keys, all optional and at least one.
 *
 * Parsed by hand, strictly: an unknown key is refused by its POSITION in the
 * order sent and never quoted (27d spec §4) — zod's own unknown-key sentence
 * quotes the key. `crawl` is returned as it arrived: it is a `crawl_start` body
 * and `ApiService.planStart` is its one parser. `cron` and `timezone` are
 * checked for their TYPE here and for their meaning by `parseCron`.
 */
import { ServiceError, clip, unknownKeysMessage } from "../api/errors.js";
import { normalizeUrl } from "../crawl/parse/url-utils.js";
import type { ChainRender } from "../crawl/insert-crawl.js";

export const SCHEDULE_BODY_KEYS = ["crawl", "cron", "timezone", "enabled", "render"] as const;

/** A parsed schedule body: only the keys the caller sent. */
export interface ScheduleInput {
  crawl?: unknown;
  cron?: string;
  timezone?: string;
  enabled?: boolean;
  render?: ChainRender | null;
}

const RENDER_KEYS = ["urls"] as const;

function plainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** `render`: null (no render link) or `{urls?}`; the urls are normalised and de-duplicated. */
function parseRender(value: unknown): ChainRender | null {
  if (value === null) return null;
  if (!plainObject(value)) {
    throw new ServiceError("VALIDATION", "render must be null (no render pass) or an object {urls?: string[]}");
  }
  const unknown = Object.keys(value).filter((k) => !(RENDER_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new ServiceError("VALIDATION", unknownKeysMessage("render", value, unknown, RENDER_KEYS));
  }
  const urls = value["urls"];
  if (urls === undefined) return {};
  if (!Array.isArray(urls) || urls.length === 0 || urls.some((u) => typeof u !== "string")) {
    throw new ServiceError("VALIDATION", "render.urls must be a non-empty array of strings");
  }
  const distinct: string[] = [];
  for (const [index, entry] of (urls as string[]).entries()) {
    const url = normalizeUrl(entry);
    if (url === null) {
      throw new ServiceError("VALIDATION", `render.urls[${index}] '${clip(entry)}' is not an absolute http(s) URL`);
    }
    if (!distinct.includes(url)) distinct.push(url);
  }
  return { urls: distinct };
}

export function parseScheduleBody(raw: unknown, mode: "create" | "update"): ScheduleInput {
  if (!plainObject(raw)) {
    throw new ServiceError("VALIDATION", "request body must be a JSON object");
  }
  const unknown = Object.keys(raw).filter((k) => !(SCHEDULE_BODY_KEYS as readonly string[]).includes(k));
  if (unknown.length > 0) {
    throw new ServiceError("VALIDATION", unknownKeysMessage("body", raw, unknown, SCHEDULE_BODY_KEYS));
  }
  const input: ScheduleInput = {};
  if (raw["crawl"] !== undefined) {
    if (!plainObject(raw["crawl"])) {
      throw new ServiceError("VALIDATION", "crawl must be a crawl_start body (a JSON object)");
    }
    input.crawl = raw["crawl"];
  }
  for (const key of ["cron", "timezone"] as const) {
    const value = raw[key];
    if (value === undefined) continue;
    if (typeof value !== "string") throw new ServiceError("VALIDATION", `${key} must be a string`);
    input[key] = value;
  }
  if (raw["enabled"] !== undefined) {
    if (typeof raw["enabled"] !== "boolean") throw new ServiceError("VALIDATION", "enabled must be a boolean");
    input.enabled = raw["enabled"];
  }
  if (raw["render"] !== undefined) input.render = parseRender(raw["render"]);

  if (mode === "create") {
    for (const key of ["crawl", "cron", "timezone"] as const) {
      if (input[key] === undefined) throw new ServiceError("VALIDATION", `${key} is required`);
    }
  } else if (Object.keys(input).length === 0) {
    throw new ServiceError(
      "VALIDATION",
      `a schedule update names at least one of ${SCHEDULE_BODY_KEYS.join(", ")}`,
    );
  }
  return input;
}
