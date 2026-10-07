import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { BROWSER, LOCAL_ENV, login, sandboxes } from "./auth-helpers.js";
import { assertNoLeak, parseJsonLine, runCli } from "./helpers.js";
import { startOAuthServer } from "./fixtures/oauth-server.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph setup test "));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const boxFor = sandboxes(dir);

async function setup(box, server, extra = []) {
  const run = await runCli(["--json", "setup", "--runtime", "local", "--project", box.project,
    "--config-dir", box.config, ...extra], { imports: [BROWSER],
    env: { ...LOCAL_ENV, METERGRAPH_TEST_BROWSER: "follow", METERGRAPH_TEST_BROWSER_LOG: box.log } });
  assertNoLeak(assert, run.stdout, run.stderr);
  assert.equal(run.stderr, "");
  for (const secret of server.issued) {
    assert.ok(!run.stdout.includes(secret), "a credential was printed");
  }
  const result = parseJsonLine(run.stdout);
  assert.equal(result.exit_code, run.code);
  assert.ok(result.data, run.stdout);
  assert.equal(result.data.application_traffic_verified, false);
  return result;
}

test("browser-approved setup writes a private env, acknowledges delivery and reuses only its own key", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    assert.equal((await login(assert, box, server)).result.ok, true);
    const first = await setup(box, server);
    assert.equal(first.outcome, "ok");
    assert.equal(first.data.status, "ready_for_instrumentation");
    const env = fs.readFileSync(path.join(box.project, ".env"), "utf8");
    assert.match(env, /^METERGRAPH_APP_TOKEN=mg_[A-Za-z0-9_-]+/m);
    assert.ok(env.includes(`METERGRAPH_INGEST_URL=${server.origin}/v1/ingest`));
    assert.equal(fs.statSync(path.join(box.project, ".env")).mode & 0o077, 0);
    assert.ok(fs.readFileSync(path.join(box.project, ".gitignore"), "utf8").includes(".env"));
    const state = JSON.parse(fs.readFileSync(path.join(box.project, ".metergraph", "setup.json")));
    assert.equal(state.phase, "delivered");
    assert.ok(!JSON.stringify(state).includes("mg_"));
    const authorizeCount = server.requestsTo("/v1/cli/setup/authorize").length;
    const second = await setup(box, server);
    assert.equal(second.outcome, "ok");
    assert.equal(second.data.env, "unchanged");
    assert.equal(server.requestsTo("/v1/cli/setup/authorize").length, authorizeCount);
    const authorization = server.requestsTo("/v1/cli/setup/authorize")[0];
    assert.equal(authorization.query.intent, "create");
    assert.equal(authorization.query.workspace_id, state.workspace_id);
    assert.equal(authorization.query.family_id, state.family_id);
    assert.equal(authorization.query.scope, undefined);
    assert.equal(authorization.query.resource, undefined);
    assert.equal(authorization.query.expected_key_id, undefined);
    assert.equal(server.state.setupFamilies.get(state.family_id).delivery, "acknowledged");
  } finally { await server.close(); }
});

test("lost redemption response persists family and uses browser-approved pending replacement", async () => {
  const server = await startOAuthServer({ setup: true, setupRedeem: "drop-after-issue" });
  try {
    const box = boxFor();
    assert.equal((await login(assert, box, server)).result.ok, true);
    const first = await setup(box, server);
    assert.equal(first.outcome, "connection_failed");
    assert.equal(first.data.status, "delivery_pending");
    assert.equal(fs.existsSync(path.join(box.project, ".env")), false);
    const state = JSON.parse(fs.readFileSync(path.join(box.project, ".metergraph", "setup.json")));
    assert.equal(state.phase, "redeem_attempted");
    const oldKey = server.state.setupFamilies.get(state.family_id).keyId;
    server.behavior.setupRedeem = "issue";
    const second = await setup(box, server);
    assert.equal(second.outcome, "ok");
    assert.notEqual(server.state.setupFamilies.get(state.family_id).keyId, oldKey);
    const authorizations = server.requestsTo("/v1/cli/setup/authorize");
    assert.equal(authorizations[1].query.intent, "replace_pending");
    assert.equal(authorizations[1].query.expected_key_id, undefined);
  } finally { await server.close(); }
});

