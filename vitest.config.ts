import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts", "src/**/*.test.ts"],
    /**
     * A HANG DETECTOR, not a performance assertion — which is why it is 60s and
     * not 30s.
     *
     * The DB-bound tests each run real work against one shared Postgres: a
     * `runRules` test drives all 79 rules over a crawl, and its cost grows with
     * whatever the other files' crawls have left in `pages` and `links` while
     * it runs. Measured, those tests sit at 7-20s each, and the Phase 6 API
     * file (a crawl, a render pass and a rules run over HTTP) raised the
     * contention enough that the slowest of them crossed 30s intermittently —
     * as a timeout, never as a wrong answer.
     *
     * Raising the net is the honest response to that: no test here asserts its
     * own duration against this number (the one test that does assert timing —
     * the render pass's host-gate spacing — carries its own epsilon and is
     * unaffected), so the only thing 30s was catching was legitimate work.
     */
    testTimeout: 60_000,
  },
});
