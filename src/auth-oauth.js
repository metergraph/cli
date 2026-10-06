import { createHash, randomBytes } from "node:crypto";

import { AGENT_CONTRACT_VERSION, AUTH_PATHS, METADATA_SCOPE } from "./constants.js";
import { parseJsonObject } from "./http.js";
import { failureOf, send } from "./transport.js";

// OAuth client for the existing Metergraph authorization server. Everything
// here talks to one validated origin through fixed paths. Results are
// { ok: true, ... } or { ok: false, outcome, reason } with fixed tokens only:
// no response body, header, challenge or server text is ever passed on.

const METADATA_BYTES = 32 * 1024;
const TOKEN_BYTES = 32 * 1024;
const WORKSPACE_BYTES = 64 * 1024;
// Capability documents can list many tools, so they get a larger, still
// explicit, bound.
const CAPABILITIES_BYTES = 256 * 1024;

const CLIENT_NAME = "Metergraph CLI";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CLIENT_ID = /^[\x21-\x7e]{1,256}$/;
const ACCESS_TOKEN = /^[\x21-\x7e]{16,8192}$/;
const REFRESH_TOKEN = /^[\x21-\x7e]{16,4096}$/;
const MAX_EXPIRES_IN = 366 * 24 * 60 * 60;

// The access token claim that names the workspace the grant is for. The
// claim is a sanity check only; the CLI does not verify token signatures.
// The server-authoritative check is GET /v1/agent/workspace.
export const TENANT_CLAIM = "tenant_id";

export function endpointsFor(origin) {
  return {
    origin,
    resource: `${origin}${AUTH_PATHS.resource}`,
    issuer: `${origin}${AUTH_PATHS.issuer}`,
    authorization: `${origin}${AUTH_PATHS.authorization}`,
    token: `${origin}${AUTH_PATHS.token}`,
    registration: `${origin}${AUTH_PATHS.registration}`,
    revocation: `${origin}${AUTH_PATHS.revocation}`,
  };
}

const stop = (outcome, reason) => ({ ok: false, outcome, reason });

// Fetches the protected resource metadata (RFC 9728, path-suffixed form, then
// the bare form) and the authorization server metadata (RFC 8414,
// path-inserted form, then the bare form). Every endpoint must equal the
// fixed path on this origin. A server that does not advertise the Metadata
// scope, S256 or public clients is unsupported; there is no fallback to
// another scope.
export async function discover(origin, signal) {
  const expected = endpointsFor(origin);

  const prm = await fetchMetadata(origin, [
    `/.well-known/oauth-protected-resource${AUTH_PATHS.resource}`,
    "/.well-known/oauth-protected-resource",
  ], signal);
  if (!prm.ok) return prm;
  const resource = prm.body;
  if (resource.resource !== expected.resource) return stop("unsupported", "resource_mismatch");
  if (
    !Array.isArray(resource.authorization_servers) ||
    resource.authorization_servers.length !== 1 ||
    resource.authorization_servers[0] !== expected.issuer
  ) {
    return stop("unsupported", "issuer_mismatch");
  }
  if (resource.scopes_supported !== undefined && !includes(resource.scopes_supported, METADATA_SCOPE)) {
    return stop("unsupported", "metadata_scope_unsupported");
  }
  if (resource.bearer_methods_supported !== undefined && !includes(resource.bearer_methods_supported, "header")) {
    return stop("unsupported", "oauth_metadata_invalid");
  }

  const asm = await fetchMetadata(origin, [
    `/.well-known/oauth-authorization-server${AUTH_PATHS.issuer}`,
    "/.well-known/oauth-authorization-server",
  ], signal);
  if (!asm.ok) return asm;
  const server = asm.body;
  if (server.issuer !== expected.issuer) return stop("unsupported", "issuer_mismatch");
  for (const [field, key] of [
    ["authorization_endpoint", "authorization"],
    ["token_endpoint", "token"],
    ["registration_endpoint", "registration"],
  ]) {
    if (server[field] !== expected[key]) return stop("unsupported", "endpoint_not_allowed");
  }
  if (server.revocation_endpoint === undefined) return stop("unsupported", "revocation_unsupported");
  if (server.revocation_endpoint !== expected.revocation) return stop("unsupported", "endpoint_not_allowed");
  if (!includes(server.scopes_supported, METADATA_SCOPE)) {
    return stop("unsupported", "metadata_scope_unsupported");
  }
  if (!includes(server.code_challenge_methods_supported, "S256")) return stop("unsupported", "pkce_unsupported");
  if (!includes(server.token_endpoint_auth_methods_supported, "none")) {
    return stop("unsupported", "public_client_unsupported");
  }
  if (!includes(server.response_types_supported, "code")) return stop("unsupported", "oauth_metadata_invalid");
  if (
    server.grant_types_supported !== undefined &&
    !(includes(server.grant_types_supported, "authorization_code") &&
      includes(server.grant_types_supported, "refresh_token"))
  ) {
    return stop("unsupported", "oauth_metadata_invalid");
  }
  if (
    server.revocation_endpoint_auth_methods_supported !== undefined &&
    !includes(server.revocation_endpoint_auth_methods_supported, "none")
  ) {
    return stop("unsupported", "revocation_unsupported");
  }
  return {
    ok: true,
    endpoints: expected,
    requireIss: server.authorization_response_iss_parameter_supported === true,
  };
}

