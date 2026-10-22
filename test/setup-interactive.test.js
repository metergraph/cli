import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { PassThrough } from "node:stream";

import { parseArgs } from "../src/args.js";
import { main } from "../src/cli.js";
import {
  AGENT_KEY_COMMAND,
  agentAccessOffer,
  canAsk,
  commandLine,
  connectSteps,
  fillSetupArgv,
  fillLoginArgv,
  offerAgentAccess,
} from "../src/setup-interactive.js";
import { runCli } from "./helpers.js";

const WORKSPACE = "11111111-1111-4111-8111-111111111111";
const tty = { isTTY: true };
const dirs = [];
after(() => {
  for (const dir of dirs) fs.rmSync(dir, { recursive: true, force: true });
});

// Scripted answers; anything past the script is a cancel (Ctrl-D).
function scripted(answers) {
  const asked = [];
  const said = [];
  return {
    asked,
    said,
    ask: async (question) => {
      asked.push(question);
      return answers.length ? answers.shift() : null;
    },
    say: (...lines) => said.push(...lines),
    close: () => {},
  };
}

// remote is explicit: CI itself counts as a remote session.
const fill = (argv, answers, { found = false, saved = null, remote = false } = {}) => {
  const io = scripted(answers);
  const probed = [];
  const result = fillSetupArgv(argv, {
    ask: io.ask, say: io.say, remote, savedProfile: () => saved,
    probe: async (origin) => {
      probed.push(origin);
      return found;
    },
  });
  return result.then((filled) => ({ filled, probed, ...io }));
};

test("only a person at a terminal is asked: never --json, a pipe or CI", () => {
  assert.equal(canAsk(["setup"], { stdin: tty, stdout: tty, env: {} }), true);
  assert.equal(canAsk(["setup", "--json"], { stdin: tty, stdout: tty, env: {} }), false);
  assert.equal(canAsk(["setup"], { stdin: {}, stdout: tty, env: {} }), false);
  assert.equal(canAsk(["setup"], { stdin: tty, stdout: {}, env: {} }), false);
  assert.equal(canAsk(["setup"], { stdin: null, stdout: tty, env: {} }), false);
  assert.equal(canAsk(["setup"], { stdin: tty, stdout: tty, env: { CI: "true" } }), false);
});

test("bare setup with a local bundle running asks everything and defaults to the bundle", async () => {
  const { filled, said } = await fill(["setup"], ["", "", WORKSPACE.toUpperCase(), "y", ""], { found: true });
  assert.deepEqual(filled, ["setup", "--runtime", "local", "--deployment", "customer-local",
    "--url", "http://localhost:8080", "--workspace", WORKSPACE, "--confirm-prerequisites", "--client", "claude"]);
  assert.ok(said.includes("Found a Metergraph bundle at http://localhost:8080."));
  // Every prerequisite is shown before the person confirms them.
  assert.ok(said.some((line) => line.includes("bin/start")));
  const parsed = parseArgs(filled);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.deployment, "customer-local");
  assert.equal(parsed.confirmPrerequisites, true);
});

test("without a bundle the default is the hosted service, which needs only a client", async () => {
  const { filled, asked } = await fill(["setup"], ["", "2"]);
  assert.deepEqual(filled, ["setup", "--runtime", "local", "--client", "codex"]);
  assert.equal(asked.length, 2);
  assert.equal(parseArgs(filled).ok, true);
});

test("flags already given are kept and never asked for", async () => {
  const argv = ["setup", "--deployment", "customer-local", "--runtime", "local", "--url=http://127.0.0.1:8080"];
  const { filled, asked } = await fill(argv, [WORKSPACE, "y", "4"]);
  assert.deepEqual(filled, [...argv, "--workspace", WORKSPACE, "--confirm-prerequisites", "--skip-skill"]);
  assert.equal(asked.length, 3);
  assert.ok(!asked.some((question) => question.includes("Address")));
});

