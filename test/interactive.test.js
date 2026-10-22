import assert from "node:assert/strict";
import { test } from "node:test";
import { PassThrough } from "node:stream";
import { interactiveArgs, chooseClient } from "../src/interactive.js";
import { parseArgs } from "../src/args.js";
import { main } from "../src/cli.js";

function io() {
  return { stdout: { isTTY: true }, stdin: { isTTY: true }, stderr: { isTTY: true, text: "", write(s) { this.text += s; } }, env: {} };
}
test("local setup supplies the runtime and only the chosen client", async () => {
  for (const client of ["codex", "claude", "cursor", "skip"]) {
    const streams = io();
    const argv = await interactiveArgs(["setup"], { ...streams, choose: async () => client });
    const parsed = parseArgs(argv);
    assert.equal(parsed.ok, true);
    assert.equal(parsed.runtime, "local");
    assert.equal(parsed.client, client === "skip" ? null : client);
    assert.equal(parsed.skipSkill, client === "skip");
    assert.match(streams.stderr.text, /Browser approval/);
  }
});
test("explicit options, automation and invalid commands never prompt", async () => {
  const cases = [
    [["setup", "--runtime", "local", "--client", "cursor"], {}],
    [["setup", "--json"], {}], [["setup", "--help"], {}],
    [["setup", "--client", "invalid"], {}], [["setup", "--unknown"], {}],
    [["setup", "--deployment", "byoc"], {}],
    [["setup"], { env: { CI: "1" } }], [["setup"], { env: { SSH_CONNECTION: "yes" } }],
    [["setup"], { env: { CODESPACES: "true" } }],
    [["setup"], { stdin: { isTTY: false } }], [["setup"], { stdout: { isTTY: false } }], [["setup"], { stderr: { isTTY: false } }],
  ];
  for (const [argv, overrides] of cases) {
    const streams = { ...io(), ...overrides, choose: () => assert.fail("unexpected prompt") };
    assert.deepEqual(await interactiveArgs(argv, streams), argv);
  }
});
test("login infers local only in a local terminal; cancellation never executes setup", async () => {
  assert.deepEqual(await interactiveArgs(["login"], io()), ["login", "--runtime", "local"]);
  const streams = io();
  const stdout = { isTTY: true, text: "", write(s) { this.text += s; } };
  assert.equal(await main(["setup"], { ...streams, stdout, choose: async () => null }), 17);
  assert.equal(stdout.text, "");
  assert.match(streams.stderr.text, /cancelled. Nothing was changed/);
});
test("real selection retries invalid input and closes cleanly on EOF or Ctrl+C", async () => {
  for (const input of ["wrong\nconstructor\n2\n", "\u0003", null]) {
    const stdin = new PassThrough();
    const stderr = new PassThrough();
    let output = "";
    stderr.on("data", data => { output += data; });
    const pending = chooseClient({ stdin, stderr });
    if (input === null) stdin.end();
    else stdin.write(input);
    assert.equal(await pending, input === "wrong\nconstructor\n2\n" ? "claude" : null);
    if (input === "wrong\nconstructor\n2\n") assert.match(output, /Choose Codex/);
    stdin.destroy();
    stderr.destroy();
  }
});