async function fetchMetadata(origin, paths, signal) {
  for (const path of paths) {
    const response = await send(origin, path, { signal, maxBytes: METADATA_BYTES });
    const failure = failureOf(response);
    if (failure !== null) return { ok: false, ...failure };
    if (response.status === 404) continue;
    if (response.status !== 200) return stop("unsupported", "unexpected_status");
    const body = parseJsonObject(response);
    if (body === null) return stop("unsupported", "invalid_response");
    return { ok: true, body };
  }
  // A server without OAuth metadata predates CLI sign in.
  return stop("unsupported", "oauth_metadata_missing");
}

function includes(list, value) {
  return Array.isArray(list) && list.includes(value);
}

// Dynamic client registration for a public client bound to one exact
// loopback redirect. A response that carries a client secret, a different
// redirect or another authentication method is refused.
export async function register(endpoints, redirectUri, signal) {
  const response = await send(endpoints.origin, AUTH_PATHS.registration, {
    method: "POST",
    signal,
    maxBytes: METADATA_BYTES,
    json: {
      client_name: CLIENT_NAME,
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
      scope: METADATA_SCOPE,
    },
  });
  const failure = failureOf(response);
  if (failure !== null) return { ok: false, ...failure };
  if (response.status === 400) return stop("unsupported", "registration_rejected");
  if (response.status !== 201 && response.status !== 200) return stop("unsupported", "unexpected_status");
  const body = parseJsonObject(response);
  if (body === null || typeof body.client_id !== "string" || !CLIENT_ID.test(body.client_id)) {
    return stop("unsupported", "registration_invalid");
  }
  if (body.client_secret !== undefined && body.client_secret !== null) {
    return stop("unsupported", "registration_invalid");
  }
  if (
    !Array.isArray(body.redirect_uris) ||
    body.redirect_uris.length !== 1 ||
    body.redirect_uris[0] !== redirectUri
  ) {
    return stop("unsupported", "registration_invalid");
  }
  if (body.token_endpoint_auth_method !== undefined && body.token_endpoint_auth_method !== "none") {
    return stop("unsupported", "registration_invalid");
  }
  if (
    body.grant_types !== undefined &&
    !(includes(body.grant_types, "authorization_code") && includes(body.grant_types, "refresh_token"))
  ) {
    return stop("unsupported", "registration_invalid");
  }
  return { ok: true, clientId: body.client_id };
}

export function base64url(buffer) {
  return buffer.toString("base64url");
}

// 32 random bytes each: 256 bits for state, a 43 character verifier.
export function newPkce() {
  const verifier = base64url(randomBytes(32));
  return {
    state: base64url(randomBytes(32)),
    verifier,
    challenge: base64url(createHash("sha256").update(verifier).digest()),
  };
}

// The authorization URL the browser opens. With signup, the browser starts
// at the service's own signup page, which returns to the same authorization
// request on this origin after the account exists.
export function authorizationUrl(endpoints, { clientId, redirectUri, state, challenge, signup }) {
  const url = new URL(endpoints.authorization);
  url.search = new URLSearchParams({
    response_type: "code",
    client_id: clientId,
    redirect_uri: redirectUri,
    scope: METADATA_SCOPE,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource: endpoints.resource,
  }).toString();
  if (!signup) return url.href;
  const entry = new URL(`${endpoints.origin}${AUTH_PATHS.signup}`);
  entry.search = new URLSearchParams({ return_to: `${url.pathname}${url.search}` }).toString();
  return entry.href;
}

// Exchanges an authorization code. Codes are single use, so there is never
// a retry.
export async function exchangeCode(endpoints, { clientId, redirectUri, code, verifier }, signal) {
  const response = await send(endpoints.origin, AUTH_PATHS.token, {
    method: "POST",
    signal,
    maxBytes: TOKEN_BYTES,
    form: {
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: verifier,
      resource: endpoints.resource,
    },
  });
  const failure = failureOf(response);
  if (failure !== null) return { ok: false, ...failure };
  if (response.status === 400 || response.status === 401) return stop("authorization_failed", "code_rejected");
  if (response.status !== 200) return stop("unsupported", "unexpected_status");
  return validateGrant(parseJsonObject(response), endpoints, clientId, { requireRefresh: true });
}

