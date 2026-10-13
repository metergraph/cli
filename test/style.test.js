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
  assert.match(stdout.text, /^✗ Sign in cannot run from a cloud runtime {2}\(unsupported, exit 6\)$/m);
  assert.match(stdout.text, /not which Metergraph service you sign in to/);
  assert.match(stdout.text, /^→ Signing in from this machine\? +metergraph login --runtime local$/m);
  assert.match(stdout.text, /^→ Connecting a cloud agent\? +https:\/\//m);
});
