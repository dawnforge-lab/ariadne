/**
 * The session loop, separated from the SDK so it can be tested against a
 * scripted session (src/driver.test.ts) without an API key.
 *
 * It owns three things the session depends on us for:
 *   - answering every `agent.custom_tool_use` exactly once, from the engine;
 *   - answering sandbox calls the server's `auto` policy paused on;
 *   - surviving a dropped stream without missing or repeating either.
 */
import { setTimeout as sleep } from "node:timers/promises";

import type { ToolCallOutcome } from "./ariadne-relay.js";

export type SessionEvent = { id: string; type: string; [key: string]: unknown };

/** The three session-event operations the loop needs, adapted from the SDK in run.ts. */
export interface EventChannel {
  /** Open the live stream. Resolves once the stream is open. */
  stream(): Promise<AsyncIterable<SessionEvent>>;
  /** The full event history, oldest first. */
  history(): AsyncIterable<SessionEvent>;
  send(events: Array<Record<string, unknown>>): Promise<void>;
}

export interface ToolRunner {
  call(name: string, input: unknown): Promise<ToolCallOutcome>;
}

export interface RunStats {
  startedAt: string;
  finishedAt?: string;
  toolCalls: Record<string, number>;
  toolErrors: Record<string, number>;
  toolMillis: Record<string, number>;
  sandboxToolCalls: Record<string, number>;
  confirmations: { allowed: number; denied: number };
  outcomeEvaluations: Array<{ iteration: unknown; result: unknown; explanation: unknown }>;
  sessionErrors: unknown[];
  reconnects: number;
  finalStopReason?: unknown;
}

export function newStats(): RunStats {
  return {
    startedAt: new Date().toISOString(),
    toolCalls: {},
    toolErrors: {},
    toolMillis: {},
    sandboxToolCalls: {},
    confirmations: { allowed: 0, denied: 0 },
    outcomeEvaluations: [],
    sessionErrors: [],
    reconnects: 0,
  };
}

export interface DriveOptions {
  channel: EventChannel;
  tools: ToolRunner;
  stats: RunStats;
  /** Sent once, after the stream first opens (stream-first). Omit when reattaching. */
  kickoff?: () => Promise<void>;
  /** Decide a paused sandbox call. Deny when nobody is there to ask. */
  approve: (event: SessionEvent) => Promise<boolean>;
  /** Every event, as received (for the JSONL log). */
  onEvent?: (event: SessionEvent) => void;
  log?: (line: string) => void;
  maxReconnects?: number;
  backoffMs?: (attempt: number) => number;
}

/**
 * Stream the session until it settles: idle for any reason other than
 * `requires_action` (end_turn, retries_exhausted, budget_reached), or
 * terminated.
 *
 * Reconnect is lossless: on every (re)connect the stream is opened first, then
 * the history is read and deduplicated by event id. A custom tool call that
 * arrived while disconnected is answered on catch-up unless its result is
 * already in the history; without that the session would wait on us forever.
 */
