/**
 * The fixture contract: one engineered page, one set of rule ids it must make
 * the engine produce.
 *
 * A fixture is not a unit test. It is a page served over real HTTP, crawled by
 * the real crawler, judged by the real rules, and read back out of the `issues`
 * table — so `expectedIssues` is an end-to-end claim about the whole engine,
 * not about one function.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

import { absorbedFixtures } from "./pages/absorbed.js";
import { authoredFixtures } from "./pages/authored.js";
import { controlFixture } from "./pages/control.js";

export interface Fixture {
  /** Path this fixture is served at, e.g. "/head/missing-title". */
  path: string;
  /** Grouping, for reading a failure quickly. */
  category: string;
  name: string;
  /**
   * Rule ids that fire on this path. Read as a floor by default — a page can
   * trip a rule it was not built for, and the harness asserts containment —
   * unless `exact` says otherwise. The one page that must fire *nothing* is
   * `/control`.
   */
  expectedIssues: string[];
  /**
   * Whether `expectedIssues` is the COMPLETE set of rules the page fires rather
   * than a floor. The authored fixtures set it: each one starts from the
   * control recipe and breaks exactly the signals its name promises, so any
   * other finding is either a defect in the page or a rule that has grown too
   * eager, and a containment assertion would notice neither.
   *
   * The absorbed pages leave it unset. Their content came from upstream to
   * demonstrate one issue, not to be silent about the other twenty-seven, so
   * pinning their full finding set would be asserting something we did not
   * engineer.
   */
  exact?: boolean;
  handler: (req: IncomingMessage, res: ServerResponse) => void;
}

/**
 * Every fixture the site serves: the pages absorbed from badseo, the pages
 * authored here for the rules that absorb left unclaimed, and the control.
 */
export function allFixtures(): Fixture[] {
  return [...absorbedFixtures, ...authoredFixtures, controlFixture];
}
