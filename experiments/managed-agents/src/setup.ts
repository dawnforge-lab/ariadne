/**
 * `npm run setup` — create (first run) or update (later runs) the persistent
 * Managed Agents resources this experiment uses:
 *
 *   1. the four ariadne-* skills, uploaded as custom skills (a new version on
 *      re-run, so a skill edited in the repo reaches the agent);
 *   2. one cloud environment: limited networking, package managers allowed
 *      (the action-plan skill installs openpyxl), no other hosts;
 *   3. one agent: the system prompt from config.ts, the sandbox toolset with
 *      web tools off, the skills, and Ariadne's MCP tools as custom tools.
 *
 * IDs land in state.json. Nothing here runs per audit.
 *
 * Flags: --model <id>   (default claude-opus-5-5)
 *        --dry-run      print the agent definition and stop; needs no API key
 */
import { readdirSync, statSync, createReadStream } from "node:fs";
import { join, relative } from "node:path";
import { parseArgs } from "node:util";

import Anthropic, { toFile } from "@anthropic-ai/sdk";

import { AriadneRelay } from "./ariadne-relay.js";
import {
  AGENT_NAME,
  ARIADNE_ROOT,
  DEFAULT_MODEL,
  ENVIRONMENT_NAME,
  SKILLS_DIR,
  SKILL_NAMES,
  SYSTEM_PROMPT,
  customToolsFrom,
  databaseUrl,
  loadState,
  saveState,
} from "./config.js";

const { values: flags } = parseArgs({
  options: {
    model: { type: "string", default: DEFAULT_MODEL },
    "dry-run": { type: "boolean", default: false },
  },
});

async function main(): Promise<void> {
  const relay = await AriadneRelay.start({
    ariadneRoot: ARIADNE_ROOT,
    databaseUrl: databaseUrl(),
    // Setup only lists tools; nothing is crawled.
    allowedDomains: [],
  });
  const relayed = await relay.listTools().finally(() => relay.close());
  const customTools = customToolsFrom(relayed);
  console.log(`relay: ${customTools.length} Ariadne tools -> ${customTools.map((t) => t.name).join(", ")}`);

  const state = loadState();
  const toolset = {
    type: "agent_toolset_20260401" as const,
    default_config: { enabled: true, permission_policy: { type: "auto" as const } },
    configs: [
      { name: "web_fetch" as const, enabled: false },
      { name: "web_search" as const, enabled: false },
    ],
  };

  if (flags["dry-run"]) {
    console.log(
      JSON.stringify(
        {
          name: AGENT_NAME,
          model: flags.model,
          system: SYSTEM_PROMPT,
          skills: SKILL_NAMES.map((name) => ({ type: "custom", skill_id: `<${name}>`, version: "latest" })),
          tools: [toolset, ...customTools],
        },
        null,
        2,
      ),
    );
    return;
  }

  const client = new Anthropic();

  for (const name of SKILL_NAMES) {
    const files = await skillFiles(name);
    const existing = state.skills[name];
    if (existing) {
      const version = await client.skills.versions.create(existing, { files });
      console.log(`skill ${name}: new version ${version.id} of ${existing}`);
    } else {
      const skill = await client.skills.create({ files, display_name: name });
      state.skills[name] = skill.id;
      console.log(`skill ${name}: created ${skill.id}`);
    }
    saveState(state);
  }

  if (!state.environmentId) {
    const environment = await client.beta.environments.create({
      name: ENVIRONMENT_NAME,
      config: {
        type: "cloud",
        // No hosts: the sandbox reaches package registries (pip install
        // openpyxl) and nothing else. The engine is reached through custom
        // tools, which run on this machine, not from the sandbox.
        networking: { type: "limited", allow_package_managers: true },
      },
    });
    state.environmentId = environment.id;
    saveState(state);
    console.log(`environment: created ${environment.id}`);
  } else {
    console.log(`environment: reusing ${state.environmentId}`);
  }

  const definition = {
    name: AGENT_NAME,
    model: flags.model,
    system: SYSTEM_PROMPT,
    tools: [toolset, ...customTools],
    skills: SKILL_NAMES.map((name) => ({
      type: "custom" as const,
      skill_id: state.skills[name] as string,
      version: "latest",
    })),
  };

  if (state.agentId) {
    const current = await client.beta.agents.retrieve(state.agentId);
    const agent = await client.beta.agents.update(state.agentId, {
      ...definition,
      version: current.version,
    });
    state.agentVersion = agent.version;
    console.log(`agent: updated ${agent.id} to version ${agent.version}`);
  } else {
    const agent = await client.beta.agents.create(definition);
    state.agentId = agent.id;
    state.agentVersion = agent.version;
    console.log(`agent: created ${agent.id} version ${agent.version}`);
  }
  saveState(state);
  console.log("setup complete; run `npm run audit -- --site https://example.com/`");
}

/** Every file under skills/<name>/, named with the skill directory prefix. */
async function skillFiles(name: string) {
  const root = join(SKILLS_DIR, name);
  const paths: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir)) {
      const path = join(dir, entry);
      if (statSync(path).isDirectory()) walk(path);
      else paths.push(path);
    }
  };
  walk(root);
  return Promise.all(
    paths.map((path) =>
      toFile(createReadStream(path), `${name}/${relative(root, path)}`, {
        type: path.endsWith(".md") ? "text/markdown" : "text/plain",
      }),
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
