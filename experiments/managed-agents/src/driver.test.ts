/**
 * The session loop against a scripted session: no API key, no engine.
 * Run with `npm test`.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { drive, newStats, type EventChannel, type SessionEvent } from "./driver.js";

const idle = (id: string, stop: string): SessionEvent => ({
  id,
  type: "session.status_idle",
  stop_reason: { type: stop },
});
const toolUse = (id: string, name: string, input: unknown = {}): SessionEvent => ({
  id,
  type: "agent.custom_tool_use",
  name,
  input,
});

/**
 * One scripted connection per `stream()` call. A connection is a list of
 * events, optionally ending in a thrown error (a dropped stream). `history`
 * is what `events.list` returns at that moment: the events before the
 * connection plus everything the client sent.
 */
class FakeSession implements EventChannel {
  readonly sent: Array<Record<string, unknown>> = [];
  readonly log: SessionEvent[] = [];
  opened = 0;
  constructor(private readonly connections: Array<{ before?: SessionEvent[]; live: SessionEvent[]; drop?: boolean }>) {}

  async stream(): Promise<AsyncIterable<SessionEvent>> {
    const connection = this.connections[this.opened++];
    if (!connection) throw new Error("no more scripted connections");
    for (const event of connection.before ?? []) this.log.push(event);
    const log = this.log;
    return (async function* () {
      for (const event of connection.live) {
        log.push(event);
        yield event;
      }
      if (connection.drop) throw new Error("socket hang up");
    })();
  }

  async *history(): AsyncIterable<SessionEvent> {
    yield* [...this.log];
  }

  async send(events: Array<Record<string, unknown>>): Promise<void> {
    for (const event of events) {
      this.sent.push(event);
      this.log.push({ id: `sent_${this.sent.length}`, ...event } as SessionEvent);
    }
  }
}

function recordingTools() {
  const calls: Array<{ name: string; input: unknown }> = [];
  return {
    calls,
    async call(name: string, input: unknown) {
      calls.push({ name, input });
      return name === "crawl_start"
        ? { text: '{"error":"host not permitted"}', isError: true }
        : { text: `{"ok":"${name}"}`, isError: false };
    },
  };
}

const quiet = { log: () => undefined, backoffMs: () => 0 };

test("answers each custom tool call once, kicks off after the stream opens, stops on end_turn", async () => {
  const session = new FakeSession([
    {
      live: [
        toolUse("sevt_1", "crawl_status", { crawlId: "c1" }),
        idle("sevt_2", "requires_action"),
        { id: "sevt_3", type: "agent.message", content: [{ type: "text", text: "done" }] },
        idle("sevt_4", "end_turn"),
      ],
    },
  ]);
  const tools = recordingTools();
  const stats = newStats();
  let kickoffs = 0;
  let openedAtKickoff = -1;
  await drive({
    channel: session,
    tools,
    stats,
    kickoff: async () => {
      kickoffs++;
      openedAtKickoff = session.opened;
    },
    approve: async () => false,
    ...quiet,
  });
  assert.equal(kickoffs, 1);
  assert.equal(openedAtKickoff, 1, "kickoff is sent after the stream is open");
  assert.deepEqual(tools.calls, [{ name: "crawl_status", input: { crawlId: "c1" } }]);
  assert.deepEqual(session.sent[0], {
    type: "user.custom_tool_result",
    custom_tool_use_id: "sevt_1",
    content: [{ type: "text", text: '{"ok":"crawl_status"}' }],
    is_error: false,
  });
  assert.deepEqual(stats.finalStopReason, { type: "end_turn" });
});

test("engine refusals go back as error results", async () => {
  const session = new FakeSession([{ live: [toolUse("sevt_1", "crawl_start"), idle("sevt_2", "end_turn")] }]);
  const stats = newStats();
  await drive({ channel: session, tools: recordingTools(), stats, approve: async () => false, ...quiet });
  assert.equal(session.sent[0]?.is_error, true);
  assert.equal(stats.toolErrors.crawl_start, 1);
});

