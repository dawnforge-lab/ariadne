/**
 * `npm run audit -- --site https://example.com/` — one audit, one session.
 *
 * This process is the bridge between the two halves:
 *   - the agent (judgement) runs in a Managed Agents session on Anthropic's
 *     infrastructure, with the ariadne-* skills and a bash sandbox;
 *   - the engine (facts) runs HERE: Ariadne's MCP server as a child process,
 *     crawling from this machine into the local Postgres.
 * Every `agent.custom_tool_use` is answered by calling the engine, so this
 * process must stay up for the whole session (a crawl can take hours). If it
 * dies, rerun with `--session <id>` to reattach; the agent can `crawl_resume`.
 *
 * The session is kicked off with an outcome (description + rubric.md) so a
 * separate grader checks the deliverables and sends the agent back to revise.
 *
 * Flags:
 *   --site <url>           required; the site to audit (its host is allowlisted)
 *   --allow <hosts>        extra allowlist entries, comma-separated (legacy hosts, CDN sitemaps)
 *   --budget-usd <n>       hard spend cap for the session (default 20)
 *   --max-iterations <n>   outcome grader iterations (default 2)
 *   --action-plan          also produce the Excel action plan
 *   --session <id>         reattach to an existing session instead of starting one
 *
 * Output: runs/<session-id>/ with events.jsonl, engine.log, summary.json and
 * every file the agent wrote to /mnt/session/outputs/.
 */
import { createWriteStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs } from "node:util";

import Anthropic from "@anthropic-ai/sdk";

import { AriadneRelay } from "./ariadne-relay.js";
import { ARIADNE_ROOT, OUTPUT_DIR, RUBRIC_PATH, RUNS_DIR, databaseUrl, loadState } from "./config.js";
import { drive, newStats, preview, type EventChannel, type SessionEvent } from "./driver.js";

const { values: flags } = parseArgs({
  options: {
    site: { type: "string" },
    allow: { type: "string", default: "" },
    "budget-usd": { type: "string", default: "20" },
    "max-iterations": { type: "string", default: "2" },
    "action-plan": { type: "boolean", default: false },
    session: { type: "string" },
  },
});

async function main(): Promise<void> {
  const state = loadState();
  if (!state.agentId || !state.environmentId || state.agentVersion === undefined) {
    throw new Error("No agent in state.json. Run `npm run setup` first.");
  }
  if (!flags.site) throw new Error("--site <url> is required (also when reattaching: it sets the allowlist)");

  const client = new Anthropic();
  const site = new URL(flags.site);
  const allowed = [site.hostname, ...flags.allow.split(",").map((h) => h.trim()).filter(Boolean)];

  let sessionId = flags.session;
  let kickoff: (() => Promise<void>) | undefined;
  if (!sessionId) {
    const budgetCents = Math.round(Number(flags["budget-usd"]) * 100);
    if (!Number.isFinite(budgetCents) || budgetCents <= 0) throw new Error("--budget-usd must be a positive number");
    const session = await client.beta.sessions.create({
      agent: { type: "agent", id: state.agentId, version: state.agentVersion },
      environment_id: state.environmentId,
      title: `Ariadne audit: ${site.hostname}`,
      budget: { type: "limit", max_list_cost: { amount: String(budgetCents), currency: "USD" } },
    });
    sessionId = session.id;
    kickoff = () => sendOutcome(client, session.id, site);
  }

  const runDir = join(RUNS_DIR, sessionId);
  mkdirSync(runDir, { recursive: true });
  const eventLog = createWriteStream(join(runDir, "events.jsonl"), { flags: "a" });
  const engineLog = createWriteStream(join(runDir, "engine.log"), { flags: "a" });
  console.log(`session ${sessionId}`);
  console.log(`trace: https://platform.claude.com/workspaces/default/sessions/${sessionId}`);
  console.log(`allowlist: ${allowed.join(", ")}`);

  const relay = await AriadneRelay.start({
    ariadneRoot: ARIADNE_ROOT,
    databaseUrl: databaseUrl(),
    allowedDomains: allowed,
    onStderr: (line) => engineLog.write(`${new Date().toISOString()} ${line}\n`),
  });

  const stats = newStats();
  try {
    await drive({
      channel: sdkChannel(client, sessionId),
      tools: relay,
      stats,
      ...(kickoff ? { kickoff } : {}),
      approve: askAtTerminal,
      onEvent: (event) => eventLog.write(`${JSON.stringify(event)}\n`),
    });
  } finally {
    stats.finishedAt = new Date().toISOString();
    // Closing the relay stops the engine; a crawl still running is cancelled
    // with its frontier intact, so `crawl_resume` can pick it up later.
    await relay.close().catch(() => undefined);
    eventLog.end();
    engineLog.end();
  }

  const files = await downloadOutputs(client, sessionId, runDir);
  const session = await client.beta.sessions.retrieve(sessionId);
  const summary = {
    sessionId,
    site: site.href,
    agent: session.agent,
    status: session.status,
    budget: session.budget,
    usage: session.usage,
    stats: session.stats,
    outcomeEvaluations: session.outcome_evaluations,
    run: stats,
    outputs: files,
  };
  writeFileSync(join(runDir, "summary.json"), `${JSON.stringify(summary, null, 2)}\n`);
  console.log(`\nsummary: ${join(runDir, "summary.json")}`);
  console.log(`outputs: ${files.length ? files.join(", ") : "(none)"}`);
}

