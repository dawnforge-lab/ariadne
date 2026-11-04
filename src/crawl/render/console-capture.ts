/**
 * What one render saw go wrong in the page (`pages.render_console`, migration
 * 0025, Phase 25 §4): console messages at level error (a failed `console.assert` included) and warning, uncaught
 * exceptions, and requests the SITE failed — capped, with a total per kind so
 * "20 of 340" is visible.
 *
 * ONE COLLECTOR PER RENDER (`RenderTraffic` owns it), freed with the render:
 * at most `RENDER_CONSOLE_MAX_ENTRIES` entries per kind, so the memory is
 * O(concurrency), never O(pages) (hard rule 6).
 *
 * EVERY STRING IS THE SITE'S OWN — the page's console text, its exception
 * text, the URL it asked for — and arbitrary: a page can log anything. So each
 * one is made storable before it is kept, because Postgres `jsonb` rejects
 * U+0000 and unpaired surrogates and one hostile page would otherwise make the
 * render writer throw and stop the whole pass:
 *
 *  1. made well-formed (`toWellFormed`: a lone surrogate becomes U+FFFD);
 *  2. every U+0000 replaced by U+2400 (`␀`, SYMBOL FOR NULL), so it is visible
 *     rather than silently dropped — one character, not the six of `\u0000`,
 *     because a page can log that escape as literal text and the stored row
 *     must not make the two indistinguishable;
 *  3. cut to `RENDER_CONSOLE_MAX_CHARS` UTF-16 units on a code-point boundary
 *     (never half a surrogate pair), with `cut: true` — a cut value is never
 *     mistaken for a whole one.
 *
 * Nothing of the engine's enters here (Talos obligation 6): no stack of ours,
 * no local path, no internal hostname. The one engine-shaped string is a failed
 * request's `reason`, which is either `http <status>` or Chromium's own net
 * error name (`net::ERR_CONNECTION_REFUSED`) — a classification, never the
 * resolver's or the transport's text.
 */

export const RENDER_CONSOLE_MAX_ENTRIES = 20;
export const RENDER_CONSOLE_MAX_CHARS = 500;

export interface RenderConsole {
  /** The first `RENDER_CONSOLE_MAX_ENTRIES` messages, in arrival order. */
  console: { level: "error" | "warning"; text: string; cut: boolean }[];
  /** Every message seen at those levels, kept or not. */
  consoleTotal: number;
  /** Uncaught exceptions and unhandled rejections, as the page's own runtime worded them. */
  exceptions: { text: string; cut: boolean }[];
  exceptionsTotal: number;
  /**
   * Requests the browser sent that failed: at the network level (`status` null,
   * `reason` Chromium's net error name) or with an HTTP status of 400 or above
   * (`reason` `http <status>`). Never one the renderer aborted itself, and never
   * the top-level document, whose status is the page row's own.
   */
  failedRequests: { url: string; status: number | null; reason: string; cut: boolean }[];
  failedRequestsTotal: number;
  /**
   * The renderer's OWN aborts, as counts only — so a later rule can caveat a
   * console error our blocking may have caused (a `gtag is not defined` after
   * the analytics script was blocked). `thirdParty`: requests to another origin;
   * `sameOriginAssets`: the site's own images, media and fonts.
   */
  blockedByRenderer: { thirdParty: number; sameOriginAssets: number };
}

export class RenderConsoleCollector {
  private readonly consoleEntries: RenderConsole["console"] = [];
  private consoleTotal = 0;
  private readonly exceptionEntries: RenderConsole["exceptions"] = [];
  private exceptionsTotal = 0;
  private readonly failedEntries: RenderConsole["failedRequests"] = [];
  private failedRequestsTotal = 0;

  addConsole(level: "error" | "warning", text: string): void {
    this.consoleTotal += 1;
    if (this.consoleEntries.length >= RENDER_CONSOLE_MAX_ENTRIES) return;
    const kept = storable(text);
    this.consoleEntries.push({ level, text: kept.text, cut: kept.cut });
  }

  addException(text: string): void {
    this.exceptionsTotal += 1;
    if (this.exceptionEntries.length >= RENDER_CONSOLE_MAX_ENTRIES) return;
    this.exceptionEntries.push(storable(text));
  }

  addFailedRequest(url: string, status: number | null, reason: string): void {
    this.failedRequestsTotal += 1;
    if (this.failedEntries.length >= RENDER_CONSOLE_MAX_ENTRIES) return;
    const kept = storable(url);
    // The reason is a classification (see the module header), but it is made
    // storable the same way: nothing reaches the writer unchecked.
    this.failedEntries.push({ url: kept.text, status, reason: storable(reason).text, cut: kept.cut });
  }

  /** What was captured so far, as the row stores it. A copy: later additions do not reach it. */
  snapshot(blocked: { thirdParty: number; sameOriginAssets: number }): RenderConsole {
    return {
      console: this.consoleEntries.map((e) => ({ ...e })),
      consoleTotal: this.consoleTotal,
      exceptions: this.exceptionEntries.map((e) => ({ ...e })),
      exceptionsTotal: this.exceptionsTotal,
      failedRequests: this.failedEntries.map((e) => ({ ...e })),
      failedRequestsTotal: this.failedRequestsTotal,
      blockedByRenderer: { thirdParty: blocked.thirdParty, sameOriginAssets: blocked.sameOriginAssets },
    };
  }
}

/** What a U+0000 is stored as: U+2400 SYMBOL FOR NULL — see the module header. */
const NUL_MARK = "\u2400";

/** One site string, made storable in `jsonb` and capped — see the module header. */
function storable(raw: string): { text: string; cut: boolean } {
  const visible = wellFormed(raw).replaceAll("\u0000", NUL_MARK);
  if (visible.length <= RENDER_CONSOLE_MAX_CHARS) return { text: visible, cut: false };
  let end = RENDER_CONSOLE_MAX_CHARS;
  // Well-formed, so a high surrogate at the edge is the first half of a pair
  // whose second half is past the cap: the whole pair goes.
  const last = visible.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1;
  return { text: visible.slice(0, end), cut: true };
}

/** ES2024's `String.prototype.toWellFormed` (Node 22); the project's ES2023 lib does not declare it. */
function wellFormed(s: string): string {
  return (s as string & { toWellFormed(): string }).toWellFormed();
}
