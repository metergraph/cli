import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

import { resolveProject } from "./auth-binding.js";
import { runDoctor } from "./doctor.js";
import { handoffPages, shellArg } from "./environment.js";
import { prerequisitesFor } from "./setup-deployment.js";
import { readSetupState } from "./setup-state.js";

// Setup asks for what it is missing only when a person is at a terminal: no
// --json, stdin and stdout both terminals, and not CI. An agent or a script
// never gets a question, so nothing waits on input that will never come; it
// keeps the flag errors and the next_action contract. The answers become the
// same flags a script would pass, and the full command is printed so it can
// be rerun without questions.

// The setup parse failures a question can answer. Any other failure, such as
// an invalid value or two conflicting flags, is reported as it is.
export const ASKABLE = new Set([
  "missing_runtime", "non_hosted_origin_required", "non_hosted_workspace_required", "client_required",
]);

export const LOCAL_BUNDLE_ORIGIN = "http://localhost:8080";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROBE_TIMEOUT_MS = 1500;

const DEPLOYMENTS = [
  ["managed", "Metergraph cloud (app.metergraph.dev)"],
  ["customer-local", "The Metergraph bundle running on this machine"],
  ["byoc", "Your company's Metergraph installation on AWS"],
  ["oss", "The open source Metergraph server"],
];
const CLIENTS = [
  ["claude", "Claude Code"],
  ["codex", "Codex"],
  ["cursor", "Cursor"],
  [null, "None (skip installing the skill)"],
];
const URL_QUESTIONS = {
  "customer-local": "Address of the bundle",
  byoc: "HTTPS address of the installation",
  oss: "Address of the server",
};
const WORKSPACE_QUESTIONS = {
  "customer-local": "Workspace ID (./bin/status in the bundle directory prints it)",
  byoc: "Workspace ID (shown on the installation's Settings page)",
  oss: "Workspace ID",
};

export function canAsk(argv, { stdin, stdout, env = process.env }) {
  return !argv.includes("--json") && Boolean(stdin?.isTTY) && Boolean(stdout?.isTTY) && !env.CI;
}

// Questions on the terminal. ask resolves with the trimmed answer, or null
// once the person presses Ctrl-C or Ctrl-D, after which every ask is null.
export function terminalPrompter(stdin, stdout) {
  const lines = createInterface({ input: stdin, output: stdout, terminal: true });
  const stop = new AbortController();
  let closed = false;
  lines.on("SIGINT", () => stop.abort());
  lines.on("close", () => {
    closed = true;
    stop.abort();
  });
  return {
    async ask(question) {
      if (stop.signal.aborted) return null;
      try {
        return (await lines.question(question, { signal: stop.signal })).trim();
      } catch {
        return null;
      }
    },
    close() {
      if (!closed) lines.close();
    },
  };
}

// Resolves with argv plus the flags the answers stand for, or null when the
// person cancelled. Flags already given are never asked for or changed.
export async function fillSetupArgv(argv, { ask, say, probe = probeLocalBundle, savedProfile = savedSetupProfile }) {
  const has = (flag) => argv.some((arg) => arg === flag || arg.startsWith(`${flag}=`));
  const added = [];
  // A person at a terminal runs setup for a coding agent on this machine.
  // Over SSH or in a cloud workspace, setup itself still hands off.
  if (!has("--runtime")) added.push("--runtime", "local");

  let deployment = valueOf(argv, "--deployment");
  // A rerun in a project set up before resumes that route without asking.
  if (deployment === undefined && savedProfile(valueOf(argv, "--project")) === null) {
    const found = await probe(LOCAL_BUNDLE_ORIGIN);
    if (found) say(`Found a Metergraph bundle at ${LOCAL_BUNDLE_ORIGIN}.`);
    deployment = await choose(ask, say, "Where is Metergraph running?", DEPLOYMENTS,
      found ? "customer-local" : "managed");
    if (deployment === null) return null;
    if (deployment !== "managed") added.push("--deployment", deployment);
  }

  if (deployment !== undefined && deployment !== "managed") {
    if (!has("--url")) {
      const url = await askFor(ask, say, URL_QUESTIONS[deployment], {
        fallback: deployment === "customer-local" ? LOCAL_BUNDLE_ORIGIN : null,
        valid: (value) => /^https?:\/\/\S+$/.test(value),
        retry: "Enter an address that starts with http:// or https://.",
      });
      if (url === null) return null;
      added.push("--url", url);
    }
    if (!has("--workspace")) {
      const workspace = await askFor(ask, say, WORKSPACE_QUESTIONS[deployment], {
        valid: (value) => UUID.test(value),
        retry: "A workspace ID looks like 11111111-1111-4111-8111-111111111111.",
      });
      if (workspace === null) return null;
      added.push("--workspace", workspace.toLowerCase());
    }
    if (deployment === "oss" && !has("--agent-token-file")) {
      const file = await askFor(ask, say, "Absolute path to a private file holding one MG_AGENT_TOKENS value", {
        valid: (value) => path.isAbsolute(value),
        retry: "Enter an absolute path, for example /home/me/.config/metergraph/oss-agent-token.",
      });
      if (file === null) return null;
      added.push("--agent-token-file", file);
    }
    if (!has("--confirm-prerequisites")) {
      say("", "Setup connects to an installation that is already running. It needs these done first:");
      // Except on the open source server, setup signs in for its own
      // Metadata access, so that one is not the person's to confirm.
      for (const { name, guide } of prerequisitesFor(deployment)) {
        if (name !== "metadata_agent_credential" || deployment === "oss") say(`  - ${guide}`);
      }
      const done = await yesNo(ask, "Are they all done? [y/N] ");
      if (done === null) return null;
      // Without it, setup reports the first pending prerequisite.
      if (done) added.push("--confirm-prerequisites");
    }
  }

  if (!has("--client") && !has("--skip-skill")) {
    const client = await choose(ask, say, "Install the Metergraph skill for which coding agent?", CLIENTS, "claude");
    if (client === undefined) return null;
    if (client === null) added.push("--skip-skill");
    else added.push("--client", client);
  }
  return [...argv, ...added];
}

