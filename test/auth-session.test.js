// The verified session helper that later read commands use: refresh under the
// slot lock, rotation persistence, ambiguity, revocation and lost access.
// Sign in itself runs as a subprocess against the synthetic loopback service;
// the session helper runs in process on the same temporary directories. This
// is protocol and file proof only, not proof of the real service.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { verifiedSession } from "../src/auth-session.js";
import { openStore, readCredential, writeCredential } from "../src/auth-store.js";
import { browserLog, credentialFiles, login, logout, readBindingFile, sandboxes } from "./auth-helpers.js";
import { WORKSPACE_A, WORKSPACE_B, startOAuthServer } from "./fixtures/oauth-server.js";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph session test "));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));
const sandbox = sandboxes(workDir);

async function withServer(behavior, work) {
  const server = await startOAuthServer(behavior);
  try {
    return await work(server);
  } finally {
    await server.close();
  }
}

// Signs a fresh project in and returns its sandbox plus helpers to read and
// change the saved grant.
async function signedIn(server) {
  const box = sandbox();
  const { run } = await login(assert, box, server);
  assert.equal(run.code, 0, run.stdout);
  const slot = readBindingFile(box).credential_slot;
  const store = openStore(box.config, { create: false });
  return {
    box,
    slot,
    record: () => readCredential(store, slot),
    change: (fields) => writeCredential(store, slot, { ...readCredential(store, slot), ...fields }),
    session: (options = {}) => verifiedSession({ project: box.project, configDir: box.config, ...options }),
  };
}

const refreshRequests = (server) =>
  server
    .requestsTo("/v1/oauth/token")
    .filter((request) => new URLSearchParams(request.body).get("grant_type") === "refresh_token");

function assertStop(result, outcome, reason) {
  assert.deepEqual(result, { ok: false, outcome, reason });
}

test("a valid session is verified with the service and returns its token to code only", async () => {
  await withServer({}, async (server) => {
    const project = await signedIn(server);
    const before = server.requests.length;
    const result = await project.session();
    assert.equal(result.ok, true);
    assert.deepEqual(result.session, {
      origin: server.origin,
      workspaceId: WORKSPACE_A,
      profile: "local",
      scopes: ["agent:metadata"],
      accessToken: project.record().access_token,
    });
    assert.deepEqual(
      server.requests.slice(before).map((request) => `${request.method} ${request.path}`),
      ["GET /v1/agent/workspace", "GET /v1/agent/capabilities"],
    );
    // Never a browser, never a write.
    assert.equal(browserLog(project.box).filter((entry) => entry.url).length, 1);
  });
});

test("an expiring grant is refreshed once under the lock, and the rotation is saved", async () => {
  await withServer({}, async (server) => {
    const project = await signedIn(server);
    const old = project.record();
    project.change({ expires_at: Date.now() - 1000 });

    // Two callers at once: one refreshes, the other waits and reuses it.
    const [first, second] = await Promise.all([project.session(), project.session()]);
    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.equal(refreshRequests(server).length, 1, "the refresh token was sent more than once");
    const form = new URLSearchParams(refreshRequests(server)[0].body);
    assert.equal(form.get("client_id"), old.client_id);
    assert.equal(form.get("resource"), server.resource);
    assert.equal(form.get("scope"), "agent:metadata");
    assert.equal(form.get("refresh_token"), old.refresh_token);

    const saved = project.record();
    assert.equal(saved.refresh_pending, false);
    assert.notEqual(saved.refresh_token, old.refresh_token);
    assert.notEqual(saved.access_token, old.access_token);
    assert.ok(saved.expires_at > Date.now() + 60 * 1000);
    assert.equal(first.session.accessToken, saved.access_token);
    assert.equal(second.session.accessToken, saved.access_token);
    assert.equal(server.state.refresh.get(old.refresh_token).used, true);
    assert.deepEqual(credentialFiles(project.box), [`${project.slot}.json`], "a lock or temporary file was left");
  });
});

test("two processes rerunning login on an expiring grant refresh it at most once", async () => {
  await withServer({}, async (server) => {
    const project = await signedIn(server);
    project.change({ expires_at: Date.now() + 1000 });
    const runs = await Promise.all([login(assert, project.box, server), login(assert, project.box, server)]);
    for (const { run, result } of runs) {
      assert.equal(run.code, 0, run.stdout);
      assert.equal(result.data.status, "reused");
    }
    assert.equal(refreshRequests(server).length, 1);
    assert.equal(project.record().refresh_pending, false);
    assert.equal(browserLog(project.box).filter((entry) => entry.url).length, 1, "a browser was opened");
  });
});

test("an interrupted or unusable refresh is never retried with the possibly used token", async () => {
  const cases = [
    { refresh: "drop" },
    { refresh: "server-error" },
    // A 200 that cannot be accepted may still have rotated the token.
    { token: (doc) => ({ ...doc, scope: "agent:metadata agent:read" }) },
  ];
  for (const change of cases) {
    await withServer({}, async (server) => {
      const project = await signedIn(server);
      const old = project.record();
      project.change({ expires_at: Date.now() - 1000 });
      Object.assign(server.behavior, change);

      assertStop(await project.session(), "login_required", "refresh_interrupted");
      assert.equal(refreshRequests(server).length, 1);
      const kept = project.record();
      assert.equal(kept.refresh_pending, true, "the record was not marked for reconnect");
      assert.equal(kept.refresh_token, old.refresh_token);

      // Even once the service works again, the token is not sent again.
      Object.assign(server.behavior, { refresh: "rotate", token: (doc) => doc });
      assertStop(await project.session(), "login_required", "reconnect_required");
      assert.equal(refreshRequests(server).length, 1, "a possibly consumed refresh token was retried");
      assert.deepEqual(credentialFiles(project.box), [`${project.slot}.json`]);

      // A login rerun reconnects through the browser and replaces the grant.
      const { run, result } = await login(assert, project.box, server);
      assert.equal(run.code, 0, run.stdout);
      assert.equal(result.data.status, "reconnected");
      const binding = readBindingFile(project.box);
      assert.notEqual(binding.credential_slot, project.slot);
      assert.deepEqual(credentialFiles(project.box), [`${binding.credential_slot}.json`]);
    });
  }
});