test("client choices accept their displayed labels without retrying", async () => {
  for (const [label, flags] of [
    ["Claude Code", ["--client", "claude"]],
    ["cLaUdE cOdE", ["--client", "claude"]],
    ["Codex", ["--client", "codex"]],
    ["Cursor", ["--client", "cursor"]],
    ["None (skip installing the skill)", ["--skip-skill"]],
    ["Skip skill installation", ["--skip-skill"]],
  ]) {
    const { filled, asked, said } = await fill(["setup", "--deployment", "managed"], [label]);
    assert.deepEqual(filled, ["setup", "--deployment", "managed", "--runtime", "local", ...flags]);
    assert.equal(asked.length, 1);
    assert.ok(!said.includes("Enter a number from 1 to 4."));
    assert.equal(parseArgs(filled).ok, true);
  }
});

test("a project set up before resumes its route without the deployment questions", async () => {
  const { filled, asked } = await fill(["setup"], ["1"], { saved: "local" });
  assert.deepEqual(filled, ["setup", "--runtime", "local", "--client", "claude"]);
  assert.equal(asked.length, 1);
});

test("unconfirmed prerequisites leave setup to report the first one", async () => {
  const { filled } = await fill(["setup", "--deployment", "customer-local"], ["", WORKSPACE, "n", "1"]);
  assert.ok(!filled.includes("--confirm-prerequisites"));
  assert.equal(parseArgs(filled).ok, true);
});

test("invalid answers are asked again", async () => {
  const { filled, said } = await fill(["setup"], ["9", "2", "localhost", "", "not-a-uuid", WORKSPACE, "y", "x", "3"]);
  assert.deepEqual(filled.slice(-7), ["--url", "http://localhost:8080", "--workspace", WORKSPACE,
    "--confirm-prerequisites", "--client", "cursor"]);
  assert.ok(said.includes("Enter a number from 1 to 4."));
  assert.ok(said.some((line) => line.startsWith("Enter an address")));
  assert.ok(said.some((line) => line.startsWith("A workspace ID looks like")));
});

test("the open source server also asks for its agent token file", async () => {
  const { filled } = await fill(["setup"], ["4", "http://localhost:8787", WORKSPACE, "relative", "/tmp/token", "y", "4"]);
  assert.deepEqual(filled.slice(filled.indexOf("--agent-token-file"), filled.indexOf("--agent-token-file") + 2),
    ["--agent-token-file", "/tmp/token"]);
  assert.equal(parseArgs(filled).ok, true);
});

test("a cancel at any question changes nothing", async () => {
  for (let answered = 0; answered < 5; answered += 1) {
    const answers = ["2", "", WORKSPACE, "y", "1"].slice(0, answered);
    const { filled } = await fill(["setup"], answers);
    assert.equal(filled, null, `cancelled after ${answered} answers`);
  }
});

test("a cancel at the deployment menu is a cancel even when the client was given", async () => {
  const { filled } = await fill(["setup", "--client", "codex"], []);
  assert.equal(filled, null);
});

test("a remote session sends no request before setup hands it off", async () => {
  const { filled, probed, said } = await fill(["setup"], ["", ""], { found: true, remote: true });
  assert.deepEqual(probed, []);
  assert.ok(!said.some((line) => line.startsWith("Found a Metergraph bundle")));
  assert.deepEqual(filled, ["setup", "--runtime", "local", "--client", "claude"]);
});

// A terminal for main(): answers are written to stdin as the person types.
function terminal() {
  const stdin = new PassThrough();
  stdin.isTTY = true;
  stdin.setRawMode = () => stdin;
  const written = [];
  const stdout = new PassThrough();
  stdout.isTTY = true;
  stdout.columns = 80;
  stdout.on("data", (chunk) => written.push(String(chunk)));
  const errors = [];
  const stderr = { isTTY: true, write: (value) => errors.push(String(value)) };
  return { stdin, stdout, stderr, text: () => written.join("") + errors.join("") };
}

