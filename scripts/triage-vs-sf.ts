/**
 * Compare the triage table (src/rules/registry/triage.ts) with Screaming Frog's
 * own Issue Type and Issue Priority, read from an SF Issues Overview export.
 *
 *   npx tsx scripts/triage-vs-sf.ts <issues overview csv>
 *
 * Prints a Markdown table to stdout: one row per rule whose triage names an
 * `sfIssue`, then a count line. Phase 27a's gate commits that table; the CSV
 * itself is black-box output of a commercial tool and stays in the git-ignored
 * workspace (licence hygiene, CLAUDE.md rule 8). Only the Issue Name, Issue Type
 * and Issue Priority columns are read.
 *
 * Throws, rather than printing a row, when an `sfIssue` names an issue the CSV
 * does not have: a misspelt reference would otherwise read as "SF has no
 * opinion". Reads only the path it is given, and is never run in CI.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { buildRegistry } from "../src/rules/index.js";
import { TRIAGE } from "../src/rules/registry/triage.js";
import { parseCsv } from "./calibrate-sf.js";

interface SfJudgement {
  type: string;
  priority: string;
}

/** The SF issues by exact name, type and priority lower-cased to our vocabulary. */
function sfIssues(csvText: string): Map<string, SfJudgement> {
  const out = new Map<string, SfJudgement>();
  for (const row of parseCsv(csvText)) {
    const name = row["Issue Name"];
    const type = row["Issue Type"];
    const priority = row["Issue Priority"];
    if (name === undefined || type === undefined || priority === undefined)
      throw new Error("not an Issues Overview export: no Issue Name / Issue Type / Issue Priority columns");
    if (out.has(name)) throw new Error(`the export lists '${name}' twice`);
    out.set(name, { type: type.toLowerCase(), priority: priority.toLowerCase() });
  }
  return out;
}

/** Markdown-safe cell: the issue names carry `<head>` and `&`. */
const cell = (text: string): string => text.replace(/\|/g, "\\|").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function triageVsSf(csvText: string): string {
  const sf = sfIssues(csvText);
  const finders = buildRegistry()
    .all()
    .filter((r) => r.kind !== "metric")
    .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const lines = [
    "| rule | sfIssue | SF type/priority | ours | agrees |",
    "|---|---|---|---|---|",
  ];
  let mapped = 0;
  let agree = 0;
  for (const rule of finders) {
    const row = TRIAGE[rule.id];
    if (row === undefined) throw new Error(`rule '${rule.id}' has no triage row`);
    if (row.sfIssue === undefined) continue;
    const ref = sf.get(row.sfIssue);
    if (ref === undefined)
      throw new Error(`rule '${rule.id}' names SF issue '${row.sfIssue}', which the export does not list`);
    mapped += 1;
    const same = ref.type === row.type && ref.priority === row.priority;
    if (same) agree += 1;
    lines.push(
      `| \`${rule.id}\` | ${cell(row.sfIssue)} | ${ref.type} / ${ref.priority} | ${row.type} / ${row.priority} | ${same ? "yes" : "**no**"} |`,
    );
  }
  const unmapped = finders.length - mapped;
  lines.push(
    "",
    `${mapped} mapped, ${agree} agree, ${mapped - agree} differ, ${unmapped} unmapped`,
  );
  return `${lines.join("\n")}\n`;
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const path = process.argv[2];
  if (path === undefined) {
    console.error("usage: npx tsx scripts/triage-vs-sf.ts <issues overview csv>");
    process.exit(2);
  }
  process.stdout.write(triageVsSf(readFileSync(path, "utf8")));
}
