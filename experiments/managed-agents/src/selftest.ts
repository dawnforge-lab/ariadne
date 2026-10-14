/**
 * `npm run selftest` — everything that can be checked without an Anthropic
 * API key, and without crawling anything:
 *
 *   - the relay starts Ariadne's MCP server and lists its tools;
 *   - every relayed tool is a valid custom tool (name rules, object schema);
 *   - read tools answer, a refusal comes back as an error result, a withheld
 *     tool is refused by the relay;
 *   - the skills are uploadable (SKILL.md frontmatter, name rules, size);
 *   - the rubric template fills.
 *
 * Needs DATABASE_URL pointing at a migrated Ariadne database. The allowlist is
 * left EMPTY, so crawl_start is refused before any host is contacted.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

import { AriadneRelay, WITHHELD_TOOLS } from "./ariadne-relay.js";
import { ARIADNE_ROOT, RUBRIC_PATH, SKILLS_DIR, SKILL_NAMES, customToolsFrom, databaseUrl } from "./config.js";

const BUILT_IN_TOOL_NAMES = new Set(["bash", "read", "write", "edit", "glob", "grep", "web_fetch", "web_search"]);

let failures = 0;
function check(ok: boolean, label: string, detail = ""): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures++;
}

async function main(): Promise<void> {
  const relay = await AriadneRelay.start({
    ariadneRoot: ARIADNE_ROOT,
    databaseUrl: databaseUrl(),
    allowedDomains: [],
    onStderr: (line) => console.log(`        engine: ${line}`),
  });
  try {
    const tools = await relay.listTools();
    check(tools.length > 0, "relay lists Ariadne's tools", tools.map((t) => t.name).join(", "));
    for (const withheld of Object.keys(WITHHELD_TOOLS)) {
      check(!tools.some((t) => t.name === withheld), `withheld tool not offered: ${withheld}`);
    }
    for (const tool of customToolsFrom(tools)) {
      const nameOk =
        /^[a-zA-Z0-9_-]{1,64}$/.test(tool.name) &&
        !tool.name.startsWith("mcp__") &&
        !tool.name.startsWith("ant__") &&
        !BUILT_IN_TOOL_NAMES.has(tool.name);
      check(nameOk && tool.input_schema.type === "object" && tool.description.length > 0, `custom tool shape: ${tool.name}`);
    }

    const catalog = await relay.call("rules_catalog", {});
    check(!catalog.isError && isJson(catalog.text), "rules_catalog answers JSON", `${catalog.text.length} chars`);

    const list = await relay.call("crawl_list", {});
    check(!list.isError && isJson(list.text), "crawl_list answers JSON");

    const refused = await relay.call("crawl_start", { siteUrl: "https://example.com/" });
    check(refused.isError, "crawl_start off the allowlist comes back as an error result", refused.text.slice(0, 160));

    const withheld = await relay.call("export_crawl", { crawlId: "00000000-0000-0000-0000-000000000000" });
    check(withheld.isError && withheld.text.includes("not offered"), "withheld tool refused by the relay");
  } finally {
    await relay.close();
  }

  for (const name of SKILL_NAMES) {
    const dir = join(SKILLS_DIR, name);
    const skillMd = readFileSync(join(dir, "SKILL.md"), "utf8");
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(skillMd)?.[1] ?? "";
    const declared = /^name:\s*(.+)$/m.exec(frontmatter)?.[1]?.trim();
    const description = descriptionOf(frontmatter);
    const bytes = sizeOf(dir);
    check(
      declared === name && /^[a-z0-9-]{1,64}$/.test(name) && !/anthropic|claude/.test(name),
      `skill ${name}: frontmatter name`,
      `declared ${declared ?? "(none)"}`,
    );
    check(description.length > 0 && description.length <= 1024, `skill ${name}: description length`, `${description.length} chars`);
    check(bytes < 30 * 1024 * 1024, `skill ${name}: upload size`, `${(bytes / 1024).toFixed(0)} KiB`);
  }

  const rubric = readFileSync(RUBRIC_PATH, "utf8")
    .replaceAll("{site}", "https://example.com/")
    .replaceAll("{host}", "example.com")
    .replaceAll("{action_plan}", "required");
  check(!/\{(site|host|action_plan)\}/.test(rubric), "rubric placeholders fill");

  console.log(failures === 0 ? "\nselftest: all checks passed" : `\nselftest: ${failures} check(s) failed`);
  process.exit(failures === 0 ? 0 : 1);
}

function isJson(text: string): boolean {
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

/** The frontmatter `description`, folded (`>`) or inline. */
function descriptionOf(frontmatter: string): string {
  const match = /^description:\s*(>-?|\|-?)?\s*(.*)$/m.exec(frontmatter);
  if (!match) return "";
  if (!match[1]) return (match[2] ?? "").trim();
  const lines = frontmatter.slice(frontmatter.indexOf(match[0]) + match[0].length).split("\n");
  const body: string[] = [];
  for (const line of lines) {
    if (line.trim() === "") continue;
    if (!/^\s/.test(line)) break;
    body.push(line.trim());
  }
  return body.join(" ");
}

function sizeOf(dir: string): number {
  let total = 0;
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const info = statSync(path);
    total += info.isDirectory() ? sizeOf(path) : info.size;
  }
  return total;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