test("a filled command that does not parse is never echoed", async () => {
  const secret = "mg_this_is_a_mistyped_credential_value";
  const io = terminal();
  const saved = process.env.CI;
  delete process.env.CI;
  try {
    // Nothing is asked: only --runtime is missing, and it is assumed.
    const code = await main(["setup", "--deployment", "managed", "--workspace", secret, "--client", "codex"], io);
    assert.equal(code, 2);
  } finally {
    if (saved !== undefined) process.env.CI = saved;
    io.stdin.end();
  }
  assert.ok(!io.text().includes(secret), "the refused value was printed");
  assert.ok(!io.text().includes("Running:"));
  assert.match(io.text(), /--workspace must be a workspace ID/);
});

test("the printed command reruns setup without questions", () => {
  assert.equal(commandLine(["setup", "--url", "http://localhost:8080", "--project", "my app"]),
    "metergraph setup --url http://localhost:8080 --project 'my app'");
});

test("an agent or script gets the flag error, never a question", async () => {
  const run = await runCli(["setup"], { timeoutMs: 10000 });
  assert.equal(run.code, 2);
  assert.match(run.stderr, /--runtime is required/);
  assert.ok(!run.stdout.includes("Where is Metergraph running?"));
});

// --- the bundle's agent key -------------------------------------------------

test("the offer's command is fixed by the CLI, never by the service", () => {
  const offer = agentAccessOffer("http://localhost:8080").offer;
  assert.equal(offer.command, AGENT_KEY_COMMAND);
  assert.equal(AGENT_KEY_COMMAND, "./bin/agent-key create --write-to ~/.config/metergraph/agent.env --role debug " +
    "--allow-evaluation-writes --allow-evaluation-previews --allow-analysis-starts");
  assert.equal(offer.keys_page_url, "http://localhost:8080/#api-keys");
  assert.equal(offer.requires_person_approval, true);
  assert.match(offer.message, /spend money/);
});

function bundle({ agentKey = true, mode = 0o755 } = {}) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "metergraph bundle ")));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, "bin"));
  fs.writeFileSync(path.join(dir, "bin", "start"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(dir, "docker-compose.yml"), "services: {}\n");
  fs.writeFileSync(path.join(dir, "metergraph-byoc-release.json"), "{}\n");
  if (agentKey) {
    fs.writeFileSync(path.join(dir, "bin", "agent-key"), "#!/bin/sh\n");
    fs.chmodSync(path.join(dir, "bin", "agent-key"), mode);
  }
  return dir;
}

// The platform is explicit so the offer's logic is tested on every runner;
// only the Windows test passes "win32".
async function offer(answers, options = {}) {
  const io = scripted(answers);
  const runs = [];
  await offerAgentAccess({
    client: "claude", origin: "http://localhost:8080", prompter: io, say: io.say, platform: "linux",
    run: async (command, args, cwd) => {
      runs.push({ command, args, cwd });
      return options.exitCode ?? 0;
    },
    ...options,
  });
  return { runs, ...io };
}

test("declining the offer runs nothing and says how to do it later", async () => {
  const { runs, said } = await offer(["n"]);
  assert.equal(runs.length, 0);
  assert.ok(said.some((line) => line.includes(AGENT_KEY_COMMAND)));
});

test("accepting runs the bundle's bin/agent-key, which asks for its own confirmation", { skip: process.platform === "win32" }, async () => {
  const dir = bundle();
  const { runs, said, asked } = await offer(["y", "/nowhere", dir, "y"]);
  // Setup names the exact program before running it.
  assert.ok(asked.includes(`Run ${path.join(dir, "bin", "agent-key")}? [y/N] `));
  assert.equal(runs.length, 1);
  assert.equal(runs[0].command, path.join(dir, "bin", "agent-key"));
  assert.equal(runs[0].cwd, dir);
  assert.deepEqual(runs[0].args, ["create", "--write-to", path.join(os.homedir(), ".config", "metergraph", "agent.env"),
    "--role", "debug", "--allow-evaluation-writes", "--allow-evaluation-previews", "--allow-analysis-starts"]);
  assert.ok(!runs[0].args.includes("--yes"), "the person confirms in bin/agent-key itself");
  assert.ok(said.some((line) => line.startsWith("That is not a started bundle")));
  assert.ok(said.some((line) => line.includes("claude mcp add-json")));
});

