import assert from "node:assert/strict";
import { test } from "node:test";
import { parseArgs } from "../src/args.js";
import { helpText, helpData } from "../src/output.js";
import { main } from "../src/cli.js";

test("pricing action help offers reference mode only for supported actions", () => {
  for (const action of ["models", "calculate"]) {
    assert.ok(!helpData("pricing", action).action.options.some(o => o.name === "--api"));
    assert.doesNotMatch(helpText("pricing", undefined, action, true), /--api|reference/i);
  }
  for (const action of ["lookup", "cost", "market", "history"]) {
    assert.match(helpData("pricing", action).action.options.find(o => o.name === "--api").summary, /reference/i);
    assert.match(helpText("pricing", undefined, action, true), /--api/);
  }
});

for (const [topic, actions] of Object.entries({ pricing: ["models", "lookup", "calculate", "cost", "market", "history"],
  experiments: ["list", "estimate", "start", "get"], skill: ["install", "update"], skills: ["install", "update", "list"] })) {
  test(`${topic} actions have focused offline help in both spellings and JSON`, async () => {
    for (const action of actions) {
      for (const argv of [["help", topic, action], [topic, action, "--help"], ["--json", "help", topic, action]]) {
        const parsed = parseArgs(argv);
        assert.equal(parsed.topic, topic);
        assert.equal(parsed.action, action);
        const text = helpText(topic, undefined, action);
        assert.match(text, new RegExp(`Usage: metergraph ${topic} ${action}`));
        assert.match(text, /Examples:/);
        assert.match(text, /Options:/);
        const stdout = { text: "", write(s) { this.text += s; } };
        const stderr = { write() { assert.fail("help wrote to stderr"); } };
        assert.equal(await main([...argv, "--json"], { stdout, stderr }), 0);
        const result = JSON.parse(stdout.text);
        assert.equal(result.data.action.name, action);
        assert.ok(result.data.action.options.length > 0);
      }
    }
  });
}
test("read and list action help excludes mutation and unrelated action flags", () => {
  const get = helpData("experiments", "get").action;
  assert.ok(get.options.some(o => o.name === "--id"));
  assert.ok(!get.options.some(o => ["--treatment", "--last-n", "--limit"].includes(o.name)));
  assert.doesNotMatch(get.options.find(o => o.name === "--agent-token-file").summary, /Debug/);
  const skills = helpData("skills", "list").action;
  assert.ok(!skills.options.some(o => o.name === "--client"));
  const lookup = helpData("pricing", "lookup").action;
  assert.ok(!lookup.options.some(o => o.name.includes("tokens")));
});
test("unknown help topics fail without reflecting arbitrary input", () => {
  for (const argv of [["help", "secret-value"], ["help", "pricing", "secret-value"]]) {
    const parsed = parseArgs(argv);
    assert.equal(parsed.ok, false);
    assert.doesNotMatch(parsed.message, /secret-value/);
  }
});

test("default action help is focused; advanced help retains connection options", async () => {
  for (const [topic, action] of [["pricing", "lookup"], ["experiments", "get"]]) {
    const normal = helpText(topic, undefined, action);
    assert.doesNotMatch(normal, /^  --(?:url|config-dir|workspace|agent-token-file|timeout-ms|api)\b/m);
    const advanced = helpText(topic, undefined, action, true);
    assert.match(advanced, /^  --url\b/m);
    assert.match(advanced, /^  --timeout-ms\b/m);
    assert.equal(parseArgs(["help", topic, action, "--advanced"]).advanced, true);
    assert.equal(parseArgs([topic, action, "--help", "--advanced"]).advanced, true);
  }
  assert.doesNotMatch(helpText("pricing", undefined, "lookup"), /calculate|history/);
  assert.doesNotMatch(helpText("experiments", undefined, "get"), /Estimate writes|estimate|\bstart\b/);
  assert.match(helpText("pricing", undefined, "history"), /^  --url\b/m);
  assert.match(helpText("pricing", undefined, "history"), /^  --api\b/m);
  assert.doesNotMatch(helpText("setup"), /^  --config-dir\b/m);
  assert.match(helpText("setup", undefined, null, true), /^  --config-dir\b/m);
});
