import assert from "node:assert/strict";
import { test } from "node:test";
import { main } from "../src/cli.js";
import { createStyle } from "../src/style.js";

const ESC = "\u001b[";

function capture(isTTY) {
  const out = { text: "", isTTY, columns: 80, write(chunk) { out.text += chunk; return true; } };
  return out;
}

test("color only on a terminal, never with NO_COLOR, and on with FORCE_COLOR", () => {
  assert.equal(createStyle({ isTTY: false }, {}).red("x"), "x");
  assert.equal(createStyle({ isTTY: true }, { NO_COLOR: "1" }).red("x"), "x");
  assert.equal(createStyle({ isTTY: true }, { TERM: "dumb" }).red("x"), "x");
  assert.ok(createStyle({ isTTY: true }, {}).red("x").startsWith(ESC));
  assert.ok(createStyle({ isTTY: false }, { FORCE_COLOR: "1" }).red("x").startsWith(ESC));
});

test("prose wraps only on a terminal", () => {
  assert.equal(createStyle({ isTTY: false }, {}).width, Infinity);
  assert.equal(createStyle({ isTTY: true, columns: 60 }, {}).width, 58);
});

test("login --runtime cloud explains the flag and names the local command", async () => {
  const stdout = capture(false);
  const stderr = capture(false);
  const code = await main(["login", "--runtime", "cloud"], { stdout, stderr });
  assert.equal(code, 6);
  assert.ok(!stdout.text.includes(ESC), "piped output has no escape codes");
  assert.match(stdout.text, /^✗ Sign in cannot run from a cloud runtime$/m);
  assert.match(stdout.text, /not which Metergraph service you sign in to/);
  assert.match(stdout.text, /^→ Signing in from this machine\? +metergraph login --runtime local$/m);
  assert.match(stdout.text, /^→ Connecting a cloud agent\? +https:\/\//m);
});

test("human help is task-oriented; exit codes and agent details are opt-in", async () => {
  const stdout = capture(false);
  const stderr = capture(false);
  assert.equal(await main([], { stdout, stderr }), 0);
  assert.match(stdout.text, /Get started[\s\S]*Explore[\s\S]*Manage/);
  assert.doesNotMatch(stdout.text, /Exit codes:|Where the agent runs:/);
  assert.match(stdout.text, /metergraph setup --runtime local --client codex/);
  const reference = capture(false);
  assert.equal(await main(["help", "exit-codes"], { stdout: reference, stderr }), 0);
  assert.match(reference.text, /Exit codes:/);
  assert.match(reference.text, /authentication_required/);
  const agents = capture(false);
  assert.equal(await main(["help", "agents"], { stdout: agents, stderr }), 0);
  assert.match(agents.text, /METERGRAPH_AGENT_TOKEN/);
});

test("narrow help wraps option descriptions and piped help preserves columns", async () => {
  const stdout = capture(true);
  stdout.columns = 60;
  const stderr = capture(false);
  assert.equal(await main(["doctor", "--help"], { stdout, stderr }), 0);
  const plain = stdout.text.replace(/\u001b\[[0-9;]*m/g, "");
  assert.ok(plain.split("\n").every(line => line.length <= 58));
  const piped = capture(false);
  await main([], { stdout: piped, stderr });
  assert.match(piped.text, /^  setup {2,}Connect/m);
});
