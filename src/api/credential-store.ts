/**
 * The credential VALUES a server process holds, by crawl id (27c; shape-keyed
 * in 27d, closing 27c M9). Never stored, logged or answered.
 *
 * WHY SHAPE-KEYED. `crawl_config_set` commits a new `credentialShape` to the
 * row and only then could update this process's memory. A queue runner that
 * dequeued the crawl in that gap read the NEW row and the OLD values, and the
 * loop refused it (`requireCredentials`: "needs credentials of another
 * shape"). The service now `stage`s the new values BEFORE the transaction and
 * settles them on its outcome, and holds both beside each other meanwhile; a
 * reader asks for the entry of the shape ITS row states. A rolled-back change
 * drops only the staged entry: the old values stay usable.
 *
 * WHAT THE SHAPE KEY DOES NOT COVER. The shape tells the two entries apart
 * only when it differs. A change that keeps the shape and changes the VALUES
 * (a rotated password under the same scheme and header names) holds two
 * entries of one shape, and `get` answers with the first, the old one, until
 * the change is settled: a runner that dequeues the crawl between the commit
 * and the settle reads the new row and gets the old values. That window is
 * the one 27c already had for every change, now narrowed to same-shape ones;
 * closing it needs a generation on the row that the entry is matched by
 * (carried to Phase 28, `docs/gates/phase-27d.md`).
 *
 * Bounded by the crawls this process accepted with credentials (at most two
 * entries each, while a change is in flight).
 */
import { sameShape, shapeOf, type CredentialShape, type CrawlCredentials } from "../crawl/credentials.js";

export class CredentialStore {
  private readonly held = new Map<string, CrawlCredentials[]>();

  /** Whether any entry is held for the crawl. */
  has(crawlId: string): boolean {
    return (this.held.get(crawlId)?.length ?? 0) > 0;
  }

  /**
   * The settled entry for the crawl (the first held: a staged one sits behind
   * it), or undefined. For a caller that has no row's shape to ask with.
   */
  current(crawlId: string): CrawlCredentials | undefined {
    return this.held.get(crawlId)?.[0];
  }

  /**
   * The entry held for `crawlId` whose shape is `shape`, or undefined. A null
   * shape (a row that needs no credentials) finds nothing.
   */
  get(crawlId: string, shape: CredentialShape | null): CrawlCredentials | undefined {
    if (shape === null) return undefined;
    return this.held.get(crawlId)?.find((entry) => sameShape(shapeOf(entry), shape));
  }

  /** Holds `credentials` alone, replacing every entry. */
  set(crawlId: string, credentials: CrawlCredentials): void {
    this.held.set(crawlId, [credentials]);
  }

  delete(crawlId: string): void {
    this.held.delete(crawlId);
  }

  /**
   * Holds `next` beside the current entry (null stages a removal: nothing is
   * added). The returned function settles it: `true` keeps only `next` (or no
   * entry at all when `next` is null), `false` drops `next` and keeps what was
   * held. Settle once, whichever way the change ended.
   */
  stage(crawlId: string, next: CrawlCredentials | null): (committed: boolean) => void {
    const before = this.held.get(crawlId) ?? [];
    if (next !== null) this.held.set(crawlId, [...before, next]);
    let settled = false;
    return (committed: boolean): void => {
      if (settled) throw new Error(`credential store: the change staged for ${crawlId} was settled twice`);
      settled = true;
      if (committed) {
        if (next === null) this.held.delete(crawlId);
        else this.held.set(crawlId, [next]);
      } else if (next !== null) {
        const rest = (this.held.get(crawlId) ?? []).filter((entry) => entry !== next);
        if (rest.length === 0) this.held.delete(crawlId);
        else this.held.set(crawlId, rest);
      }
    };
  }
}