test("a dropped stream reconnects, answers a call that arrived while away, and repeats nothing", async () => {
  const session = new FakeSession([
    // Connection 1: one call, answered, then the socket drops.
    { live: [toolUse("sevt_1", "crawl_status")], drop: true },
    // While disconnected the agent asked for another tool. Connection 2's
    // live stream replays it (already handled via history) and settles.
    {
      before: [toolUse("sevt_5", "issues_list")],
      live: [toolUse("sevt_5", "issues_list"), idle("sevt_6", "end_turn")],
    },
  ]);
  const tools = recordingTools();
  const stats = newStats();
  let kickoffs = 0;
  await drive({
    channel: session,
    tools,
    stats,
    kickoff: async () => {
      kickoffs++;
    },
    approve: async () => false,
    ...quiet,
  });
  assert.equal(kickoffs, 1, "the outcome is sent once, not again on reconnect");
  assert.equal(stats.reconnects, 1);
  assert.deepEqual(
    tools.calls.map((c) => c.name),
    ["crawl_status", "issues_list"],
    "each call executed exactly once",
  );
});

test("on reattach, a call already answered in history is not executed again", async () => {
  const session = new FakeSession([
    {
      before: [
        toolUse("sevt_1", "crawl_status"),
        { id: "sevt_2", type: "user.custom_tool_result", custom_tool_use_id: "sevt_1" },
        toolUse("sevt_3", "pages_query"),
      ],
      live: [idle("sevt_4", "end_turn")],
    },
  ]);
  const tools = recordingTools();
  await drive({ channel: session, tools, stats: newStats(), approve: async () => false, ...quiet });
  assert.deepEqual(tools.calls.map((c) => c.name), ["pages_query"]);
});

test("an earlier idle in history does not end the run; a terminal last event does", async () => {
  const session = new FakeSession([
    {
      before: [idle("sevt_1", "end_turn"), toolUse("sevt_2", "crawl_status")],
      live: [idle("sevt_3", "end_turn")],
    },
  ]);
  const tools = recordingTools();
  await drive({ channel: session, tools, stats: newStats(), approve: async () => false, ...quiet });
  assert.deepEqual(tools.calls.map((c) => c.name), ["crawl_status"]);

  const settled = new FakeSession([{ before: [idle("sevt_1", "budget_reached")], live: [] }]);
  const stats = newStats();
  await drive({ channel: settled, tools: recordingTools(), stats, approve: async () => false, ...quiet });
  assert.deepEqual(stats.finalStopReason, { type: "budget_reached" });
});

test("a paused sandbox call is denied when not approved, allowed when approved", async () => {
  const ask = (id: string): SessionEvent => ({
    id,
    type: "agent.tool_use",
    name: "bash",
    input: { command: "pip install openpyxl" },
    evaluated_permission: "ask",
  });
  const denied = new FakeSession([{ live: [ask("sevt_1"), idle("sevt_2", "end_turn")] }]);
  const stats = newStats();
  await drive({ channel: denied, tools: recordingTools(), stats, approve: async () => false, ...quiet });
  assert.equal(denied.sent[0]?.result, "deny");
  assert.equal(denied.sent[0]?.tool_use_id, "sevt_1");
  assert.equal(stats.confirmations.denied, 1);

  const allowed = new FakeSession([{ live: [ask("sevt_1"), idle("sevt_2", "end_turn")] }]);
  await drive({ channel: allowed, tools: recordingTools(), stats: newStats(), approve: async () => true, ...quiet });
  assert.deepEqual(allowed.sent[0], { type: "user.tool_confirmation", tool_use_id: "sevt_1", result: "allow" });
});

test("gives up after the reconnect limit", async () => {
  const session = new FakeSession([
    { live: [], drop: true },
    { live: [], drop: true },
  ]);
  await assert.rejects(
    drive({ channel: session, tools: recordingTools(), stats: newStats(), approve: async () => false, maxReconnects: 1, ...quiet }),
  );
});
