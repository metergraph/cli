import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { BROWSER, LOCAL_ENV, login, sandboxes } from "./auth-helpers.js";
import { assertNoLeak, parseJsonLine, runCli } from "./helpers.js";
import { startOAuthServer } from "./fixtures/oauth-server.js";
import { aclStatus } from "../src/setup-env-acl.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph setup test "));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const boxFor = sandboxes(dir);

async function setup(box, server, extra = []) {
  const clientSelection = extra.includes("--skip-skill") || extra.includes("--client") ? [] : ["--client", "codex"];
  const deploymentChoice = extra.includes("--deployment")
    ? extra[extra.indexOf("--deployment") + 1]
    : server.behavior.profile === "managed" ? "managed" : "customer-local";
  const deployment = extra.includes("--deployment") ? [] :
    ["--deployment", deploymentChoice];
  const prerequisites = deploymentChoice !== "managed" && !extra.includes("--confirm-prerequisites")
    ? ["--confirm-prerequisites"] : [];
  const origin = extra.includes("--url") ? [] : ["--url", server.origin];
  const workspace = deploymentChoice !== "managed" && !extra.includes("--workspace")
    ? ["--workspace", server.behavior.workspaceId] : [];
  const run = await runCli(["--json", "setup", "--runtime", "local", "--project", box.project,
    "--config-dir", box.config, ...deployment, ...prerequisites, ...origin, ...workspace,
    ...clientSelection, ...extra], { imports: [BROWSER],
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
    assert.equal(first.data.skill, "installed");
    assert.deepEqual(first.data.receipt.completed_steps, ["login", "credential", "skill"]);
    assert.deepEqual(first.data.receipt.pending_steps, ["instrument", "verify", "view"]);
    assert.equal(first.data.receipt.origin, server.origin);
    assert.equal(first.data.receipt.deployment_profile, "local");
    assert.ok(fs.existsSync(path.join(box.project, ".agents", "skills", "metergraph", "SKILL.md")));
    const env = fs.readFileSync(path.join(box.project, ".env"), "utf8");
    assert.match(env, /^METERGRAPH_APP_TOKEN=mg_[A-Za-z0-9_-]+/m);
    assert.ok(env.includes(`METERGRAPH_INGEST_URL=${server.origin}`));
    if (process.platform === "win32") assert.equal(aclStatus(path.join(box.project, ".env")), "private");
    else assert.equal(fs.statSync(path.join(box.project, ".env")).mode & 0o077, 0);
    assert.ok(fs.readFileSync(path.join(box.project, ".gitignore"), "utf8").includes(".env"));
    const state = JSON.parse(fs.readFileSync(path.join(box.project, ".metergraph", "setup.json")));
    assert.equal(state.phase, "delivered");
    assert.ok(!JSON.stringify(state).includes("mg_"));
    const authorizeCount = server.requestsTo("/v1/cli/setup/authorize").length;
    const second = await setup(box, server);
    assert.equal(second.outcome, "ok");
    assert.equal(second.data.env, "unchanged");
    assert.equal(second.data.skill, "reused");
    assert.equal(server.requestsTo("/v1/cli/setup/authorize").length, authorizeCount);
    const authorization = server.requestsTo("/v1/cli/setup/authorize")[0];
    assert.equal(authorization.query.intent, "create");
    assert.equal(authorization.query.workspace_id, state.workspace_id);
    assert.equal(authorization.query.family_id, state.family_id);
    assert.equal(authorization.query.scope, undefined);
    assert.equal(authorization.query.resource, undefined);
    assert.equal(authorization.query.expected_key_id, undefined);
    assert.equal(server.state.setupFamilies.get(state.family_id).delivery, "acknowledged");
    fs.writeFileSync(path.join(box.project, ".env"), env.replace(
      `METERGRAPH_INGEST_URL=${server.origin}`, `METERGRAPH_INGEST_URL=${server.origin}/v1/ingest`));
    const migrated = await setup(box, server);
    assert.equal(migrated.outcome, "ok");
    assert.equal(migrated.data.env, "updated");
    assert.equal(fs.readFileSync(path.join(box.project, ".env"), "utf8"), env);
    assert.equal(server.requestsTo("/v1/cli/setup/authorize").length, authorizeCount);
  } finally { await server.close(); }
});

test("one setup command signs in an unbound project, chooses the verified workspace and installs its client skill", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    const result = await setup(box, server, ["--url", server.origin]);
    assert.equal(result.outcome, "ok");
    assert.equal(result.data.receipt.workspace_id, server.behavior.workspaceId);
    assert.deepEqual(result.data.receipt.completed_steps, ["login", "credential", "skill"]);
    assert.ok(fs.existsSync(path.join(box.project, ".metergraph", "project.json")));
    assert.ok(fs.existsSync(path.join(box.project, ".agents", "skills", "metergraph", "SKILL.md")));
    assert.equal(server.requestsTo("/v1/oauth/authorize").length, 1);
    assert.equal(server.requestsTo("/v1/cli/setup/authorize").length, 1);
  } finally { await server.close(); }
});