test("a redemption request lost before issuance recovers with a server-resolved create", async () => {
  const server = await startOAuthServer({ setup: true, setupRedeem: "drop-before-issue" });
  try {
    const box = boxFor();
    assert.equal((await login(assert, box, server)).result.ok, true);
    const first = await setup(box, server);
    assert.equal(first.outcome, "connection_failed");
    const state = JSON.parse(fs.readFileSync(path.join(box.project, ".metergraph", "setup.json")));
    assert.equal(state.phase, "redeem_attempted");
    assert.equal(server.state.setupFamilies.has(state.family_id), false);
    server.behavior.setupRedeem = "issue";
    const second = await setup(box, server);
    assert.equal(second.outcome, "ok");
    assert.equal(server.requestsTo("/v1/cli/setup/authorize").at(-1).query.intent, "replace_pending");
    assert.equal(server.state.setupFamilies.get(state.family_id).delivery, "acknowledged");
  } finally { await server.close(); }
});

test("a failed credential check after env write can replace the family's pending key", async () => {
  const server = await startOAuthServer({ setup: true, setupCredentialReject: true });
  try {
    const box = boxFor();
    assert.equal((await login(assert, box, server)).result.ok, true);
    const first = await setup(box, server);
    assert.equal(first.outcome, "verification_failed");
    assert.equal(first.data.status, "delivery_pending");
    const state = JSON.parse(fs.readFileSync(path.join(box.project, ".metergraph", "setup.json")));
    assert.equal(state.phase, "redeem_attempted");
    assert.equal(state.key_id, null);
    const family = server.state.setupFamilies.get(state.family_id);
    const oldKey = family.keyId;
    family.token = "mg_revoked_synthetic_00000000000000000000";
    server.behavior.setupCredentialReject = false;
    const second = await setup(box, server);
    assert.equal(second.outcome, "ok");
    assert.equal(server.requestsTo("/v1/cli/setup/authorize").at(-1).query.intent, "replace_pending");
    assert.notEqual(server.state.setupFamilies.get(state.family_id).keyId, oldKey);
  } finally { await server.close(); }
});

test("tampered setup discovery stops before browser registration or file write", async () => {
  const server = await startOAuthServer({ setup: true,
    setupMetadata: (doc) => ({ ...doc, redemption_endpoint: "https://evil.example.com/redeem" }) });
  try {
    const box = boxFor();
    assert.equal((await login(assert, box, server)).result.ok, true);
    const registered = server.requestsTo("/v1/oauth/register").length;
    const result = await setup(box, server);
    assert.equal(result.outcome, "unsupported");
    assert.equal(result.error.reason, "setup_contract_mismatch");
    assert.equal(server.requestsTo("/v1/oauth/register").length, registered);
    assert.equal(fs.existsSync(path.join(box.project, ".env")), false);
  } finally { await server.close(); }
});

test("an acknowledged key is replaced only with explicit repair bound to its key ID", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    assert.equal((await login(assert, box, server)).result.ok, true);
    assert.equal((await setup(box, server)).outcome, "ok");
    const state = JSON.parse(fs.readFileSync(path.join(box.project, ".metergraph", "setup.json")));
    const family = server.state.setupFamilies.get(state.family_id);
    const oldKey = family.keyId;
    family.token = "mg_revoked_synthetic_00000000000000000000";
    const refused = await setup(box, server);
    assert.equal(refused.outcome, "verification_failed");
    assert.equal(refused.error.reason, "saved_key_unverified");
    const repaired = await setup(box, server, ["--repair"]);
    assert.equal(repaired.outcome, "ok");
    const authorize = server.requestsTo("/v1/cli/setup/authorize").at(-1);
    assert.equal(authorize.query.intent, "repair");
    assert.equal(authorize.query.expected_key_id, oldKey);
    assert.notEqual(server.state.setupFamilies.get(state.family_id).keyId, oldKey);
  } finally { await server.close(); }
});
