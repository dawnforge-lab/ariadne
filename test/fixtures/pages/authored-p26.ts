/**
 * The Phase 26a fixtures: pages that give the new rules over existing data
 * (docs/superpowers/specs/2026-11-05-phase-26-checks-wave-1-design.md, "26a")
 * something to fire on in the end-to-end harness.
 *
 * Empty until the tasks that register those rules add to it. Every fixture here
 * is `exact: true` and starts from the control recipe, so a page carries one
 * defect and the harness pins its issue list exactly. The fixture site is plain
 * HTTP on 127.0.0.1, so the HTTPS-only rules (`security.*` headers, HTTP-URL and
 * mixed content) cannot have a page here; they are proven by DB tests and are
 * listed in `SKIP_HARNESS_CLAIMS` with the reason.
 */
import type { Fixture } from "../fixture.js";

export const authoredP26Fixtures: Fixture[] = [];