export function commandLine(argv) {
  return ["metergraph", ...argv.map(shellArg)].join(" ");
}

function valueOf(argv, flag) {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === flag) return argv[index + 1];
    if (argv[index].startsWith(`${flag}=`)) return argv[index].slice(flag.length + 1);
  }
  return undefined;
}

// A numbered menu. Resolves with the chosen value, or undefined on cancel
// (null is a valid choice: no client).
async function choose(ask, say, question, options, fallback) {
  say("", question);
  options.forEach(([, label], index) => say(`  ${index + 1}) ${label}`));
  const fallbackIndex = options.findIndex(([value]) => value === fallback) + 1;
  for (;;) {
    const answer = await ask(`Choose 1-${options.length} [${fallbackIndex}]: `);
    if (answer === null) return undefined;
    const index = answer === "" ? fallbackIndex : Number(answer);
    if (Number.isInteger(index) && index >= 1 && index <= options.length) return options[index - 1][0];
    say(`Enter a number from 1 to ${options.length}.`);
  }
}

async function askFor(ask, say, question, { fallback = null, valid, retry }) {
  for (;;) {
    const answer = await ask(fallback === null ? `${question}: ` : `${question} [${fallback}]: `);
    if (answer === null) return null;
    const value = answer === "" ? fallback : answer;
    if (value !== null && valid(value)) return value;
    say(retry);
  }
}

async function yesNo(ask, question) {
  const answer = await ask(question);
  if (answer === null) return null;
  return ["y", "yes"].includes(answer.toLowerCase());
}

async function probeLocalBundle(origin) {
  try {
    const { report } = await runDoctor({ origin, timeoutMs: PROBE_TIMEOUT_MS });
    return report?.deployment_profile === "local";
  } catch {
    return false;
  }
}

function savedSetupProfile(project) {
  try {
    return readSetupState(resolveProject(project))?.value.deployment_profile ?? null;
  } catch {
    return null;
  }
}

// --- Access for the coding agent on the customer-local bundle ---------------

// Setup signs the agent in with Metadata access only. On the customer-local
// bundle, bin/agent-key issues a broader key without a sign in and writes it
// to a private file, never printing it. The command text is fixed here, not
// taken from the service, so an origin cannot choose what a person is asked
// to run.
export const AGENT_KEY_FILE = "~/.config/metergraph/agent.env";
const AGENT_KEY_GRANTS = [
  "--role", "debug", "--allow-evaluation-writes", "--allow-evaluation-previews", "--allow-analysis-starts",
];
export const AGENT_KEY_COMMAND = ["./bin/agent-key", "create", "--write-to", AGENT_KEY_FILE, ...AGENT_KEY_GRANTS].join(" ");

