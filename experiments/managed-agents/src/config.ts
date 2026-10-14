/**
 * Paths, the persisted resource IDs, and the agent definition.
 *
 * The agent, environment and skills are created ONCE by `npm run setup` and
 * their IDs kept in `state.json` (gitignored). Every audit run reads them and
 * creates only a session. Re-running setup updates the same resources in place
 * (a new agent version, a new skill version) rather than creating new ones.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { RelayedTool } from "./ariadne-relay.js";

export const EXPERIMENT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const ARIADNE_ROOT = resolve(EXPERIMENT_DIR, "..", "..");
export const SKILLS_DIR = join(ARIADNE_ROOT, "skills");
export const STATE_PATH = join(EXPERIMENT_DIR, "state.json");
export const RUNS_DIR = join(EXPERIMENT_DIR, "runs");
export const RUBRIC_PATH = join(EXPERIMENT_DIR, "rubric.md");

/** The four skills, uploaded as custom skills. Order is the order they run in. */
export const SKILL_NAMES = [
  "ariadne-crawl",
  "ariadne-audit",
  "ariadne-report",
  "ariadne-action-plan",
] as const;

export const AGENT_NAME = "Ariadne audit agent (experiment)";
export const ENVIRONMENT_NAME = "ariadne-audit-sandbox";
export const DEFAULT_MODEL = "claude-opus-5-5";
export const OUTPUT_DIR = "/mnt/session/outputs";

export interface ExperimentState {
  skills: Record<string, string>;
  environmentId?: string;
  agentId?: string;
  agentVersion?: number;
}

export function loadState(): ExperimentState {
  if (!existsSync(STATE_PATH)) return { skills: {} };
  return JSON.parse(readFileSync(STATE_PATH, "utf8")) as ExperimentState;
}

export function saveState(state: ExperimentState): void {
  writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`);
}

export function databaseUrl(): string {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      "DATABASE_URL is not set. Point it at the Ariadne Postgres (see the repo CLAUDE.md), " +
        "with migrations applied (npm run db:migrate in the repo root).",
    );
  }
  return url;
}

/**
 * The system prompt: what is different about THIS harness compared with the
 * one the skills were written for (Claude Code with Ariadne's MCP server).
 * Everything about how to crawl and audit stays in the skills.
 */
export const SYSTEM_PROMPT = `You are an SEO audit agent. You run audits with the Ariadne crawl-and-audit engine, following the ariadne-* skills attached to you. The skills are the authority on how to crawl, how to audit and what the deliverables look like; read the relevant SKILL.md before acting.

How this environment differs from the one the skills describe:

- The Ariadne tools are available to you directly as tools named crawl_start, crawl_status, issues_list and so on: the same names and arguments as the MCP tools in the skills. The engine server is already running and connected; you do not start it and there is no HTTP fallback to configure. Skill prerequisites 1 to 4 (a running server, the allowlist, legacy hosts on the allowlist, Chromium) are the operator's responsibility and are already in place for the site named in the task. Permission to crawl that site has been given (prerequisite 5). Crawl only the site named in the task.
- export_crawl and crawl_mark_failed are not offered. Where a skill mentions export_crawl, page through issue_urls or pages_query instead. If a crawl looks stranded, report it; do not try to retire it.
- No analytics connectors are attached: no GSC, GA4 or Ahrefs. Record the Phase 0 analytics checks as SKIP, naming that the connector was not available in this run, exactly as the audit skill describes for a missing connector. Do not substitute estimates.
- You have no browser and web search and web fetch are off. Checks that need a browser are SKIP with that reason. Never grade a check by inspecting pages yourself; the engine's output is the answer for every claimed check.
- You have a bash sandbox for writing files and running python. It has no access to the engine's database or files.
- Crawls take minutes to hours. Between crawl_status polls, wait in bash (for example \`sleep 60\`, longer for a big site) instead of polling back to back.
- Write every deliverable to ${OUTPUT_DIR}/. That directory is the audit's working directory: ariadne-findings.json, the markdown report, and the action plan workbook if one is asked for.`;

export function customToolsFrom(tools: RelayedTool[]) {
  return tools.map((tool) => ({
    type: "custom" as const,
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema as { type: "object"; [key: string]: unknown },
  }));
}
