import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";

import { parseArgs } from "../src/args.js";
import { helpData, helpText } from "../src/output.js";
import { main } from "../src/cli.js";

const since = "2026-01-01T12:00:00Z";
const until = "2026-01-01T12:01:00Z";

test("verify requires one exact identity and a bounded invocation window", () => {
  const base = ["verify", "--since", since, "--until", until];
  assert.equal(parseArgs(base).code, "invalid_trace_identity");
  assert.equal(parseArgs([...base, "--trace-id", "one", "--request-id", "two"]).code, "invalid_trace_identity");
  assert.equal(parseArgs(["verify", "--trace-id", "one"]).code, "invalid_invocation_window");
  assert.equal(parseArgs([...base, "--trace-id", "not safe!"]).code, "invalid_trace_identity");
  const parsed = parseArgs([...base, "--trace-id", "trace-123", "--source", "synthetic", "--poll-ms", "500", "--max-attempts", "2", "--open", "--json"]);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.traceId, "trace-123");
  assert.equal(parsed.source, "synthetic");
  assert.equal(parsed.pollIntervalMs, 500);
  assert.equal(parsed.maxAttempts, 2);
  assert.equal(parsed.open, true);
  assert.equal(parsed.json, true);
});

test("verify help exposes exact identity and the workspace-safe open limit", () => {
  assert.match(helpText("verify"), /verified workspace/i);
  assert.ok(helpData(null).commands.some((entry) => entry.name === "verify"));
  assert.match(helpText(null), /metergraph verify \[options\]/);
});

test("verify without a saved grant returns one structured refusal", async () => {
  const project = mkdtempSync(path.join(tmpdir(), "metergraph-verify-command-"));
  const recentSince = new Date(Date.now() - 60000).toISOString();
  const recentUntil = new Date(Date.now() - 30000).toISOString();
  const stdout = [];
  const stderr = [];
  const code = await main(["verify", "--trace-id", "trace-123", "--since", recentSince, "--until", recentUntil,
    "--project", project, "--config-dir", project, "--json"], {
    stdout: { write: (value) => stdout.push(value) },
    stderr: { write: (value) => stderr.push(value) },
  });
  assert.equal(code, 12);
  assert.equal(stderr.length, 0);
  assert.equal(stdout.length, 1);
  const result = JSON.parse(stdout[0]);
  assert.equal(result.command, "verify");
  assert.equal(result.outcome, "login_required");
  assert.equal(result.data, null);
  rmSync(project, { recursive: true, force: true });
});
