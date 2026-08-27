# skills/

The agent-facing half of Ariadne. The engine emits facts over its API and MCP
surface; these skills are how an agent is told to drive that surface and what to do
with what comes back.

They live in this repository, not in `~/.claude/skills/`, because they are part of
the engine. A rule renamed, a tool argument added, a metric's value reshaped — each
of those changes what a skill should say, and a skill kept somewhere else drifts from
the engine within a phase. Here, the change and the instructions that describe it
land in the same commit.

## What is here

| Path | What it is |
|------|-----------|
| `ariadne-crawl/SKILL.md` | Start a crawl, poll it, render it, judge it. The crawl half of the surface, plus the politeness and failure paths. |
| `ariadne-audit/SKILL.md` | The audit orchestrator: analytics context, the checklist walk, the agent checks, and the findings file it writes. |
| `ariadne-audit/checklist.md` | **The audit checklist — 82 checks.** The living authority (CLAUDE.md hard rule 10): the rule registry's `checkIds` trace to the ids in this file, and `test/rules/coverage.test.ts` asserts the coverage in CI. |

`checklist.md` was imported once from `~/.claude/skills/sf-audit/checklist.md`, whose
sha and import date are in the provenance header at the top of the file. **That source
is frozen and is not a sync target.** A check is fixed here; nothing is ever
re-imported over it.

## Installing them

Claude Code loads skills from `~/.claude/skills/`. Either copy or symlink; the symlink
is better, because it keeps the installed skill and the repository in step:

```bash
ln -s "$PWD/skills/ariadne-crawl" ~/.claude/skills/ariadne-crawl
ln -s "$PWD/skills/ariadne-audit" ~/.claude/skills/ariadne-audit
```

A copy needs re-copying after every pull, and a stale copy of a skill is worse than no
skill: it names rules that were renamed and quotes fields that moved.

Nothing else is needed — a skill is markdown with YAML frontmatter. There is no build
step and no registration.

## Maintaining them

They are versioned with the engine, and that is a working rule rather than a
statement of intent:

- A rule id, a metric id, a tool argument or a refusal message that changes must be
  changed in the skill that quotes it, in the same commit.
- A check that gains a rule stops being agent work: its **Engine** line in
  `checklist.md` gets written the moment the rule lands, in the commit that lands it.
- Every CHECK id in `checklist.md` is load-bearing. Ids and their `Evaluate:` /
  `Record:` semantics are stable; a check whose "how" changes owner has its **Engine**
  line rewritten and nothing else.
- The skills say what the engine actually measures. Where a check asks for a number no
  rule produces, the checklist says NOT MEASURED and the skill records it as such —
  a plausible substitute number is the silent fallback hard rule 7 forbids.

## What consumes what

```
ariadne-crawl  ──crawlId──▶  ariadne-audit  ──ariadne-findings.json──▶  deliverables
```

The findings file's shape is defined in `ariadne-audit/SKILL.md`, Phase 4. It is an
INTERFACE: the skills that turn an audit into a report or an action plan read those
field names verbatim, so it changes deliberately and in one place.
