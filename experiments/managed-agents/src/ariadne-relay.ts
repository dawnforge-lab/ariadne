/**
 * The relay: Ariadne's own MCP server, started as a child process, with its
 * tools offered to a Managed Agents session as custom tools.
 *
 * Why MCP over stdio and not the HTTP API: the ariadne-* skills are written
 * against the MCP tool names and argument shapes, and `tools/list` hands us
 * exactly those names, descriptions and JSON schemas. Relaying them unchanged
 * means the skills read true inside the managed session with no translation
 * layer that could drift from the engine.
 *
 * The engine runs on THIS machine (it crawls from here, writes to the local
 * Postgres); only the judgement runs in Anthropic's sandbox. Each
 * `agent.custom_tool_use` becomes one `tools/call` here.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

/**
 * Tools the relay does not offer, and why.
 *
 * - `export_crawl` writes a file on the ENGINE's disk and answers with its
 *   path. The agent's sandbox cannot read that path, so the tool would hand
 *   the agent a file it cannot open. The action-plan skill pages
 *   `issue_urls` instead.
 * - `crawl_mark_failed` retires a crawl whose worker is gone. That is an
 *   operator decision about the engine's state, not an audit step.
 */
export const WITHHELD_TOOLS: Record<string, string> = {
  export_crawl:
    "writes a file on the engine host; the sandbox cannot read the path it returns",
  crawl_mark_failed: "operator-only: retires a crawl whose worker is gone",
};

export interface RelayedTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

export interface ToolCallOutcome {
  text: string;
  isError: boolean;
}

export interface RelayOptions {
  /** Ariadne repository root: where `src/api/mcp-serve.ts` lives. */
  ariadneRoot: string;
  databaseUrl: string;
  /** Hosts `crawl_start` may target (exact or `*.example.com`). */
  allowedDomains: string[];
  /** Where the engine's diagnostics go. Its stdout belongs to the protocol. */
  onStderr?: (line: string) => void;
}

export class AriadneRelay {
  private constructor(
    private readonly client: Client,
    private readonly transport: StdioClientTransport,
  ) {}

  static async start(options: RelayOptions): Promise<AriadneRelay> {
    const transport = new StdioClientTransport({
      command: "npx",
      args: ["tsx", "src/api/mcp-serve.ts"],
      cwd: options.ariadneRoot,
      env: {
        ...stringEnv(process.env),
        DATABASE_URL: options.databaseUrl,
        ARIADNE_ALLOWED_DOMAINS: options.allowedDomains.join(","),
      },
      stderr: "pipe",
    });
    const stderr = transport.stderr;
    if (stderr && options.onStderr) {
      let buffered = "";
      stderr.on("data", (chunk: Buffer) => {
        buffered += chunk.toString("utf8");
        let newline = buffered.indexOf("\n");
        while (newline >= 0) {
          options.onStderr?.(buffered.slice(0, newline));
          buffered = buffered.slice(newline + 1);
          newline = buffered.indexOf("\n");
        }
      });
    }
    const client = new Client({ name: "ariadne-managed-agents-relay", version: "0.0.1" });
    await client.connect(transport);
    return new AriadneRelay(client, transport);
  }

  /** The engine's tools, minus the withheld ones, in the engine's order. */
  async listTools(): Promise<RelayedTool[]> {
    const { tools } = await this.client.listTools();
    return tools
      .filter((tool) => !(tool.name in WITHHELD_TOOLS))
      .map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        inputSchema: cleanSchema(tool.inputSchema as Record<string, unknown>),
      }));
  }

  /**
   * One tool call, answered as text. An engine refusal (`isError: true`) is
   * passed through as an error result so the agent reads the engine's own
   * message; a transport failure is reported the same way rather than thrown,
   * because a thrown error here would strand the session waiting on a result.
   */
  async call(name: string, input: unknown): Promise<ToolCallOutcome> {
    if (name in WITHHELD_TOOLS) {
      return { text: `{"error": "${name} is not offered in this run: ${WITHHELD_TOOLS[name]}"}`, isError: true };
    }
    try {
      const result = await this.client.callTool({
        name,
        arguments: (input ?? {}) as Record<string, unknown>,
      });
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content
        .map((block: { type: string; text?: string }) =>
          block.type === "text" ? (block.text ?? "") : `[${block.type} content omitted]`,
        )
        .join("\n");
      return { text: text || "(empty result)", isError: result.isError === true };
    } catch (error) {
      return {
        text: JSON.stringify({ error: `relay failed to call ${name}: ${String(error)}` }),
        isError: true,
      };
    }
  }

  async close(): Promise<void> {
    await this.client.close();
    await this.transport.close();
  }
}

/** `$schema` is metadata the custom-tool schema has no use for. */
function cleanSchema(schema: Record<string, unknown>): Record<string, unknown> {
  const { $schema: _ignored, ...rest } = schema;
  return { type: "object", ...rest };
}

function stringEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
