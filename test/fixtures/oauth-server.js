// A synthetic Metergraph service on loopback for sign in tests. It speaks the
// public wire contract: deployment probe, OAuth protected resource and
// authorization server metadata, dynamic client registration, authorization
// with PKCE, token exchange and rotation, RFC 7009 revocation, and the
// bearer-protected workspace and capabilities documents. Its authorize
// endpoint stands in for a signed in person who consents in the browser.
// Every value is synthetic. Tests change behavior through server.behavior.
import { createHash, randomBytes, randomUUID } from "node:crypto";
import http from "node:http";

export const WORKSPACE_A = "0b5c7c1e-1a2b-4c3d-8e4f-5a6b7c8d9e01";
export const WORKSPACE_B = "6f1e2d3c-4b5a-4968-8776-655443322110";

const b64 = (value) => Buffer.from(typeof value === "string" ? value : JSON.stringify(value)).toString("base64url");

export async function startOAuthServer(initial = {}) {
  const behavior = {
    profile: "local",
    // What GET /v1/deployment reports, when it should differ from profile,
    // and its status.
    deploymentProfile: null,
    deploymentStatus: 200,
    workspaceId: WORKSPACE_A,
    // Hooks that may rewrite a document or response just before it is sent.
    prm: (doc) => doc,
    asm: (doc) => doc,
    registration: (doc) => doc,
    token: (doc) => doc,
    claims: (claims) => claims,
    workspace: (doc) => doc,
    capabilities: (doc) => doc,
    // "consent", "deny", "ignore" (never redirect) or "bad-request".
    authorize: "consent",
    includeIss: true,
    // "rotate", "hang", "server-error" or "drop".
    refresh: "rotate",
    // HTTP status for revocation, or "drop" to close the socket.
    revokeStatus: 200,
    // Status for bearer endpoints when the token is otherwise valid, for
    // example 403 after membership loss.
    bearerStatus: 200,
    expiresIn: 3600,
    // Metadata read endpoints: hooks that rewrite each document, a status
    // used instead of 200 (with readHeaders), and readRaw, which may answer
    // the request itself and return true.
    usage: (doc) => doc,
    routes: (doc) => doc,
    traces: (doc) => doc,
    readStatus: 200,
    readHeaders: {},
    readRaw: null,
    setup: false,
    setupMetadata: (doc) => doc,
    setupAuthorize: () => {},
    setupRedeem: "issue", // issue, drop-before-issue, drop-after-issue, reject
    setupCredentialReject: false,
    // A pre-registered CLI client ID that both metadata documents offer, or
    // null for a service that only supports dynamic registration.
    cliClientId: null,
    // Static agent read tokens an operator configured, accepted on the
    // bearer documents for the behavior's workspace, as MG_AGENT_TOKENS are.
    agentTokens: [],
    ...initial,
  };

  const state = {
    clients: new Map(),
    codes: new Map(),
    refresh: new Map(),
    access: new Map(),
    requests: [],
    // Every credential value the server issued, so tests can prove none of
    // them is ever printed.
    issued: [],
    setupFamilies: new Map(),
    setupReceipts: new Map(),
  };

  const sockets = new Set();
  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url, "http://fixture.invalid");
    const body = await readBody(request);
    state.requests.push({
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: request.headers,
      body,
    });
    try {
      route(request, response, url, body);
    } catch {
      send(response, 500, { error: "server_error", detail: "SYNTHETIC_BODY_MARKER" });
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const issuer = `${origin}/v1/oauth`;
  const resource = `${origin}/v1/agent/mcp`;
  // Configures a pre-registered CLI client and offers its ID, as a service
  // does once an operator adds it. Its loopback redirect matches any port.
  function configureCliClient(clientId) {
    behavior.cliClientId = clientId;
    state.clients.set(clientId, { redirectUri: "http://127.0.0.1/callback", anyPort: true });
  }
  if (behavior.cliClientId !== null) configureCliClient(behavior.cliClientId);

  function route(request, response, url, body) {
    const path = url.pathname;
    if (path === "/healthz") return send(response, 200, { ok: true });
    if (path === "/v1/deployment") {
      if (behavior.deploymentStatus !== 200) return send(response, behavior.deploymentStatus, { error: "not_found" });
      return send(response, 200, { deployment_profile: behavior.deploymentProfile ?? behavior.profile });
    }
    // A hook that returns null emulates a server without that document.
    if (path === "/.well-known/oauth-protected-resource/v1/agent/mcp") {
      const doc = behavior.prm(protectedResource());
      return doc === null ? send(response, 404, { error: "not_found" }) : send(response, 200, doc);
    }
    if (path === "/.well-known/oauth-authorization-server/v1/oauth") {
      const doc = behavior.asm(authorizationServer());
      return doc === null ? send(response, 404, { error: "not_found" }) : send(response, 200, doc);
    }
    if (path === "/v1/oauth/register" && request.method === "POST") return registerClient(response, body);
    if (behavior.setup && path.startsWith("/v1/cli/setup/")) return setupRoute(request, response, path, url, body);
    if (path === "/v1/oauth/authorize" && request.method === "GET") return authorize(response, url.searchParams);
    if (path === "/v1/auth/signup" && request.method === "GET") {
      const returnTo = url.searchParams.get("return_to") ?? "";
      if (behavior.profile !== "managed" || !returnTo.startsWith("/v1/oauth/authorize?")) {
        return send(response, 400, { error: "invalid_request" });
      }
      response.writeHead(302, { location: returnTo });
      return response.end();
    }
    if (path === "/v1/oauth/token" && request.method === "POST") return token(response, new URLSearchParams(body));
    if (path === "/v1/oauth/revoke" && request.method === "POST") return revokeToken(response, new URLSearchParams(body));
    if (path === "/v1/agent/workspace" || path === "/v1/agent/capabilities" || READ_DOCUMENTS[path]) {
      return bearer(request, response, path, url.searchParams);
    }
    return send(response, 404, { error: "not_found" });
  }

  function setupRoute(request, response, path, url, body) {
    const base = `${origin}/v1/cli/setup`;
    if (path === "/v1/cli/setup/metadata" && request.method === "GET") return send(response, 200,
      behavior.setupMetadata({ schema_version: "metergraph.cli-setup/v1", supported: true, unsupported_reason: null,
        resource: base, authorization_endpoint: `${base}/authorize`, redemption_endpoint: `${base}/redeem`,
        credential_endpoint: `${base}/credential`, registration_endpoint: `${origin}/v1/oauth/register`,
        deployment_profile: behavior.profile, profiles_supported: ["local", "managed", "byoc-core"],
        purpose: "ingest-bootstrap-v1", intents_supported: ["create", "replace_pending", "repair"],
        code_challenge_methods_supported: ["S256"], credential_scope: "ingest", receipt_lifetime_seconds: 300,
        ...offered() }));
    if (path === "/v1/cli/setup/authorize" && request.method === "GET") {
      const params = url.searchParams;
      behavior.setupAuthorize(params);
      const family = state.setupFamilies.get(params.get("family_id"));
      const intent = params.get("intent");
      if (!state.clients.has(params.get("client_id")) || !["create", "replace_pending", "repair"].includes(intent) ||
          params.get("workspace_id") !== behavior.workspaceId || params.get("code_challenge_method") !== "S256" ||
          (intent === "create" && family) || (intent === "replace_pending" && family && family.delivery !== "pending") ||
          (intent === "repair" && (family?.delivery !== "acknowledged" || family?.keyId !== params.get("expected_key_id")))) {
        return send(response, 409, { error: "setup_state_mismatch" });
      }
      const resolvedIntent = intent === "replace_pending" && !family ? "create" : intent;
      const receipt = `mgbs_${randomBytes(32).toString("base64url")}`;
      state.setupReceipts.set(receipt, { familyId: params.get("family_id"), intent: resolvedIntent, challenge: params.get("code_challenge"),
        clientId: params.get("client_id"), redirectUri: params.get("redirect_uri"), workspaceId: params.get("workspace_id") });
      const target = new URL(params.get("redirect_uri"));
      target.searchParams.set("code", receipt);
      target.searchParams.set("state", params.get("state"));
      response.writeHead(302, { location: target.href });
      return response.end();
    }
    if (path === "/v1/cli/setup/redeem" && request.method === "POST") {
      if (behavior.setupRedeem === "drop-before-issue") return response.socket.destroy();
      const form = new URLSearchParams(body);
      const receipt = state.setupReceipts.get(form.get("code"));
      state.setupReceipts.delete(form.get("code"));
      if (receipt === undefined || behavior.setupRedeem === "reject" ||
          form.get("client_id") !== receipt.clientId || form.get("redirect_uri") !== receipt.redirectUri ||
          form.get("family_id") !== receipt.familyId || form.get("workspace_id") !== receipt.workspaceId ||
          createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url") !== receipt.challenge) {
        return send(response, 400, { error: "invalid_grant" });
      }
      const token = `mg_${randomBytes(32).toString("base64url")}`;
      const keyId = randomUUID();
      state.issued.push(token);
      state.setupFamilies.set(receipt.familyId, { keyId, token, delivery: "pending" });
      if (behavior.setupRedeem === "drop-after-issue") return response.socket.destroy();
      return send(response, 200, { schema_version: "metergraph.cli-setup/v1", token_type: "ingest",
        ingest_token: token, scope: "ingest", delivery_state: "pending", workspace_id: receipt.workspaceId,
        family_id: receipt.familyId, key_id: keyId, deployment: { origin, profile: behavior.profile } });
    }
    if (path === "/v1/cli/setup/credential") {
      if (behavior.setupCredentialReject) return send(response, 401, { error: "invalid_token" });
      const familyId = request.method === "GET" ? url.searchParams.get("family_id") : new URLSearchParams(body).get("family_id");
      const family = state.setupFamilies.get(familyId);
      if (!family || request.headers.authorization !== `Bearer ${family.token}`) return send(response, 401, { error: "invalid_token" });
      if (request.method === "POST") family.delivery = "acknowledged";
      return send(response, 200, { schema_version: "metergraph.cli-setup/v1",
        provenance: { origin, deployment_profile: behavior.profile, purpose: "ingest-bootstrap-v1" },
        workspace_id: behavior.workspaceId, family_id: familyId, key_id: family.keyId,
        delivery_state: family.delivery, scopes: ["ingest"] });
    }
    return send(response, 404, { error: "not_found" });
  }

  function protectedResource() {
    return {
      resource,
      authorization_servers: [issuer],
      scopes_supported: ["agent:metadata", "agent:read", "agent:replay"],
      bearer_methods_supported: ["header"],
    };
  }

  function authorizationServer() {
    return {
      issuer,
      authorization_endpoint: `${origin}/v1/oauth/authorize`,
      token_endpoint: `${origin}/v1/oauth/token`,
      registration_endpoint: `${origin}/v1/oauth/register`,
      revocation_endpoint: `${origin}/v1/oauth/revoke`,
      scopes_supported: ["agent:metadata", "agent:read", "agent:replay"],
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      revocation_endpoint_auth_methods_supported: ["none"],
      authorization_response_iss_parameter_supported: true,
      ...offered(),
    };
  }

  function offered() {
    return behavior.cliClientId === null ? {} : { metergraph_cli_client_id: behavior.cliClientId };
  }

  // Exact match, or any port on the registered loopback redirect for the
  // pre-registered client (RFC 8252 section 7.3).
  function redirectMatches(client, requested) {
    if (requested === client.redirectUri) return true;
    if (!client.anyPort || requested === null) return false;
    const want = new URL(client.redirectUri);
    const got = URL.canParse(requested) ? new URL(requested) : null;
    return got !== null && got.protocol === "http:" && got.hostname === want.hostname &&
      got.pathname === want.pathname && got.search === "" && got.hash === "";
  }

  function registerClient(response, body) {
    let request;
    try {
      request = JSON.parse(body);
    } catch {
      return send(response, 400, { error: "invalid_client_metadata" });
    }
    // The service's prefix for dynamically registered clients.
    const clientId = `mgc_${randomBytes(8).toString("hex")}`;
    state.clients.set(clientId, { redirectUri: request.redirect_uris?.[0] });
    return send(
      response,
      201,
      behavior.registration({
        client_id: clientId,
        client_name: request.client_name,
        redirect_uris: request.redirect_uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      }),
    );
  }

  function authorize(response, params) {
    const client = state.clients.get(params.get("client_id"));
    const valid =
      client !== undefined &&
      redirectMatches(client, params.get("redirect_uri")) &&
      params.get("response_type") === "code" &&
      params.get("scope") === "agent:metadata" &&
      params.get("code_challenge_method") === "S256" &&
      /^[A-Za-z0-9_-]{43}$/.test(params.get("code_challenge") ?? "") &&
      params.get("resource") === resource &&
      (params.get("state") ?? "").length >= 32;
    if (!valid || behavior.authorize === "bad-request") {
      return send(response, 400, { error: "invalid_request", detail: "SYNTHETIC_BODY_MARKER" });
    }
    if (behavior.authorize === "ignore") return send(response, 200, { waiting: true });
    const redirectUri = params.get("redirect_uri");
    const target = new URL(redirectUri);
    target.searchParams.set("state", params.get("state"));
    if (behavior.includeIss) target.searchParams.set("iss", issuer);
    if (behavior.authorize === "deny") {
      target.searchParams.set("error", "access_denied");
      target.searchParams.set("error_description", "SYNTHETIC_BODY_MARKER");
    } else {
      const code = `code-${randomBytes(16).toString("hex")}`;
      state.issued.push(code);
      state.codes.set(code, {
        clientId: params.get("client_id"),
        redirectUri,
        challenge: params.get("code_challenge"),
        workspaceId: behavior.workspaceId,
      });
      target.searchParams.set("code", code);
    }
    response.writeHead(302, { location: target.href });
    return response.end();
  }

  function issue(clientId, workspaceId, family) {
    const claims = behavior.claims({
      iss: issuer,
      aud: resource,
      sub: "synthetic-user",
      client_id: clientId,
      tenant_id: workspaceId,
      scope: "agent:metadata",
      exp: Math.floor(Date.now() / 1000) + behavior.expiresIn,
      jti: randomUUID(),
    });
    const accessToken = `${b64({ alg: "none", typ: "at+jwt" })}.${b64(claims)}.${b64("SYNTHETIC_SIGNATURE")}`;
    const refreshToken = `refresh-${randomBytes(24).toString("hex")}`;
    state.issued.push(accessToken, refreshToken);
    state.access.set(accessToken, { clientId, workspaceId, family });
    state.refresh.set(refreshToken, { clientId, workspaceId, family, used: false });
    return behavior.token({
      access_token: accessToken,
      token_type: "Bearer",
      expires_in: behavior.expiresIn,
      refresh_token: refreshToken,
      scope: "agent:metadata",
    });
  }

  function token(response, form) {
    const invalid = () => send(response, 400, { error: "invalid_grant", error_description: "SYNTHETIC_BODY_MARKER" });
    if (form.get("resource") !== resource) return invalid();
    if (form.get("grant_type") === "authorization_code") {
      const code = state.codes.get(form.get("code"));
      state.codes.delete(form.get("code"));
      if (code === undefined) return invalid();
      const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
      if (
        code.clientId !== form.get("client_id") ||
        code.redirectUri !== form.get("redirect_uri") ||
        challenge !== code.challenge
      ) {
        return invalid();
      }
      return send(response, 200, issue(code.clientId, code.workspaceId, randomUUID()));
    }
    if (form.get("grant_type") === "refresh_token") {
      if (behavior.refresh === "hang") return;
      if (behavior.refresh === "drop") return response.socket.destroy();
      if (behavior.refresh === "server-error") return send(response, 500, { error: "server_error" });
      const grant = state.refresh.get(form.get("refresh_token"));
      if (grant === undefined || grant.clientId !== form.get("client_id")) return invalid();
      if (grant.used || grant.revoked) {
        revokeFamily(grant.family);
        return invalid();
      }
      grant.used = true;
      return send(response, 200, issue(grant.clientId, grant.workspaceId, grant.family));
    }
    return send(response, 400, { error: "unsupported_grant_type" });
  }

  function revokeFamily(family) {
    for (const map of [state.refresh, state.access]) {
      for (const entry of map.values()) if (entry.family === family) entry.revoked = true;
    }
  }

  function revokeToken(response, form) {
    if (behavior.revokeStatus === "drop") return response.socket.destroy();
    const grant = state.refresh.get(form.get("token"));
    if (grant !== undefined && grant.clientId === form.get("client_id")) revokeFamily(grant.family);
    response.writeHead(behavior.revokeStatus, { "content-type": "application/json" });
    return response.end("{}");
  }

  function bearer(request, response, path, query) {
    const header = request.headers.authorization ?? "";
    const presented = header.startsWith("Bearer ") ? header.slice(7) : null;
    const grant = presented === null ? undefined : state.access.get(presented) ??
      (behavior.agentTokens.includes(presented) ? { workspaceId: behavior.workspaceId, revoked: false } : undefined);
    if (grant === undefined || grant.revoked) {
      response.writeHead(401, {
        "content-type": "application/json",
        "www-authenticate": 'Bearer realm="SYNTHETIC_CHALLENGE_MARKER"',
      });
      return response.end(JSON.stringify({ error: "unauthorized", detail: "SYNTHETIC_BODY_MARKER" }));
    }
    if (behavior.bearerStatus !== 200) return send(response, behavior.bearerStatus, { error: "forbidden" });
    const provenance = {
      deployment_profile: behavior.profile,
      workspace_id: grant.workspaceId,
      generated_at: new Date().toISOString(),
      source: "synthetic-fixture",
    };
    if (path === "/v1/agent/workspace") {
      served.workspace = behavior.workspace(workspaceDocument(provenance, grant.workspaceId));
      return send(response, 200, served.workspace);
    }
    if (READ_DOCUMENTS[path]) {
      if (behavior.readRaw !== null && behavior.readRaw(request, response, path, query)) return undefined;
      if (behavior.readStatus !== 200) {
        response.writeHead(behavior.readStatus, { "content-type": "application/json", ...behavior.readHeaders });
        return response.end(JSON.stringify({ error: "refused", detail: "SYNTHETIC_BODY_MARKER" }));
      }
      const { name, build } = READ_DOCUMENTS[path];
      served.read = behavior[name](build(provenance, query), query);
      return send(response, 200, served.read);
    }
    served.capabilities = behavior.capabilities(capabilitiesDocument(provenance));
    return send(response, 200, served.capabilities);
  }

  // The last bearer documents actually sent, so tests can assert the wire shape.
  const served = { workspace: null, capabilities: null, read: null };

  return {
    origin,
    issuer,
    resource,
    behavior,
    state,
    served,
    requests: state.requests,
    issued: state.issued,
    requestsTo: (path) => state.requests.filter((entry) => entry.path === path),
    configureCliClient,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

// The service's agent access contract version. Both bearer documents send
// this exact string in schema_version; it is not a number.
export const CONTRACT_VERSION = "metergraph.agent-access/v1";

// The real workspace document shape. The name and slug carry a marker so
// tests prove server text is never printed.
export function workspaceDocument(provenance, workspaceId) {
  return {
    schema_version: CONTRACT_VERSION,
    provenance,
    workspace: {
      id: workspaceId,
      slug: "synthetic-SYNTHETIC_BODY_MARKER",
      name: "SYNTHETIC_BODY_MARKER workspace",
      created_at: "2026-01-01T00:00:00Z",
    },
    retention: { metadata_days: 90 },
    content: { captured: true, included: false },
    access: { scopes: ["agent:metadata"] },
  };
}

// The real capabilities document shape for a Metadata grant: no access
// field, external_calls is a boolean, and the content, evidence and replay
// entries are listed but unavailable. Entry names and field types follow
// what the service sends; descriptions and field lists are shortened.
const capability = (available, content, privacyClass, requiredScope, schema, externalCalls) => ({
  available,
  content,
  mutates: false,
  privacy_class: privacyClass,
  required_scope: requiredScope,
  schema,
  external_calls: externalCalls,
});

export function capabilitiesDocument(provenance) {
  const metadata = (schema) => capability(true, false, "metadata", "agent:metadata", schema, false);
  return {
    schema_version: CONTRACT_VERSION,
    provenance,
    deployment_profile: provenance.deployment_profile,
    deployment_capabilities: ["agent_api", "telemetry", "workspace_settings"],
    agent: {
      workspace_context: metadata("agent-access/workspace-context"),
      capability_discovery: metadata("agent-access/capabilities"),
      routes: metadata("agent-access/routes"),
      usage: metadata("agent-access/usage"),
      trace_metadata: metadata("agent-access/trace-metadata"),
      report_evidence: capability(false, false, "content", "agent:read", "agent-access/report-evidence", false),
      trace_content: capability(false, true, "content", "agent:read", "trace-debug/trace", false),
      trace_replay: capability(false, false, "replay", "agent:replay", "trace-debug/replay", true),
    },
    privacy_classes: {
      content: { description: "Synthetic content class.", fields: ["identifiers", "spans[].content.request.text"] },
      metadata: { description: "Synthetic metadata class.", fields: ["identifiers", "status"] },
      replay: { description: "Synthetic replay class.", fields: ["identifiers", "comparison.replay.output"] },
    },
    contracts: { agent_access: CONTRACT_VERSION, trace_debug: "metergraph.trace-debug/v1" },
    bounds: { max_days: 90, max_rows: 200, max_response_bytes: 5242880, content_included_by_default: false },
  };
}

// Synthetic Metadata read documents in the service's actual field types:
// schema_version is the contract string, latency may be null, cost is a
// number (nullable on traces), counts are integers. Route descriptions,
// constraints and evaluation contracts carry a marker so tests prove they are
// never printed.
const DAY_MS = 24 * 60 * 60 * 1000;

export const USAGE_ROWS = Object.freeze([
  {
    date: "2026-01-02",
    route: "checkout-summary",
    calls: 40,
    cost_usd: 0.0125,
    input_tokens: 12000,
    output_tokens: 3400,
    avg_latency_ms: 820,
    p95_latency_ms: 1900,
    error_calls: 2,
  },
  {
    date: "2026-01-02",
    route: "support-triage",
    calls: 12,
    cost_usd: 0.004,
    input_tokens: 3000,
    output_tokens: 900,
    avg_latency_ms: null,
    p95_latency_ms: null,
    error_calls: 0,
  },
  {
    date: "2026-01-03",
    route: "checkout-summary",
    calls: 25,
    cost_usd: 0.0081,
    input_tokens: 7600,
    output_tokens: 2100,
    avg_latency_ms: 790,
    p95_latency_ms: 1650,
    error_calls: 1,
  },
]);

export function usageDocument(provenance, query) {
  const days = Number(query.get("days"));
  const limit = Number(query.get("limit"));
  const items = USAGE_ROWS.slice(0, limit).map((row) => ({ ...row }));
  return {
    schema_version: CONTRACT_VERSION,
    provenance,
    window: {
      days,
      since: new Date(Date.now() - days * DAY_MS).toISOString(),
      until: new Date().toISOString(),
    },
    evidence: { sources: ["telemetry"], rows: items.length, complete: true },
    warnings: [],
    days,
    content_included: false,
    truncated: USAGE_ROWS.length > limit,
    items,
  };
}

export function routesDocument(provenance) {
  return {
    schema_version: CONTRACT_VERSION,
    provenance,
    routes: [
      {
        route: "checkout-summary",
        description: "SYNTHETIC_BODY_MARKER description",
        constraints: { max_cost_usd: 0.01, note: "SYNTHETIC_BODY_MARKER constraint" },
        evaluation_contract: { rubric: "SYNTHETIC_BODY_MARKER rubric" },
        evaluation_contract_version: 3,
        evaluation_contract_hash: "sha256:0f1e2d3c4b5a",
        updated_at: "2026-01-01T00:00:00Z",
        calls: 65,
        replay_eligible_calls: 10,
      },
      {
        route: "support-triage",
        description: null,
        constraints: {},
        evaluation_contract: null,
        evaluation_contract_version: null,
        evaluation_contract_hash: null,
        updated_at: "2026-01-01T00:00:00Z",
        calls: 12,
        replay_eligible_calls: 0,
      },
      {
        route: "nightly-digest",
        description: "SYNTHETIC_BODY_MARKER digest",
        constraints: {},
        evaluation_contract: { checks: ["SYNTHETIC_BODY_MARKER"] },
        evaluation_contract_version: "2",
        evaluation_contract_hash: "sha256:a1b2c3d4e5f6",
        updated_at: "2026-01-02T00:00:00.123456+00:00",
        calls: 3,
        replay_eligible_calls: 3,
      },
    ],
  };
}

export const TRACE_ROWS = Object.freeze(
  [
    ["0001", "success", ["checkout-summary"], 0.0031],
    ["0002", "error", ["support-triage"], null],
    ["0003", "success", ["checkout-summary", "support-triage"], 0.0012],
  ].map(([n, status, routes, cost], index) => ({
    id: `7d1c2b3a-0000-4000-8000-00000000${n}`,
    trace_id: `trace-${n}`,
    trace_name: `synthetic trace ${n}`,
    started_at: `2026-01-0${3 - index}T10:00:00Z`,
    last_span_at: `2026-01-0${3 - index}T10:00:05.250000+00:00`,
    span_count: 4,
    input_tokens: 1200,
    output_tokens: 300,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: cost,
    status,
    routes,
    providers: ["example-provider"],
    models: ["example-model-small"],
  })),
);

// The cursor is opaque to the CLI. Here it is "page:OFFSET".
export function tracesDocument(provenance, query) {
  const days = Number(query.get("days"));
  const limit = Number(query.get("limit"));
  const offset = query.has("cursor") ? Number(query.get("cursor").slice(5)) : 0;
  const rows = TRACE_ROWS.filter(
    (row) =>
      (!query.has("status") || row.status === query.get("status")) &&
      (!query.has("route") || row.routes.includes(query.get("route"))),
  );
  const traces = rows.slice(offset, offset + limit).map((row) => ({ ...row }));
  const truncated = offset + limit < rows.length;
  const next = truncated ? `page:${offset + limit}` : null;
  return {
    schema_version: CONTRACT_VERSION,
    provenance,
    window: {
      days,
      since: new Date(Date.now() - days * DAY_MS).toISOString(),
      until: new Date().toISOString(),
    },
    evidence: { sources: ["telemetry"], rows: traces.length, complete: true },
    warnings: [],
    page: { limit, truncated, next_cursor: next },
    content_included: false,
    truncated,
    next_cursor: next,
    traces,
  };
}

const READ_DOCUMENTS = {
  "/v1/agent/usage": { name: "usage", build: usageDocument },
  "/v1/agent/routes": { name: "routes", build: routesDocument },
  "/v1/agent/traces": { name: "traces", build: tracesDocument },
};

function readBody(request) {
  return new Promise((resolve) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    request.on("error", () => resolve(""));
  });
}

function send(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