test("an expected workspace mismatch stops before ingest approval", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    const result = await setup(box, server, ["--url", server.origin,
      "--workspace", "6f1e2d3c-4b5a-4968-8776-655443322110"]);
    assert.equal(result.outcome, "verification_failed");
    assert.equal(result.error.reason, "workspace_mismatch");
    assert.equal(server.requestsTo("/v1/cli/setup/authorize").length, 0);
    assert.equal(fs.existsSync(path.join(box.project, ".env")), false);
  } finally { await server.close(); }
});

test("explicit skip leaves the skill pending while acknowledging credential delivery", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    const result = await setup(box, server, ["--url", server.origin, "--skip-skill"]);
    assert.equal(result.outcome, "ok");
    assert.equal(result.data.skill, "skipped");
    assert.deepEqual(result.data.receipt.completed_steps, ["login", "credential"]);
    assert.deepEqual(result.data.receipt.pending_steps, ["skill", "instrument", "verify", "view"]);
    assert.equal(fs.existsSync(path.join(box.project, ".agents")), false);
  } finally { await server.close(); }
});

test("a preexisting unowned skill leaves a receipt and can be retried without another grant", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    const skillDir = path.join(box.project, ".agents", "skills", "metergraph");
    fs.mkdirSync(skillDir, { recursive: true });
    const skillFile = path.join(skillDir, "SKILL.md");
    fs.writeFileSync(skillFile, "user owned\n");
    const first = await setup(box, server, ["--url", server.origin]);
    assert.equal(first.outcome, "conflict");
    assert.equal(first.error.reason, "not_owned");
    assert.equal(first.data.status, "credential_ready_skill_pending");
    assert.deepEqual(first.data.receipt.completed_steps, ["login", "credential"]);
    assert.deepEqual(first.data.receipt.pending_steps, ["skill", "instrument", "verify", "view"]);
    assert.equal(fs.readFileSync(skillFile, "utf8"), "user owned\n");
    const approvals = server.requestsTo("/v1/cli/setup/authorize").length;
    fs.rmSync(skillDir, { recursive: true });
    const second = await setup(box, server);
    assert.equal(second.outcome, "ok");
    assert.equal(second.data.env, "unchanged");
    assert.equal(server.requestsTo("/v1/cli/setup/authorize").length, approvals);
  } finally { await server.close(); }
});

test("a modified installed skill is reported pending on rerun", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    assert.equal((await setup(box, server, ["--url", server.origin])).outcome, "ok");
    const skillFile = path.join(box.project, ".agents", "skills", "metergraph", "SKILL.md");
    fs.appendFileSync(skillFile, "\nuser edit\n");
    const rerun = await setup(box, server);
    assert.equal(rerun.outcome, "conflict");
    assert.equal(rerun.data.status, "credential_ready_skill_pending");
    assert.deepEqual(rerun.data.receipt.completed_steps, ["login", "credential"]);
    assert.deepEqual(rerun.data.receipt.pending_steps, ["skill", "instrument", "verify", "view"]);
    assert.equal(server.requestsTo("/v1/cli/setup/authorize").length, 1);
  } finally { await server.close(); }
});

test("a saved receipt does not claim current completion after Metadata access is lost", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    assert.equal((await setup(box, server)).outcome, "ok");
    server.behavior.bearerStatus = 403;
    const rerun = await setup(box, server);
    assert.notEqual(rerun.outcome, "ok");
    assert.deepEqual(rerun.data.receipt.completed_steps, []);
    assert.deepEqual(rerun.data.receipt.pending_steps,
      ["login", "credential", "skill", "instrument", "verify", "view"]);
  } finally { await server.close(); }
});

test("managed setup refuses a customer-local service before ingest approval", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    const result = await setup(box, server, ["--deployment", "managed"]);
    assert.equal(result.outcome, "unsupported");
    assert.equal(result.error.reason, "deployment_profile_mismatch");
    assert.equal(server.requestsTo("/v1/oauth/authorize").length, 0);
    assert.equal(server.requestsTo("/v1/cli/setup/authorize").length, 0);
    assert.equal(fs.existsSync(path.join(box.project, ".env")), false);
  } finally { await server.close(); }
});

test("a concurrent client choice during browser approval is preserved and not redeemed", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    server.behavior.setupAuthorize = () => {
      const file = path.join(box.project, ".metergraph", "setup.json");
      const state = JSON.parse(fs.readFileSync(file, "utf8"));
      state.selected_client = "claude";
      fs.writeFileSync(file, `${JSON.stringify(state)}\n`);
    };
    const result = await setup(box, server);
    assert.equal(result.outcome, "conflict");
    assert.equal(result.error.reason, "setup_state_changed");
    assert.equal(server.requestsTo("/v1/cli/setup/redeem").length, 0);
    assert.equal(fs.existsSync(path.join(box.project, ".env")), false);
    const state = JSON.parse(fs.readFileSync(path.join(box.project, ".metergraph", "setup.json"), "utf8"));
    assert.equal(state.selected_client, "claude");
  } finally { await server.close(); }
});

