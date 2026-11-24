/**
 * What one render may take, in its own module because two others read it:
 * the renderer bounds every page by it (`PageRenderer.render`, Phase 29d) and
 * the render pass derives the crash-resume lease from the same terms
 * (`renderLeaseSeconds`, run-render.ts). Here rather than in either of them so
 * neither imports the other's module for a number: run-render.ts already
 * imports the renderer, and the renderer must not import the pass back.
 * run-render.ts re-exports all three names, so the pass's callers find them
 * where the lease is.
 */
import { AXE_TERMINATE_GRACE_MS, AXE_TIMEOUT_MS } from "./a11y.js";

/**
 * What a render may spend AFTER its navigation and settle: the in-page
 * measurement, serialising and analysing the DOM, writing it to disk, clearing
 * the context and the page-row transaction. All ours and all local — seconds
 * at most; 30 s is the allowance, stated rather than folded into a round
 * number.
 */
export const RENDER_POST_SETTLE_ALLOWANCE_MS = 30_000;

/**
 * The most the accessibility run can add to one render (Phase 29b): axe's own
 * budget, then the grace the renderer waits after terminating it
 * (`AXE_TIMEOUT_MS` + `AXE_TERMINATE_GRACE_MS`, a11y.ts) — 35 s. It is a
 * page-controlled wait (a page that blocks its thread runs it out), so it is
 * its own term in the lease rather than folded into the local allowance
 * above. Counted ALWAYS, also when the crawl turned the run off: one fewer
 * branch, and a longer lease is the polite direction (it only delays a
 * CRASHED worker's URL).
 */
export const RENDER_AXE_ALLOWANCE_MS = AXE_TIMEOUT_MS + AXE_TERMINATE_GRACE_MS;

/**
 * One page's render deadline (Phase 29d): the navigation budget, plus
 * `RENDER_POST_SETTLE_ALLOWANCE_MS`, plus `RENDER_AXE_ALLOWANCE_MS` — 80 s at
 * the renderer's own 15 s default, 110 s at the pass's 45 s budget for the
 * default 1 s spacing.
 *
 * THE LEASE'S SUM, so the two agree: `renderLeaseSeconds` is the gate wait
 * and the settle on top of exactly this, and a render a live worker is still
 * inside can never outlive its own lease. The settle is not a term of its
 * own: it is spent out of the allowance after it, which a page at the 3 s
 * default settle leaves 27 s of.
 *
 * It bounds the WHOLE render from the moment the document's gate wait ends —
 * navigation, settle, measurement, images, `page.content()` and the
 * accessibility run — so a page that never yields, never finishes loading or
 * never lets axe start costs that page, never the pass (see
 * `PageRenderer.render`). The gate wait before it is our own politeness and is
 * the lease's to bound, not this.
 */
export function renderPageDeadlineMs(navigationBudgetMs: number): number {
  return navigationBudgetMs + RENDER_POST_SETTLE_ALLOWANCE_MS + RENDER_AXE_ALLOWANCE_MS;
}
