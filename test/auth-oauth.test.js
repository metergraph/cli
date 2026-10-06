// OAuth discovery, registration, grant and context checks, in-process against
// the synthetic loopback service. Fixture documents use the real public wire
// shapes; see test/fixtures/oauth-server.js.
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { test } from "node:test";

import {
  authorizationUrl,
  checkCapabilities,
  checkWorkspace,
  discover,
  endpointsFor,
  newPkce,
  register,
  validateGrant,
} from "../src/auth-oauth.js";
import { AGENT_CONTRACT_VERSION, SCHEMA_VERSION } from "../src/constants.js";
import {
  CONTRACT_VERSION,
  WORKSPACE_A,
  WORKSPACE_B,
  capabilitiesDocument,
  startOAuthServer,
  workspaceDocument,
} from "./fixtures/oauth-server.js";

const b64 = (value) => Buffer.from(JSON.stringify(value)).toString("base64url");
const clone = (value) => JSON.parse(JSON.stringify(value));

async function withServer(behavior, work) {
  const server = await startOAuthServer(behavior);
  try {
    return await work(server);
  } finally {
    await server.close();
  }
}

test("discovery accepts exact same-origin metadata that offers Metadata, S256 and public clients", async () => {
  await withServer({}, async (server) => {
    const result = await discover(server.origin, AbortSignal.timeout(5000));
    assert.equal(result.ok, true);
    assert.deepEqual(result.endpoints, endpointsFor(server.origin));
    assert.equal(result.requireIss, true);
    assert.deepEqual(
      server.requests.map((request) => request.path),
      ["/.well-known/oauth-protected-resource/v1/agent/mcp", "/.well-known/oauth-authorization-server/v1/oauth"],
    );
    for (const request of server.requests) assert.equal(request.headers.authorization, undefined);
  });
});

test("tampered, off-origin or legacy metadata is unsupported and never falls back", async () => {
  const evil = "https://evil.example.com";
  const cases = [
    [{ prm: (doc) => ({ ...doc, resource: `${evil}/v1/agent/mcp` }) }, "resource_mismatch"],
    [{ prm: (doc) => ({ ...doc, authorization_servers: [`${evil}/v1/oauth`] }) }, "issuer_mismatch"],
    [{ prm: (doc) => ({ ...doc, authorization_servers: [doc.authorization_servers[0], `${evil}/v1/oauth`] }) }, "issuer_mismatch"],
    [{ prm: (doc) => ({ ...doc, scopes_supported: ["agent:read", "agent:replay"] }) }, "metadata_scope_unsupported"],
    [{ asm: (doc) => ({ ...doc, issuer: `${evil}/v1/oauth` }) }, "issuer_mismatch"],
    [{ asm: (doc) => ({ ...doc, authorization_endpoint: `${evil}/authorize` }) }, "endpoint_not_allowed"],
    [{ asm: (doc) => ({ ...doc, token_endpoint: doc.token_endpoint.replace("/token", "/token2") }) }, "endpoint_not_allowed"],
    [{ asm: (doc) => ({ ...doc, registration_endpoint: `${evil}/register` }) }, "endpoint_not_allowed"],
    [{ asm: (doc) => ({ ...doc, revocation_endpoint: `${evil}/revoke` }) }, "endpoint_not_allowed"],
    [{ asm: ({ revocation_endpoint, ...doc }) => doc }, "revocation_unsupported"],
    [{ asm: (doc) => ({ ...doc, scopes_supported: ["agent:read", "agent:replay"] }) }, "metadata_scope_unsupported"],
    [{ asm: (doc) => ({ ...doc, code_challenge_methods_supported: ["plain"] }) }, "pkce_unsupported"],
    [{ asm: (doc) => ({ ...doc, token_endpoint_auth_methods_supported: ["client_secret_basic"] }) }, "public_client_unsupported"],
    [{ asm: (doc) => ({ ...doc, grant_types_supported: ["authorization_code"] }) }, "oauth_metadata_invalid"],
  ];
  for (const [behavior, reason] of cases) {
    await withServer(behavior, async (server) => {
      const result = await discover(server.origin, AbortSignal.timeout(5000));
      assert.deepEqual(result, { ok: false, outcome: "unsupported", reason }, reason);
    });
  }
});

