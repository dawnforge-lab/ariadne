/**
 * The heap cap a test child is started with (29d T16). Every serving process
 * asserts `ARIADNE_HEAP_MB` against V8's real limit at boot, so a test that
 * spawns one passes BOTH halves from here rather than repeating literals.
 */
import { HEAP_CAP_ENV } from "../../src/runtime/heap-cap.js";

export const TEST_HEAP_MB = 384;

/** The `node` flag that applies the cap. */
export const HEAP_CAP_NODE_FLAG = `--max-old-space-size=${TEST_HEAP_MB}`;

/** The environment variable that tells the child which cap it was started with. */
export const HEAP_CAP_TEST_ENV: Record<string, string> = { [HEAP_CAP_ENV]: String(TEST_HEAP_MB) };