test("customer-local setup verifies route before browser login and completes on the exact profile", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    const result = await setup(box, server, ["--deployment", "customer-local",
      "--confirm-prerequisites", "--url", server.origin, "--workspace", server.behavior.workspaceId]);
    assert.equal(result.outcome, "ok");
    assert.equal(result.data.receipt.deployment_profile, "local");
    assert.equal(result.data.receipt.workspace_id, server.behavior.workspaceId);
    assert.equal(server.requestsTo("/v1/oauth/authorize").length, 1);
    assert.equal(server.requestsTo("/v1/cli/setup/authorize").length, 1);
  } finally { await server.close(); }
});

test("customer-local profile mismatch stops before login or ingest approval", async () => {
  const server = await startOAuthServer({ setup: true, deploymentProfile: "managed" });
  try {
    const box = boxFor();
    const result = await setup(box, server, ["--deployment", "customer-local",
      "--confirm-prerequisites", "--url", server.origin, "--workspace", server.behavior.workspaceId]);
    assert.equal(result.outcome, "unsupported");
    assert.equal(result.error.reason, "deployment_profile_mismatch");
    assert.equal(server.requestsTo("/v1/oauth/authorize").length, 0);
    assert.equal(server.requestsTo("/v1/cli/setup/authorize").length, 0);
    assert.equal(fs.existsSync(path.join(box.project, ".env")), false);
  } finally { await server.close(); }
});

test("switching the selected client installs its own skill without rotating the key", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    assert.equal((await setup(box, server, ["--url", server.origin])).outcome, "ok");
    const approvals = server.requestsTo("/v1/cli/setup/authorize").length;
    const second = await setup(box, server, ["--client", "claude"]);
    assert.equal(second.outcome, "ok");
    assert.equal(second.data.receipt.client, "claude");
    assert.ok(fs.existsSync(path.join(box.project, ".claude", "skills", "metergraph", "SKILL.md")));
    assert.equal(server.requestsTo("/v1/cli/setup/authorize").length, approvals);
  } finally { await server.close(); }
});

test("a prior setup state upgrades in place and composes a skill without a new approval", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    assert.equal((await setup(box, server, ["--url", server.origin, "--skip-skill"])).outcome, "ok");
    const stateFile = path.join(box.project, ".metergraph", "setup.json");
    const state = JSON.parse(fs.readFileSync(stateFile, "utf8"));
    for (const key of ["deployment_profile", "selected_client", "skill_status", "completed_steps", "pending_steps"]) {
      delete state[key];
    }
    fs.writeFileSync(stateFile, `${JSON.stringify(state)}\n`, { mode: 0o600 });
    const approvals = server.requestsTo("/v1/cli/setup/authorize").length;
    const next = await setup(box, server);
    assert.equal(next.outcome, "ok");
    assert.equal(next.data.receipt.client, "codex");
    assert.deepEqual(next.data.receipt.completed_steps, ["login", "credential", "skill"]);
    assert.equal(server.requestsTo("/v1/cli/setup/authorize").length, approvals);
  } finally { await server.close(); }
});

test("reconnect cannot change a delivered family's workspace binding", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    assert.equal((await setup(box, server, ["--url", server.origin])).outcome, "ok");
    const bindingFile = path.join(box.project, ".metergraph", "project.json");
    const before = fs.readFileSync(bindingFile);
    const logins = server.requestsTo("/v1/oauth/authorize").length;
    const result = await setup(box, server, ["--reconnect", "--workspace",
      "6f1e2d3c-4b5a-4968-8776-655443322110"]);
    assert.equal(result.outcome, "conflict");
    assert.equal(result.error.reason, "setup_binding_changed");
    assert.ok(fs.readFileSync(bindingFile).equals(before));
    assert.equal(server.requestsTo("/v1/oauth/authorize").length, logins);
  } finally { await server.close(); }
});

test("hosted signup goes through the existing browser login before ingest approval", async () => {
  const server = await startOAuthServer({ setup: true, profile: "managed" });
  try {
    const box = boxFor();
    const result = await setup(box, server, ["--url", server.origin, "--signup"]);
    assert.equal(result.outcome, "ok");
    assert.equal(result.data.receipt.deployment_profile, "managed");
    assert.equal(server.requestsTo("/v1/auth/signup").length, 1);
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

test("an explicitly repaired family can recover after its private env file was lost", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    assert.equal((await setup(box, server, ["--url", server.origin])).outcome, "ok");
    const state = JSON.parse(fs.readFileSync(path.join(box.project, ".metergraph", "setup.json")));
    fs.unlinkSync(path.join(box.project, ".env"));
    const refused = await setup(box, server);
    assert.equal(refused.outcome, "conflict");
    assert.equal(refused.error.reason, "repair_required");
    const repaired = await setup(box, server, ["--repair"]);
    assert.equal(repaired.outcome, "ok");
    const authorize = server.requestsTo("/v1/cli/setup/authorize").at(-1);
    assert.equal(authorize.query.intent, "repair");
    assert.equal(authorize.query.expected_key_id, state.key_id);
  } finally { await server.close(); }
});