export async function drive(options: DriveOptions): Promise<void> {
  const { channel, tools, stats, approve } = options;
  const log = options.log ?? ((line: string) => console.log(line));
  const maxReconnects = options.maxReconnects ?? 20;
  const backoffMs = options.backoffMs ?? ((attempt) => Math.min(30_000, 1_000 * 2 ** Math.min(attempt, 5)));

  const seen = new Set<string>();
  const answered = new Set<string>();
  let kickedOff = options.kickoff === undefined;

  const handle = async (event: SessionEvent): Promise<void> => {
    options.onEvent?.(event);
    switch (event.type) {
      case "agent.message":
        for (const block of (event.content as Array<{ type: string; text?: string }> | undefined) ?? []) {
          if (block.type === "text") log(block.text ?? "");
        }
        break;
      case "agent.custom_tool_use":
        if (!answered.has(event.id)) {
          answered.add(event.id);
          await answerToolCall(channel, tools, event, stats, log);
        }
        break;
      case "user.custom_tool_result":
        answered.add(event.custom_tool_use_id as string);
        break;
      case "agent.tool_use":
      case "agent.mcp_tool_use": {
        const name = String(event.name);
        stats.sandboxToolCalls[name] = (stats.sandboxToolCalls[name] ?? 0) + 1;
        log(`  [sandbox] ${name} ${preview(event.input)}`);
        if (event.evaluated_permission === "ask" && !answered.has(event.id)) {
          answered.add(event.id);
          const allow = await approve(event);
          if (allow) stats.confirmations.allowed++;
          else stats.confirmations.denied++;
          await channel.send([
            allow
              ? { type: "user.tool_confirmation", tool_use_id: event.id, result: "allow" }
              : {
                  type: "user.tool_confirmation",
                  tool_use_id: event.id,
                  result: "deny",
                  deny_message: "Not approved by the operator. Find another way or record the step as skipped.",
                },
          ]);
        }
        break;
      }
      case "user.tool_confirmation":
        answered.add(event.tool_use_id as string);
        break;
      case "span.outcome_evaluation_end":
        stats.outcomeEvaluations.push({ iteration: event.iteration, result: event.result, explanation: event.explanation });
        log(`\n[grader] iteration ${String(event.iteration)}: ${String(event.result)}\n  ${String(event.explanation)}\n`);
        break;
      case "session.error":
        stats.sessionErrors.push(event.error);
        log(`[session.error] ${JSON.stringify(event.error)}`);
        break;
      case "session.status_idle":
      case "session.status_terminated":
        if (isTerminal(event)) {
          stats.finalStopReason =
            event.type === "session.status_terminated" ? { type: "terminated" } : event.stop_reason;
          log(`[settled] ${JSON.stringify(stats.finalStopReason)}`);
        }
        break;
    }
  };

  for (let attempt = 0; ; attempt++) {
    try {
      const stream = await channel.stream();
      if (!kickedOff) {
        await options.kickoff?.();
        kickedOff = true;
      }

      // Catch up. Two passes: learn which calls already have answers, then
      // handle anything unseen, so a replayed call whose answer sits further
      // down the history is not executed a second time.
      const history: SessionEvent[] = [];
      for await (const event of channel.history()) history.push(event);
      for (const event of history) {
        if (event.type === "user.custom_tool_result") answered.add(event.custom_tool_use_id as string);
        if (event.type === "user.tool_confirmation") answered.add(event.tool_use_id as string);
      }
      for (const event of history) {
        if (seen.has(event.id)) continue;
        seen.add(event.id);
        await handle(event);
      }
      // Settled only if the LAST event is terminal: an earlier idle followed
      // by more work is history, not the end.
      const last = history.at(-1);
      if (last && isTerminal(last)) return;

      for await (const event of stream) {
        if (seen.has(event.id)) {
          if (isTerminal(event)) return;
          continue;
        }
        seen.add(event.id);
        await handle(event);
        if (isTerminal(event)) return;
      }
      throw new Error("event stream ended before the session settled");
    } catch (error) {
      if (attempt >= maxReconnects) throw error;
      stats.reconnects++;
      const wait = backoffMs(attempt);
      log(`[stream] ${String(error)}; reconnecting in ${wait}ms`);
      await sleep(wait);
    }
  }
}

export function isTerminal(event: SessionEvent): boolean {
  if (event.type === "session.status_terminated") return true;
  if (event.type === "session.status_idle") {
    return (event.stop_reason as { type?: string } | undefined)?.type !== "requires_action";
  }
  return false;
}

async function answerToolCall(
  channel: EventChannel,
  tools: ToolRunner,
  event: SessionEvent,
  stats: RunStats,
  log: (line: string) => void,
): Promise<void> {
  const name = String(event.name);
  const started = Date.now();
  const outcome = await tools.call(name, event.input);
  const millis = Date.now() - started;
  stats.toolCalls[name] = (stats.toolCalls[name] ?? 0) + 1;
  stats.toolMillis[name] = (stats.toolMillis[name] ?? 0) + millis;
  if (outcome.isError) stats.toolErrors[name] = (stats.toolErrors[name] ?? 0) + 1;
  log(`  [ariadne] ${name} ${preview(event.input)} -> ${outcome.isError ? "ERROR " : ""}${outcome.text.length} chars, ${millis}ms`);
  await channel.send([
    {
      type: "user.custom_tool_result",
      custom_tool_use_id: event.id,
      content: [{ type: "text", text: outcome.text }],
      is_error: outcome.isError,
    },
  ]);
}

export function preview(input: unknown, max = 160): string {
  const text = JSON.stringify(input ?? {});
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