test("nothing in the current project is a default or runs without a typed path", { skip: process.platform === "win32" }, async () => {
  // A project directory that imitates a bundle, as a cloned repository could.
  const planted = bundle();
  const previous = process.cwd();
  process.chdir(planted);
  try {
    const { runs, asked } = await offer(["y", ""]);
    assert.equal(runs.length, 0);
    // The directory question offers no default, so an empty answer is asked again.
    assert.deepEqual(asked.filter((question) => question.startsWith("Bundle directory")),
      ["Bundle directory (the one you ran bin/start in): ", "Bundle directory (the one you ran bin/start in): "]);
  } finally {
    process.chdir(previous);
  }
});

test("declining to run the named program runs nothing", { skip: process.platform === "win32" }, async () => {
  const { runs } = await offer(["y", bundle(), "n"]);
  assert.equal(runs.length, 0);
});

test("a bin/agent-key other users can change is never run", { skip: process.platform === "win32" }, async () => {
  const dir = bundle({ mode: 0o777 });
  const { runs, said } = await offer(["y", dir, "y"]);
  assert.equal(runs.length, 0);
  assert.ok(said.some((line) => line.includes("other users can change it")));
});

test("an older bundle without bin/agent-key is sent to the Keys page", async () => {
  const dir = bundle({ agentKey: false });
  const { runs, said } = await offer(["y", dir]);
  assert.equal(runs.length, 0);
  assert.ok(said.some((line) => line.includes("http://localhost:8080/#api-keys")));
});

test("a failed bin/agent-key run says how to rerun it, with no connect steps", { skip: process.platform === "win32" }, async () => {
  const { said } = await offer(["y", bundle(), "y"], { exitCode: 1 });
  assert.ok(said.some((line) => line.startsWith("bin/agent-key did not finish")));
  assert.ok(!said.some((line) => line.includes("mcp add")));
});

test("on Windows the command is printed for WSL and nothing is asked or run", async () => {
  const { runs, asked, said } = await offer(["y", bundle(), "y"], { platform: "win32" });
  assert.equal(runs.length, 0);
  assert.equal(asked.length, 0);
  assert.ok(said.some((line) => line.includes("inside WSL") && line.includes(AGENT_KEY_COMMAND)));
});

test("connect steps name the variable, never a token", () => {
  const claude = connectSteps("claude", "http://localhost:8080", "/home/me/.config/metergraph/agent.env").join("\n");
  assert.match(claude, /"Authorization":"Bearer \$\{METERGRAPH_AGENT_TOKEN\}"/);
  assert.match(claude, /http:\/\/localhost:8080\/v1\/agent\/mcp/);
  const codex = connectSteps("codex", "http://localhost:8080", "/f").join("\n");
  assert.match(codex, /--bearer-token-env-var METERGRAPH_AGENT_TOKEN/);
  const other = connectSteps(null, "http://localhost:8080", "/f").join("\n");
  assert.match(other, /README/);
});


test("remote terminals and redirected stderr never ask questions", () => {
  for (const env of [{ SSH_CONNECTION: "yes" }, { CODESPACES: "true" }, { CI: "true" }]) {
    assert.equal(canAsk(["setup"], { stdin: tty, stdout: tty, env }), false);
  }
  assert.equal(canAsk(["setup"], { stdin: tty, stdout: tty, stderr: {}, env: {} }), false);
});

test("local login only fills a missing runtime after validation", () => {
  assert.deepEqual(fillLoginArgv(["login"]), ["login", "--runtime", "local"]);
  for (const argv of [["login", "--runtime", "cloud"], ["login", "--workspace", "invalid"], ["setup"], ["login", "--help"]]) {
    assert.deepEqual(fillLoginArgv(argv), argv);
  }
});
