# Experiment: an Ariadne audit driven by Claude Managed Agents

**Question:** can a Claude Managed Agents session run a full Ariadne audit (crawl,
checklist, report, optionally the action plan) from the ariadne-* skills, with
the engine reached through custom tools? And how does that compare with the
same audit run in Claude Code?

This is an experiment, not part of the engine. Nothing under `src/` or `test/`
imports it, the root `tsconfig.json` and vitest do not include it, and it has
its own `package.json`, so none of its dependencies reach the engine.

## How it is wired

```
 this machine                                       Anthropic
 ┌──────────────────────────────────────────┐       ┌──────────────────────────────┐
 │ npm run audit                            │       │ Managed Agents session       │
 │  ├─ Ariadne MCP server (child, stdio)    │ ◀───▶ │  agent: system prompt +      │
 │  │   crawls the site, writes Postgres    │ custom│   ariadne-* skills +         │
 │  └─ relay: agent.custom_tool_use ──▶     │ tools │   bash sandbox (no web)      │
 │           tools/call ──▶ custom result   │       │  outcome: rubric.md, graded  │
 │  runs/<session>/: events, engine log,    │       │  writes /mnt/session/outputs │
 │   summary, downloaded deliverables       │       │                              │
 └──────────────────────────────────────────┘       └──────────────────────────────┘
```

- **Facts stay on our side.** The engine runs locally: it crawls from this
  machine and reads and writes the local Postgres. The sandbox never reaches
  the engine, the database or the site. Its networking is `limited`, with only
  package registries open so it can install openpyxl.
- **The tools are Ariadne's own.** `tools/list` from the MCP server becomes the
  agent's custom tools: same names, descriptions and JSON schemas the skills
  quote. Two are withheld: `export_crawl` returns a path on the engine's disk
  that the sandbox cannot read, and `crawl_mark_failed` is an operator action
  (see `src/ariadne-relay.ts`).
- **The skills are uploaded as they are**, as four custom skills.
- **Judgement is graded.** The session starts with a `user.define_outcome`.
  A separate grader scores the deliverables against `rubric.md` (a starter;
  tune it) and sends the agent back to revise, up to `--max-iterations`.
- **Spend is capped** per session with a hard budget (`--budget-usd`, default $20).

## Prerequisites

1. **An Anthropic API key** with Managed Agents access: `export ANTHROPIC_API_KEY=...`.
2. **The engine's prerequisites**, from the repo root (see `CLAUDE.md`): Postgres
   with `DATABASE_URL` exported, `npm ci`, `npm run db:migrate`, and Chromium for
   the render pass (`npx playwright install chromium`).
3. **Permission to crawl the site.** Same rule as always: client sites only with
   consent.
4. `npm ci` in this directory.

## Run it

```bash
cd experiments/managed-agents
npm ci

npm test            # the session loop against a scripted session (no key needed)
npm run selftest    # relay + skills + rubric against the local engine (no key needed)

npm run setup       # once: uploads skills, creates the environment and agent -> state.json
npm run audit -- --site https://www.example.com/ --budget-usd 20
npm run audit -- --site https://www.example.com/ --action-plan   # also the Excel plan
```

`npm run setup -- --dry-run` prints the agent definition without calling the
API. Re-running `setup` after editing a skill or the system prompt uploads new
skill versions and bumps the agent's version; it does not create new resources.

**Keep `npm run audit` running for the whole session.** It is the only thing
that answers the agent's engine calls. If it dies, rerun with
`--session <id> --site <same url>` to reattach: it catches up from the event
history, answers any call still waiting, and the agent can `crawl_resume` a crawl
that was cancelled when the engine stopped.

`--allow host1,host2` adds allowlist entries beyond the site's own host, for
legacy hosts or a sitemap on a CDN.

## What a run leaves behind

`runs/<session-id>/` (gitignored):

| File | What it is |
|---|---|
| `events.jsonl` | Every session event, in order |
| `engine.log` | The engine's stderr: crawl progress, politeness, render pass |
| `summary.json` | Usage and list cost, engine calls (count, errors, time per tool), sandbox tool calls, grader verdicts per iteration, reconnects, final stop reason |
| `outputs/` | Whatever the agent wrote to `/mnt/session/outputs/`: `ariadne-findings.json`, the report, the action plan |

The session's trace is also in the Console. The run prints the link.

## What to compare against Claude Code

Run the same site through Claude Code with the MCP server and the same skills,
then compare:

1. **Correctness of the findings file:** every checklist id present, engine
   answers quoted rather than estimated, SKIPs that name a reason. The rubric
   encodes these; the grader's verdicts in `summary.json` are a first pass, not
   the final word.
2. **Report quality:** prioritisation and narrative, with the engine's numbers
   quoted verbatim.
3. **Cost and wall time:** `usage` in `summary.json` against the Claude Code
   session's cost.
4. **Operational behaviour:** how it polls a long crawl (it is told to sleep in
   bash between polls), whether it recovers from refusals, how many grader
   iterations it needs.

## Known limits of this setup

- **No analytics connectors.** GSC, GA4 and Ahrefs checks are SKIP by design.
  Attaching them later means MCP servers on the agent plus vault credentials.
- **No browser.** Agent checks that need one are SKIP.
- **Long tool descriptions.** Ariadne's descriptions are thorough
  (`crawl_status` alone is about 11k characters); the 16 tools come to about
  60 KB of definitions per request, which prompt caching should absorb.
  Measure it in `usage`.
- **One crawl at a time.** The engine runs one crawl per process (see the queue
  notes in `src/api/service.ts`), so concurrent audits need one engine process
  each. That is a deployment question for Talos, not for this experiment.