export function agentAccessOffer(origin) {
  return {
    role: "metadata",
    offer: {
      kind: "bundle_agent_key",
      run_in: "bundle_directory",
      command: AGENT_KEY_COMMAND,
      requires_person_approval: true,
      keys_page_url: handoffPages(origin).keys_url,
      message: "The agent has Metadata access. To let it write evaluations and start analyses, " +
        "ask the person which access they want, then they run this command in the bundle directory, " +
        "or the agent runs it with --yes after they agree. The Debug role reads captured prompts and " +
        "responses, and analysis starts send captured content to the person's model provider and spend " +
        "money. The command writes the key to the named private file and never prints it. A bundle " +
        "without bin/agent-key uses the Keys page instead.",
    },
  };
}

// After a customer-local setup at a terminal: offer to run bin/agent-key
// now. It shows what it grants and asks for its own confirmation. Setup runs
// in the person's project, which may be a repository they did not write, so
// nothing there is ever a default: the person types the bundle directory, it
// must look like a started bundle, and setup names the exact program and asks
// before running it.
const BUNDLE_MARKERS = [["bin", "start"], ["docker-compose.yml"], ["metergraph-byoc-release.json"]];

export async function offerAgentAccess({ client, origin, prompter, say, run = runInherited }) {
  say("", "Your coding agent has Metadata access. It can also write evaluations and start analyses.",
    "That reads captured prompts and responses, and an analysis sends captured content to your model",
    "provider and spends money on your account.");
  const wanted = await yesNo(prompter.ask, "Give it that access now? [y/N] ");
  if (!wanted) {
    say(`Later, run this in the bundle directory: ${AGENT_KEY_COMMAND}`);
    return;
  }
  const answer = await askFor(prompter.ask, say, "Bundle directory (the one you ran bin/start in)", {
    valid: (value) => BUNDLE_MARKERS.every((parts) => fs.existsSync(path.join(expandHome(value), ...parts))),
    retry: "That is not a started bundle (it needs bin/start, docker-compose.yml and the release manifest).",
  });
  if (answer === null) return;
  const bundle = fs.realpathSync(expandHome(answer));
  const command = path.join(bundle, "bin", "agent-key");
  if (!fs.existsSync(command)) {
    say("This bundle has no bin/agent-key. Create the key on the Keys page instead:",
      `  ${handoffPages(origin).keys_url}`);
    return;
  }
  const problem = untrustedProgram(command);
  if (problem !== null) {
    say(`Not running ${command}: ${problem}.`);
    return;
  }
  const confirmed = await yesNo(prompter.ask, `Run ${command}? [y/N] `);
  if (!confirmed) {
    say(`Later, run this in the bundle directory: ${AGENT_KEY_COMMAND}`);
    return;
  }
  prompter.close();
  const file = path.join(os.homedir(), ".config", "metergraph", "agent.env");
  const code = await run(command, ["create", "--write-to", file, ...AGENT_KEY_GRANTS], bundle);
  if (code !== 0) {
    say(`bin/agent-key did not finish. Run it again from ${bundle}: ${AGENT_KEY_COMMAND}`);
    return;
  }
  say("", ...connectSteps(client, origin, file));
}

// Only a regular file the person owns and nobody else can change is run.
function untrustedProgram(command) {
  const info = fs.lstatSync(command);
  if (!info.isFile()) return "it is not a regular file";
  if (typeof process.getuid === "function" && info.uid !== process.getuid()) return "it is owned by another user";
  if (info.mode & 0o022) return "other users can change it";
  return null;
}

// How the person connects their agent to the key: load the file where the
// agent starts, and name the variable (never the token) in its MCP settings.
export function connectSteps(client, origin, file) {
  const mcp = `${origin}/v1/agent/mcp`;
  const steps = [`Load the key in the shell that starts your agent: . ${shellArg(file)}`];
  if (client === "claude") {
    steps.push("Add the MCP server to Claude Code (it saves the variable name, not the token):",
      `  claude mcp add-json --scope user metergraph '${JSON.stringify({
        type: "http", url: mcp, headers: { Authorization: "Bearer ${METERGRAPH_AGENT_TOKEN}" } })}'`);
  } else if (client === "codex") {
    steps.push("Add the MCP server to Codex (it saves the variable name, not the token):",
      `  codex mcp add metergraph --url ${mcp} --bearer-token-env-var METERGRAPH_AGENT_TOKEN`);
  } else {
    steps.push("Add the MCP server as the bundle README's 'Let your coding agent run analyses' section shows.");
  }
  steps.push("Then restart the agent.");
  return steps;
}

function expandHome(value) {
  return value === "~" || value.startsWith("~/") ? path.join(os.homedir(), value.slice(1)) : value;
}

function runInherited(command, args, cwd) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { cwd, stdio: "inherit" });
    child.on("error", () => resolve(1));
    child.on("close", (code) => resolve(code ?? 1));
  });
}