// Refreshes a grant once. The result says whether the refresh token may have
// been consumed without the CLI learning its replacement (ambiguous), so the
// caller never retries with it.
export async function refreshGrant(endpoints, { clientId, refreshToken }, signal) {
  const response = await send(endpoints.origin, AUTH_PATHS.token, {
    method: "POST",
    signal,
    maxBytes: TOKEN_BYTES,
    form: {
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: clientId,
      resource: endpoints.resource,
      scope: METADATA_SCOPE,
    },
  });
  if (response.kind === "error" && !response.sent) {
    return { ok: false, outcome: "connection_failed", reason: response.reason, ambiguous: false };
  }
  if (response.kind === "response" && (response.status === 400 || response.status === 401)) {
    const body = parseJsonObject(response);
    if (body !== null && body.error === "invalid_grant") {
      return { ok: false, outcome: "login_required", reason: "grant_rejected", ambiguous: false };
    }
    if (body !== null && (body.error === "invalid_client" || body.error === "unauthorized_client")) {
      return { ok: false, outcome: "login_required", reason: "grant_rejected", ambiguous: false };
    }
  }
  if (response.kind !== "response" || response.status !== 200 || response.tooLarge) {
    return { ok: false, outcome: "login_required", reason: "refresh_interrupted", ambiguous: true };
  }
  const result = validateGrant(parseJsonObject(response), endpoints, clientId, { requireRefresh: false });
  // A 200 that cannot be used may still have rotated the refresh token.
  return result.ok ? result : { ...result, ambiguous: true };
}

// Accepts only a Bearer grant for exactly the Metadata scope with bounded,
// non-empty tokens and an expiry. The access token claims must name this
// issuer, resource and client and one workspace. These are sanity checks on
// what the server said, not a signature check.
export function validateGrant(body, endpoints, clientId, { requireRefresh }) {
  if (body === null) return stop("verification_failed", "token_response_invalid");
  if (typeof body.token_type !== "string" || body.token_type.toLowerCase() !== "bearer") {
    return stop("verification_failed", "token_type_invalid");
  }
  if (typeof body.access_token !== "string" || !ACCESS_TOKEN.test(body.access_token)) {
    return stop("verification_failed", "token_response_invalid");
  }
  // A refresh may keep the current refresh token by omitting it (RFC 6749
  // section 6). A code exchange must return one.
  const refreshMissing = body.refresh_token === undefined;
  if (refreshMissing) {
    if (requireRefresh) return stop("verification_failed", "token_response_invalid");
  } else if (typeof body.refresh_token !== "string" || !REFRESH_TOKEN.test(body.refresh_token)) {
    return stop("verification_failed", "token_response_invalid");
  }
  if (!Number.isInteger(body.expires_in) || body.expires_in < 1 || body.expires_in > MAX_EXPIRES_IN) {
    return stop("verification_failed", "token_response_invalid");
  }
  if (typeof body.scope !== "string" || body.scope !== METADATA_SCOPE) {
    return stop("verification_failed", "scope_mismatch");
  }

  const claims = decodeClaims(body.access_token);
  if (claims === null) return stop("verification_failed", "token_claims_invalid");
  if (claims.iss !== endpoints.issuer) return stop("verification_failed", "issuer_mismatch");
  const audience = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!audience.includes(endpoints.resource)) return stop("verification_failed", "resource_mismatch");
  if (claims.client_id !== clientId) return stop("verification_failed", "client_mismatch");
  if (claims.scope !== undefined && claims.scope !== METADATA_SCOPE) {
    return stop("verification_failed", "scope_mismatch");
  }
  const tenant = normalizeUuid(claims[TENANT_CLAIM]);
  if (tenant === null) return stop("verification_failed", "token_claims_invalid");
  const now = Date.now();
  if (!Number.isFinite(claims.exp) || claims.exp * 1000 <= now) {
    return stop("verification_failed", "token_claims_invalid");
  }

  return {
    ok: true,
    grant: {
      accessToken: body.access_token,
      refreshToken: refreshMissing ? null : body.refresh_token,
      expiresAt: Math.min(now + body.expires_in * 1000, claims.exp * 1000),
      tenant,
    },
  };
}

function decodeClaims(token) {
  const parts = token.split(".");
  if (parts.length !== 3 || !/^[A-Za-z0-9_-]+$/.test(parts[1])) return null;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(parts[1], "base64url"));
    const value = JSON.parse(text);
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    return value;
  } catch {
    return null;
  }
}

