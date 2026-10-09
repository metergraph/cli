import assert from "node:assert/strict";
import { test } from "node:test";

import { handsOff } from "../src/approval-handoff.js";

test("only login and setup with --json --no-browser run as a detached waiter, and never twice", () => {
  const login = ["login", "--runtime", "local"];
  const setup = ["setup", "--runtime", "local", "--client", "codex"];
  assert.equal(handsOff([...login, "--json", "--no-browser"], {}), true);
  assert.equal(handsOff(["--json", ...setup, "--no-browser"], {}), true);
  for (const argv of [
    [...login, "--no-browser"],
    [...login, "--json"],
    [...setup, "--json"],
    ["verify", "--json", "--no-browser"],
    ["doctor", "--json"],
    ["setup", "--json", "--no-browser"],
    ["login", "--json", "--no-browser", "--runtime", "local", "--bogus"],
  ]) {
    assert.equal(handsOff(argv, {}), false, argv.join(" "));
  }
  assert.equal(handsOff([...login, "--json", "--no-browser"], { METERGRAPH_APPROVAL_WAITER: "1" }), false);
});