test("a server without OAuth metadata is unsupported, and a redirect is never followed", async () => {
  const http = await import("node:http");
  const make = (handler) =>
    new Promise((resolve) => {
      const server = http.createServer(handler);
      server.listen(0, "127.0.0.1", () => resolve(server));
    });
  const notFound = await make((request, response) => {
    response.writeHead(404, { "content-type": "application/json" });
    response.end("{}");
  });
  const redirecting = await make((request, response) => {
    response.writeHead(302, { location: "https://evil.example.com/.well-known/oauth-protected-resource" });
    response.end();
  });
  try {
    const origin = (server) => `http://127.0.0.1:${server.address().port}`;
    assert.deepEqual(await discover(origin(notFound), AbortSignal.timeout(2000)), {
      ok: false,
      outcome: "unsupported",
      reason: "oauth_metadata_missing",
    });
    assert.deepEqual(await discover(origin(redirecting), AbortSignal.timeout(2000)), {
      ok: false,
      outcome: "redirect_rejected",
      reason: "redirect",
    });
  } finally {
    await new Promise((resolve) => notFound.close(resolve));
    await new Promise((resolve) => redirecting.close(resolve));
  }
});

test("registration is a public client for one exact loopback redirect", async () => {
  const redirectUri = "http://127.0.0.1:43210/callback";
  await withServer({}, async (server) => {
    const endpoints = endpointsFor(server.origin);
    const result = await register(endpoints, redirectUri, AbortSignal.timeout(5000));
    assert.equal(result.ok, true);
    const body = JSON.parse(server.requestsTo("/v1/oauth/register")[0].body);
    assert.deepEqual(body, {
      client_name: "Metergraph CLI",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: "agent:metadata",
    });
  });
  for (const [hook, reason] of [
    [(doc) => ({ ...doc, client_secret: "SYNTHETIC_BODY_MARKER" }), "registration_invalid"],
    [(doc) => ({ ...doc, redirect_uris: ["http://127.0.0.1:1/callback"] }), "registration_invalid"],
    [(doc) => ({ ...doc, token_endpoint_auth_method: "client_secret_post" }), "registration_invalid"],
    [(doc) => ({ ...doc, client_id: "" }), "registration_invalid"],
  ]) {
    await withServer({ registration: hook }, async (server) => {
      const result = await register(endpointsFor(server.origin), redirectUri, AbortSignal.timeout(5000));
      assert.deepEqual(result, { ok: false, outcome: "unsupported", reason });
    });
  }
});

