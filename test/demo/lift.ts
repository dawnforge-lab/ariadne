/**
 * RUNNING THE DEMO PAGE'S OWN FUNCTIONS, in a suite with no browser.
 *
 * `src/demo/index.html` is a served HTML file with its JavaScript inline: there
 * is no module to import. `test/demo/flow.test.ts` asserts the page's CODE PATHS
 * by reading the source, which is right for "does the header come from
 * `columns`" and useless for "what string does this produce" — so the two tests
 * that need a STRING lift the function out of the file by name and run it.
 *
 * One definition, because two copies of a brace scanner would be two things to
 * fix the day the page grows a helper with a brace inside a string literal.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** The page itself — the file both callers lift out of. */
export const DEMO_PAGE = fileURLToPath(new URL("../../src/demo/index.html", import.meta.url));

/**
 * One named function's source, from `function NAME(` to its balanced `}`.
 *
 * Naive brace counting, and it is sound on this input because the page's
 * helpers contain no brace inside a string or a regex literal — a fact a caller
 * would discover immediately if it stopped being true, because the extracted
 * text would not parse. A name the page no longer defines throws here rather
 * than yielding an empty function that passes.
 */
export function lift(source: string, name: string): string {
  const start = source.indexOf(`function ${name}(`);
  if (start === -1) throw new Error(`src/demo/index.html no longer defines ${name}()`);
  let depth = 0;
  let seenBrace = false;
  for (let i = start; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
      seenBrace = true;
    } else if (ch === "}") {
      depth -= 1;
      if (seenBrace && depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`${name}() in src/demo/index.html has no balanced body`);
}

/**
 * The named functions, lifted together and evaluated, with `entry` returned.
 *
 * They are joined into ONE scope because the page's helpers call each other:
 * `valueText` reaches `scalarText`, `metricCellText` reaches `metricNumber`.
 */
export function liftFunctions<T>(names: readonly string[], entry: string): T {
  const html = readFileSync(DEMO_PAGE, "utf8");
  const body = names.map((name) => lift(html, name)).join("\n");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  return new Function(`${body}\nreturn ${entry};`)() as T;
}
