/**
 * The configured V8 heap cap (29d T16).
 *
 * The memory contract (hard rule 6) was only ever measured under an explicit
 * `--max-old-space-size`. A node process cannot change its own cap after it has
 * started, so `ARIADNE_HEAP_MB` is APPLIED by the launcher (`docker-entrypoint.sh`,
 * the npm serve scripts, the gate commands) and VERIFIED here, at boot: a process
 * that is not running under the cap it was told it has refuses to start, rather
 * than serving on V8's default (4 GB on a dev machine) and quietly breaking the
 * contract.
 */
import v8 from "node:v8";

/** The environment variable naming the `--max-old-space-size` (MB) node was started with. */
export const HEAP_CAP_ENV = "ARIADNE_HEAP_MB";

/**
 * V8's `heap_size_limit` is the old-space cap PLUS the young generation.
 * Measured on Node 22.23.2 x64: caps of 256, 384 and 512 give limits of 304,
 * 432 and 560 MB (+48 MB), and no cap gives 4,144 MB. 64 is the allowance above
 * the cap that still counts as "started with this cap".
 */
export const YOUNG_GENERATION_ALLOWANCE_MB = 64;

const MIB = 1024 * 1024;

/** The cap in MB, or an error naming `ARIADNE_HEAP_MB`. No default: unset is a boot error. */
export function parseHeapCapMb(raw: string | undefined): number {
  if (raw === undefined || raw === "") {
    throw new Error(
      `${HEAP_CAP_ENV} must be set to the --max-old-space-size (MB) node was started with, and there is no default`,
    );
  }
  const value = Number(raw);
  if (!/^[1-9][0-9]*$/.test(raw) || !Number.isSafeInteger(value)) {
    throw new Error(`${HEAP_CAP_ENV} must be a positive whole number (MB), got ${JSON.stringify(raw.slice(0, 40))}`);
  }
  return value;
}

/**
 * Require that this process really runs under the configured cap, and return
 * the cap in MB. Throws on an unset or malformed variable and on a V8 limit that
 * is not `cap <= limit < cap + YOUNG_GENERATION_ALLOWANCE_MB`.
 */
export function assertHeapCap(
  env: NodeJS.ProcessEnv = process.env,
  heapSizeLimitBytes: number = v8.getHeapStatistics().heap_size_limit,
): number {
  const cap = parseHeapCapMb(env[HEAP_CAP_ENV]);
  if (heapSizeLimitBytes < cap * MIB || heapSizeLimitBytes >= (cap + YOUNG_GENERATION_ALLOWANCE_MB) * MIB) {
    throw new Error(
      `${HEAP_CAP_ENV} is ${cap} but this process's V8 heap limit is ${Math.round(heapSizeLimitBytes / MIB)} MB: ` +
        `start node with --max-old-space-size=${cap} (docker-entrypoint.sh and the npm serve scripts do)`,
    );
  }
  return cap;
}