test("PKCE values are high entropy and the challenge is S256 of the verifier", () => {
  const seen = new Set();
  for (let i = 0; i < 20; i += 1) {
    const pkce = newPkce();
    assert.match(pkce.state, /^[A-Za-z0-9_-]{43}$/);
    assert.match(pkce.verifier, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(pkce.challenge, createHash("sha256").update(pkce.verifier).digest("base64url"));
    assert.ok(!seen.has(pkce.state) && !seen.has(pkce.verifier));
    seen.add(pkce.state).add(pkce.verifier);
  }
});

test("the authorization URL asks for exactly Metadata, and signup returns to the same request", () => {
  const endpoints = endpointsFor("https://metergraph.example.com");
  const options = {
    clientId: "client-1",
    redirectUri: "http://127.0.0.1:5000/callback",
    state: "s".repeat(43),
    challenge: "c".repeat(43),
  };
  const direct = new URL(authorizationUrl(endpoints, { ...options, signup: false }));
  assert.equal(`${direct.origin}${direct.pathname}`, endpoints.authorization);
  assert.deepEqual(Object.fromEntries(direct.searchParams), {
    response_type: "code",
    client_id: "client-1",
    redirect_uri: options.redirectUri,
    scope: "agent:metadata",
    state: options.state,
    code_challenge: options.challenge,
    code_challenge_method: "S256",
    resource: endpoints.resource,
  });
  const signup = new URL(authorizationUrl(endpoints, { ...options, signup: true }));
  assert.equal(`${signup.origin}${signup.pathname}`, "https://metergraph.example.com/v1/auth/signup");
  assert.deepEqual([...signup.searchParams.keys()], ["return_to"]);
  assert.equal(signup.searchParams.get("return_to"), `${direct.pathname}${direct.search}`);
});

function grantBody(endpoints, overrides = {}, claimOverrides = {}) {
  const claims = {
    iss: endpoints.issuer,
    aud: endpoints.resource,
    client_id: "client-1",
    tenant_id: WORKSPACE_A,
    scope: "agent:metadata",
    exp: Math.floor(Date.now() / 1000) + 3600,
    ...claimOverrides,
  };
  return {
    access_token: `${b64({ alg: "none" })}.${b64(claims)}.${Buffer.from("SIG").toString("base64url")}`,
    token_type: "Bearer",
    expires_in: 3600,
    refresh_token: "refresh-token-synthetic-0000000000",
    scope: "agent:metadata",
    ...overrides,
  };
}

test("only a bearer grant for exactly Metadata with matching claims is accepted", () => {
  const endpoints = endpointsFor("https://metergraph.example.com");
  const ok = validateGrant(grantBody(endpoints), endpoints, "client-1", { requireRefresh: true });
  assert.equal(ok.ok, true);
  assert.equal(ok.grant.tenant, WORKSPACE_A);
  assert.ok(ok.grant.expiresAt > Date.now());

  const cases = [
    [{ token_type: "mac" }, {}, "token_type_invalid"],
    [{ scope: "agent:metadata agent:read" }, {}, "scope_mismatch"],
    [{ scope: "agent:read" }, {}, "scope_mismatch"],
    [{ scope: undefined }, {}, "scope_mismatch"],
    [{ refresh_token: undefined }, {}, "token_response_invalid"],
    [{ refresh_token: "short" }, {}, "token_response_invalid"],
    [{ expires_in: 0 }, {}, "token_response_invalid"],
    [{ access_token: "opaque-token-without-claims-0000" }, {}, "token_claims_invalid"],
    [{}, { iss: "https://evil.example.com/v1/oauth" }, "issuer_mismatch"],
    [{}, { aud: "https://metergraph.example.com/v1/other" }, "resource_mismatch"],
    [{}, { client_id: "client-2" }, "client_mismatch"],
    [{}, { scope: "agent:read" }, "scope_mismatch"],
    [{}, { tenant_id: "not-a-uuid" }, "token_claims_invalid"],
    [{}, { tenant_id: undefined }, "token_claims_invalid"],
    [{}, { exp: Math.floor(Date.now() / 1000) - 10 }, "token_claims_invalid"],
  ];
  for (const [overrides, claimOverrides, reason] of cases) {
    const result = validateGrant(grantBody(endpoints, overrides, claimOverrides), endpoints, "client-1", {
      requireRefresh: true,
    });
    assert.deepEqual(result, { ok: false, outcome: "verification_failed", reason }, reason);
  }
  // A refresh may keep the refresh token by omitting it.
  const kept = validateGrant(grantBody(endpoints, { refresh_token: undefined }), endpoints, "client-1", {
    requireRefresh: false,
  });
  assert.equal(kept.ok, true);
  assert.equal(kept.grant.refreshToken, null);
});

const PROVENANCE = {
  deployment_profile: "local",
  workspace_id: WORKSPACE_A,
  generated_at: "2026-01-01T00:00:00Z",
  source: "synthetic-fixture",
};
const CONTEXT = { profile: "local", workspaceId: WORKSPACE_A };

test("the agent contract version is the service's exact string on both sides", () => {
  // Written out literally so the CLI constant and the fixture cannot drift
  // together away from what the service sends.
  assert.equal(AGENT_CONTRACT_VERSION, "metergraph.agent-access/v1");
  assert.equal(CONTRACT_VERSION, "metergraph.agent-access/v1");
  assert.equal(workspaceDocument(PROVENANCE, WORKSPACE_A).schema_version, "metergraph.agent-access/v1");
  assert.equal(capabilitiesDocument(PROVENANCE).schema_version, "metergraph.agent-access/v1");
  assert.notEqual(AGENT_CONTRACT_VERSION, SCHEMA_VERSION);
});

test("the real workspace shape is verified exactly, and enabled capture is not a reason to refuse", () => {
  const good = workspaceDocument(PROVENANCE, WORKSPACE_A);
  assert.equal(good.content.captured, true);
  assert.deepEqual(checkWorkspace(good, CONTEXT), { ok: true });
  assert.deepEqual(checkWorkspace({ ...good, content: { captured: false, included: false } }, CONTEXT), { ok: true });
  // Upper case UUIDs from the server are the same workspace.
  const upper = clone(good);
  upper.workspace.id = WORKSPACE_A.toUpperCase();
  assert.deepEqual(checkWorkspace(upper, CONTEXT), { ok: true });

  const mutate = (change) => {
    const doc = clone(good);
    change(doc);
    return checkWorkspace(doc, CONTEXT).reason;
  };
  // schema_version is the service's contract string. The CLI's own JSON
  // schema number (1) is a different thing and is not accepted here.
  for (const version of [1, "1", 2, "metergraph.agent-access/v2", "METERGRAPH.AGENT-ACCESS/V1", undefined]) {
    assert.equal(mutate((doc) => (doc.schema_version = version)), "workspace_response_invalid", String(version));
  }
  assert.equal(mutate((doc) => delete doc.workspace), "workspace_response_invalid");
  assert.equal(mutate((doc) => (doc.workspace.id = WORKSPACE_B)), "workspace_context_mismatch");
  assert.equal(mutate((doc) => (doc.provenance.workspace_id = WORKSPACE_B)), "workspace_context_mismatch");
  assert.equal(mutate((doc) => (doc.provenance.deployment_profile = "managed")), "profile_mismatch");
  // The provenance field is deployment_profile; an invented "profile" field does not count.
  assert.equal(
    mutate((doc) => {
      doc.provenance.profile = doc.provenance.deployment_profile;
      delete doc.provenance.deployment_profile;
    }),
    "profile_mismatch",
  );
  assert.equal(mutate((doc) => (doc.access.scopes = ["agent:metadata", "agent:read"])), "scope_mismatch");
  assert.equal(mutate((doc) => (doc.access.scopes = ["agent:read"])), "scope_mismatch");
  assert.equal(mutate((doc) => delete doc.access), "scope_mismatch");
  assert.equal(mutate((doc) => (doc.content.included = true)), "content_access_granted");
  assert.equal(mutate((doc) => delete doc.content), "content_access_granted");
  assert.equal(checkWorkspace(good, { profile: "local", workspaceId: WORKSPACE_B }).reason, "workspace_context_mismatch");
});

test("the real capabilities shape is verified, with no access field and sensitive entries unavailable", () => {
  const good = capabilitiesDocument(PROVENANCE);
  assert.equal(good.access, undefined);
  assert.deepEqual(checkCapabilities(good, CONTEXT), { ok: true });

  const mutate = (change) => {
    const doc = clone(good);
    change(doc);
    return checkCapabilities(doc, CONTEXT).reason;
  };
  assert.equal(mutate((doc) => (doc.provenance.workspace_id = WORKSPACE_B)), "workspace_context_mismatch");
  assert.equal(mutate((doc) => (doc.provenance.deployment_profile = "byoc-core")), "profile_mismatch");
  assert.equal(mutate((doc) => (doc.deployment_profile = "managed")), "profile_mismatch");
  assert.equal(mutate((doc) => (doc.agent.trace_content.available = true)), "content_access_granted");
  assert.equal(mutate((doc) => (doc.agent.report_evidence.available = true)), "content_access_granted");
  // Replay is sensitive by privacy class and provider call even though the
  // service reports content false for it.
  assert.equal(good.agent.trace_replay.content, false);
  assert.equal(mutate((doc) => (doc.agent.trace_replay.available = true)), "content_access_granted");
  // external_calls is a boolean on the wire. Anything but false, including
  // a string, makes the entry sensitive.
  for (const value of [true, "none", "configured_provider", undefined]) {
    assert.equal(
      mutate((doc) => (doc.agent.workspace_context.external_calls = value)),
      "content_access_granted",
      String(value),
    );
  }
  assert.equal(mutate((doc) => (doc.agent.workspace_context.content = true)), "content_access_granted");
  assert.equal(mutate((doc) => (doc.agent.usage.privacy_class = "content")), "content_access_granted");
  assert.equal(mutate((doc) => (doc.bounds.content_included_by_default = true)), "content_access_granted");
  for (const version of [1, "1", "metergraph.agent-access/v2", undefined]) {
    assert.equal(mutate((doc) => (doc.schema_version = version)), "capabilities_response_invalid", String(version));
  }
  assert.equal(mutate((doc) => delete doc.agent), "capabilities_response_invalid");
  assert.equal(mutate((doc) => (doc.agent.trace_replay = "yes")), "capabilities_response_invalid");
});

test("the fixtures carry the field types of the service's documents", () => {
  const workspace = workspaceDocument(PROVENANCE, WORKSPACE_A);
  assert.equal(typeof workspace.schema_version, "string");
  assert.deepEqual(Object.keys(workspace).sort(), ["access", "content", "provenance", "retention", "schema_version", "workspace"]);
  assert.deepEqual(Object.keys(workspace.provenance).sort(), ["deployment_profile", "generated_at", "source", "workspace_id"]);
  assert.deepEqual(Object.keys(workspace.workspace).sort(), ["created_at", "id", "name", "slug"]);
  const capabilities = capabilitiesDocument(PROVENANCE);
  assert.deepEqual(Object.keys(capabilities).sort(), [
    "agent",
    "bounds",
    "contracts",
    "deployment_capabilities",
    "deployment_profile",
    "privacy_classes",
    "provenance",
    "schema_version",
  ]);
  assert.equal(capabilities.contracts.agent_access, AGENT_CONTRACT_VERSION);
  for (const entry of Object.values(capabilities.agent)) {
    assert.deepEqual(Object.keys(entry).sort(), [
      "available",
      "content",
      "external_calls",
      "mutates",
      "privacy_class",
      "required_scope",
      "schema",
    ]);
    for (const field of ["available", "content", "mutates", "external_calls"]) {
      assert.equal(typeof entry[field], "boolean", field);
    }
    assert.ok(["metadata", "content", "replay"].includes(entry.privacy_class));
  }
});