test("a refreshed grant that cannot be saved asks to reconnect instead of reusing the old one", async () => {
  await withServer({}, async (server) => {
    const project = await signedIn(server);
    project.change({ expires_at: Date.now() - 1000 });
    const credential = `${project.slot}.json`;
    const renameSync = fs.renameSync;
    let renames = 0;
    fs.renameSync = (from, to) => {
      if (path.basename(String(to)) === credential) {
        renames += 1;
        // The first rename marks the refresh as pending; the second would
        // save the rotated grant.
        if (renames === 2) throw Object.assign(new Error("SYNTHETIC_FAULT_MARKER"), { code: "EIO" });
      }
      return renameSync(from, to);
    };
    let result;
    try {
      result = await project.session();
    } finally {
      fs.renameSync = renameSync;
    }
    assertStop(result, "login_required", "refresh_not_saved");
    assert.equal(refreshRequests(server).length, 1);
    assert.equal(project.record().refresh_pending, true);
    assertStop(await project.session(), "login_required", "reconnect_required");
    assert.equal(refreshRequests(server).length, 1);
  });
});

test("a refused refresh, or one for another workspace, fails closed", async () => {
  await withServer({}, async (server) => {
    const project = await signedIn(server);
    project.change({ expires_at: Date.now() - 1000 });
    for (const grant of server.state.refresh.values()) grant.revoked = true;
    assertStop(await project.session(), "login_required", "grant_rejected");
  });
  await withServer({}, async (server) => {
    const project = await signedIn(server);
    project.change({ expires_at: Date.now() - 1000 });
    server.behavior.claims = (claims) => ({ ...claims, tenant_id: WORKSPACE_B });
    assertStop(await project.session(), "login_required", "credential_context_mismatch");
    assert.equal(project.record().workspace_id, WORKSPACE_A, "a grant for another workspace was saved");
    assert.equal(project.record().refresh_pending, true);
  });
});

test("revocation and lost workspace access fail closed without a refresh", async () => {
  await withServer({}, async (server) => {
    const project = await signedIn(server);
    server.behavior.bearerStatus = 403;
    assertStop(await project.session(), "login_required", "access_revoked");
    server.behavior.bearerStatus = 200;
    for (const grant of server.state.access.values()) grant.revoked = true;
    assertStop(await project.session(), "login_required", "access_revoked");
    assert.equal(refreshRequests(server).length, 0);
    // The service's refusal text never reaches the result.
    assert.ok(!JSON.stringify(await project.session()).includes("SYNTHETIC"));
  });
});

test("missing, mismatched or foreign local state needs a new login and sends nothing", async () => {
  await withServer({}, async (server) => {
    const unbound = sandbox();
    assertStop(
      await verifiedSession({ project: unbound.project, configDir: unbound.config }),
      "login_required",
      "not_signed_in",
    );

    const project = await signedIn(server);
    const before = server.requests.length;
    assertStop(
      await verifiedSession({ project: project.box.project, configDir: path.join(project.box.base, "other config") }),
      "login_required",
      "credential_missing",
    );
    project.change({ workspace_id: WORKSPACE_B });
    assertStop(await project.session(), "login_required", "credential_context_mismatch");
    project.change({ workspace_id: WORKSPACE_A, refresh_pending: true });
    assertStop(await project.session(), "login_required", "reconnect_required");
    fs.rmSync(path.join(project.box.config, "credentials", `${project.slot}.json`));
    assertStop(await project.session(), "login_required", "credential_missing");
    assert.equal(server.requests.length, before, "a request was made for unusable local state");
  });
});

test("a cancelled session check reports cancellation, not revocation", async () => {
  await withServer({}, async (server) => {
    const project = await signedIn(server);
    const controller = new AbortController();
    controller.abort();
    assertStop(await project.session({ cancel: controller.signal }), "authorization_failed", "cancelled");
    assert.equal(project.record().refresh_pending, false);
  });
});

test("a grant for a registered client keeps refreshing and revoking after the service offers a fixed client", async () => {
  await withServer({}, async (server) => {
    const project = await signedIn(server);
    const old = project.record();
    assert.match(old.client_id, /^mgc_/);
    server.configureCliClient("metergraph-cli");
    project.change({ expires_at: Date.now() - 1000 });

    const result = await project.session();
    assert.equal(result.ok, true);
    assert.equal(refreshRequests(server).length, 1);
    assert.equal(new URLSearchParams(refreshRequests(server)[0].body).get("client_id"), old.client_id);
    // The saved record keeps the client it was issued to.
    assert.equal(project.record().client_id, old.client_id);
    assert.equal(server.requestsTo("/v1/oauth/register").length, 1);

    const out = await logout(assert, project.box, server);
    assert.equal(out.run.code, 0);
    assert.equal(out.result.data.revocation, "accepted");
    assert.equal(new URLSearchParams(server.requestsTo("/v1/oauth/revoke")[0].body).get("client_id"), old.client_id);
    assert.ok([...server.state.refresh.values()].every((grant) => grant.revoked));
  });
});