// Asks the service, with the access token, which workspace and profile the
// grant is for and what it may do. The answers are server-authoritative:
//   GET /v1/agent/workspace: workspace.id, provenance.workspace_id and the
//     expected workspace must agree, provenance.deployment_profile must be
//     the profile seen before sign in, access.scopes must be exactly the
//     Metadata scope and content.included must be false. Capture being
//     enabled for the workspace (content.captured) is not a reason to refuse.
//   GET /v1/agent/capabilities: provenance.workspace_id and both
//     provenance.deployment_profile and deployment_profile must match, and
//     every capability that reads content or replays, or calls a configured
//     provider, must be unavailable to this grant.
// Nothing else is read: no telemetry, content or provider requests.
// Returns { ok: true, workspaceId } or { ok: false, outcome, reason, denied }
// where denied means the service refused the token (401 or 403).
export async function verifyContext(origin, accessToken, { profile, workspaceId }, signal) {
  const workspace = await bearerJson(origin, AUTH_PATHS.workspace, accessToken, WORKSPACE_BYTES, signal, "workspace");
  if (!workspace.ok) return workspace;
  const checked = checkWorkspace(workspace.body, { profile, workspaceId });
  if (!checked.ok) return checked;

  const capabilities = await bearerJson(
    origin,
    AUTH_PATHS.capabilities,
    accessToken,
    CAPABILITIES_BYTES,
    signal,
    "capabilities",
  );
  if (!capabilities.ok) return capabilities;
  const allowed = checkCapabilities(capabilities.body, { profile, workspaceId });
  if (!allowed.ok) return allowed;
  return { ok: true, workspaceId };
}

// Both documents carry the service's contract version string in
// schema_version. Any other value, including a number, is a contract this
// CLI does not know.
export function checkWorkspace(body, { profile, workspaceId }) {
  const id = normalizeUuid(body.workspace?.id);
  if (body.schema_version !== AGENT_CONTRACT_VERSION || id === null || !isObject(body.provenance)) {
    return stop("verification_failed", "workspace_response_invalid");
  }
  if (normalizeUuid(body.provenance.workspace_id) !== id || id !== workspaceId) {
    return stop("verification_failed", "workspace_context_mismatch");
  }
  if (body.provenance.deployment_profile !== profile) return stop("verification_failed", "profile_mismatch");
  const scopes = body.access?.scopes;
  if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== METADATA_SCOPE) {
    return stop("verification_failed", "scope_mismatch");
  }
  if (!isObject(body.content) || body.content.included !== false) {
    return stop("verification_failed", "content_access_granted");
  }
  return { ok: true };
}

export function checkCapabilities(body, { profile, workspaceId }) {
  if (body.schema_version !== AGENT_CONTRACT_VERSION || !isObject(body.provenance) || !isObject(body.agent)) {
    return stop("verification_failed", "capabilities_response_invalid");
  }
  if (normalizeUuid(body.provenance.workspace_id) !== workspaceId) {
    return stop("verification_failed", "workspace_context_mismatch");
  }
  if (body.provenance.deployment_profile !== profile || body.deployment_profile !== profile) {
    return stop("verification_failed", "profile_mismatch");
  }
  for (const entry of Object.values(body.agent)) {
    if (!isObject(entry)) return stop("verification_failed", "capabilities_response_invalid");
    const sensitive =
      entry.content !== false ||
      entry.privacy_class !== "metadata" ||
      entry.external_calls !== false;
    // An entry that is not plainly metadata-only must be unavailable.
    if (sensitive && entry.available !== false) return stop("verification_failed", "content_access_granted");
  }
  if (isObject(body.bounds) && body.bounds.content_included_by_default !== false) {
    return stop("verification_failed", "content_access_granted");
  }
  return { ok: true };
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

// Lower case form of a UUID, or null.
export function normalizeUuid(value) {
  return typeof value === "string" && UUID.test(value) ? value.toLowerCase() : null;
}

async function bearerJson(origin, path, accessToken, maxBytes, signal, document) {
  const response = await send(origin, path, { signal, maxBytes, bearer: accessToken });
  const failure = failureOf(response);
  if (failure !== null) return { ok: false, ...failure };
  if (response.status === 401 || response.status === 403) {
    return { ok: false, outcome: "verification_failed", reason: "access_rejected", denied: true };
  }
  if (response.status !== 200) return stop("unsupported", "unexpected_status");
  const body = parseJsonObject(response);
  if (body === null) return stop("verification_failed", `${document}_response_invalid`);
  return { ok: true, body };
}

// RFC 7009 revocation of a refresh token as the public client that holds it.
// Returns "accepted" for a 200, which means the request was accepted, and
// "unconfirmed" for anything else.
export async function revoke(endpoints, { clientId, refreshToken }, signal) {
  const response = await send(endpoints.origin, AUTH_PATHS.revocation, {
    method: "POST",
    signal,
    maxBytes: TOKEN_BYTES,
    form: { token: refreshToken, token_type_hint: "refresh_token", client_id: clientId },
  });
  return response.kind === "response" && response.status === 200 ? "accepted" : "unconfirmed";
}