function sdkChannel(client: Anthropic, sessionId: string): EventChannel {
  type SendParams = Parameters<typeof client.beta.sessions.events.send>[1];
  return {
    stream: async () =>
      (await client.beta.sessions.events.stream(sessionId)) as unknown as AsyncIterable<SessionEvent>,
    history: () => client.beta.sessions.events.list(sessionId) as unknown as AsyncIterable<SessionEvent>,
    send: async (events) => {
      await client.beta.sessions.events.send(sessionId, { events } as unknown as SendParams);
    },
  };
}

/**
 * A sandbox call the server's `auto` policy could not decide. Ask the person
 * at the terminal; with nobody there, deny (never allow-all unattended).
 */
async function askAtTerminal(event: SessionEvent): Promise<boolean> {
  if (!process.stdin.isTTY) return false;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = await rl.question(`Allow ${String(event.name)} ${preview(event.input, 400)}? [y/N] `);
    return answer.trim().toLowerCase().startsWith("y");
  } finally {
    rl.close();
  }
}

async function sendOutcome(client: Anthropic, sessionId: string, site: URL): Promise<void> {
  const actionPlan = flags["action-plan"];
  const rubric = readFileSync(RUBRIC_PATH, "utf8")
    .replaceAll("{site}", site.href)
    .replaceAll("{host}", site.hostname)
    .replaceAll("{action_plan}", actionPlan ? "required" : "not requested; do not produce one");
  await client.beta.sessions.events.send(sessionId, {
    events: [
      {
        type: "user.define_outcome",
        description:
          `Run a full Ariadne audit of ${site.href}. Crawl it with the ariadne-crawl skill ` +
          `(start, poll to completion, render, run the rules), walk the checklist with the ` +
          `ariadne-audit skill, then write the deliverables with ariadne-report` +
          (actionPlan ? " and ariadne-action-plan" : "") +
          `. Deliver ariadne-findings.json, the markdown report` +
          (actionPlan ? " and the Excel action plan" : "") +
          ` in ${OUTPUT_DIR}/.`,
        rubric: { type: "text", content: rubric },
        max_iterations: Number(flags["max-iterations"]),
      },
    ],
  });
}

/** Files the agent wrote to /mnt/session/outputs/, saved into the run directory. */
async function downloadOutputs(client: Anthropic, sessionId: string, runDir: string): Promise<string[]> {
  const saved: string[] = [];
  // Outputs are indexed a moment after the session goes idle.
  for (let attempt = 0; attempt < 5 && saved.length === 0; attempt++) {
    if (attempt > 0) await sleep(2_000);
    for await (const file of client.beta.files.list({ scope_id: sessionId, betas: ["managed-agents-2026-04-01"] })) {
      const response = await client.beta.files.download(file.id);
      // basename: a filename is data from the session, never a path to follow.
      const target = join(runDir, "outputs", basename(file.filename));
      mkdirSync(join(runDir, "outputs"), { recursive: true });
      writeFileSync(target, Buffer.from(await response.arrayBuffer()));
      saved.push(file.filename);
    }
  }
  return saved;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
