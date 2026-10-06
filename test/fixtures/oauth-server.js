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

  function route(request, response, url, body) {
    const path = url.pathname;
    if (path === "/healthz") return send(response, 200, { ok: true });
    if (path === "/v1/deployment") return send(response, 200, { deployment_profile: behavior.profile });
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
    if (path === "/v1/agent/workspace" || path === "/v1/agent/capabilities") {
      return bearer(request, response, path);
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
    };
  }

  function registerClient(response, body) {
    let request;
    try {
      request = JSON.parse(body);
    } catch {
      return send(response, 400, { error: "invalid_client_metadata" });
    }
    const clientId = `client-${randomBytes(8).toString("hex")}`;
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
      params.get("redirect_uri") === client.redirectUri &&
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
    const target = new URL(client.redirectUri);
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
        redirectUri: client.redirectUri,
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

  function bearer(request, response, path) {
    const header = request.headers.authorization ?? "";
    const grant = header.startsWith("Bearer ") ? state.access.get(header.slice(7)) : undefined;
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
    served.capabilities = behavior.capabilities(capabilitiesDocument(provenance));
    return send(response, 200, served.capabilities);
  }

  // The last bearer documents actually sent, so tests can assert the wire shape.
  const served = { workspace: null, capabilities: null };

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
