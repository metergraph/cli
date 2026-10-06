import { readBinding, resolveProject } from "./auth-binding.js";
import { checkDeployment } from "./doctor.js";
import { sessionFor } from "./auth-session.js";
import { Stop, openStore, resolveConfigDir } from "./auth-store.js";
import { MAX_BODY_BYTES, METADATA_SCOPE, READ_MAX_BYTES, READ_PATHS } from "./constants.js";
import { parseJsonObject } from "./http.js";
import {
  CAPABILITY_NAMES,
  capabilitySummary,
  routesReport,
  tracesReport,
  usageReport,
  workspaceContext,
} from "./read-contract.js";
import { deadline, failureOf, send, trapSignals } from "./transport.js";

// The read commands: status, context, capabilities, usage, routes and traces.
// Each one uses the project's existing verified session (never a browser,
// never a new grant), shares one total deadline across every request,
// including a token refresh, and sends GET requests only, to fixed paths on
// the bound origin. Nothing is written except what the session helper writes
// when it refreshes the grant. Each returns { outcome, reason, data } where
// data holds only validated fields and fixed tokens, and never a credential
// value this run holds, even inside an otherwise valid name.

// Which capability each endpoint read needs.
const READS = Object.freeze({
  usage: { capability: "usage", path: READ_PATHS.usage, validate: usageReport },
  routes: { capability: "routes", path: READ_PATHS.routes, validate: routesReport },
  traces: { capability: "trace_metadata", path: READ_PATHS.traces, validate: tracesReport },
});

export async function runRead(options) {
  const ctx = {
    command: options.command,
    origin: null,
    workspaceId: null,
    profile: null,
    configured: false,
    reachable: null,
    healthy: null,
    profileVerified: null,
    authenticated: false,
    verifiedWorkspace: null,
    capabilities: null,
  };
  const notices = new Set();
  const trap = trapSignals();
  const limit = deadline(options.timeoutMs, trap.signal);
  // Token values this run holds. Filled after the session is verified.
  let known = [];
  const build = (outcome, report) =>
    options.command === "status" ? statusData(ctx, notices, outcome) : readData(ctx, report, notices, outcome);
  const end = (outcome, reason, report = null) => {
    const data = build(outcome, report);
    // Validated metadata can still be any string the service chose. If any
    // printed string holds a credential this run knows, nothing is printed.
    if (holdsKnown(data, known)) {
      notices.clear();
      return {
        outcome: "verification_failed",
        reason: "credential_in_metadata_response",
        data: build("verification_failed", null),
      };
    }
    return { outcome, reason, data };
  };
  // A deadline or Ctrl+C reported by a lower layer as a timeout or
  // cancellation is reported here by what actually happened.
  const settle = (result) => {
    const interrupted =
      (result.outcome === "authorization_failed" && result.reason === "cancelled") ||
      (result.outcome === "connection_failed" && result.reason === "timeout");
    if (interrupted && limit.timedOut()) return { outcome: "connection_failed", reason: "timeout" };
    if (interrupted && trap.signal.aborted) return { outcome: "cancelled", reason: "cancelled" };
    return result;
  };

  try {
    const root = resolveProject(options.project);
    const configDir = resolveConfigDir(options.configDir);
    const found = readBinding(root);
    if (found === null) return end("login_required", "not_signed_in");
    const binding = found.binding;
    Object.assign(ctx, {
      origin: binding.origin,
      workspaceId: binding.workspace_id,
      profile: binding.deployment_profile,
      configured: true,
    });
    const store = openStore(configDir, { create: false });

    if (options.command === "status") {
      const health = await checkHealth(binding.origin, limit.signal);
      ctx.reachable = health.reachable;
      ctx.healthy = health.healthy;
      if (!health.ok) {
        const settled = settle(health);
        return end(settled.outcome, settled.reason);
      }
      // The service's own unauthenticated profile report must be the bound
      // profile before the grant is even tried.
      const deployment = checkDeployment(
        await send(binding.origin, "/v1/deployment", { signal: limit.signal, maxBytes: MAX_BODY_BYTES }),
      );
      if (deployment.outcome !== null) {
        if (deployment.outcome === "unhealthy") ctx.healthy = false;
        const settled = settle(deployment);
        return end(settled.outcome, settled.reason);
      }
      ctx.profileVerified = deployment.profile === binding.deployment_profile;
      if (!ctx.profileVerified) return end("verification_failed", "profile_mismatch");
    }

    const session = await sessionFor(binding, store, limit.signal);
    if (!session.ok) {
      const settled = settle(session);
      return end(settled.outcome, settled.reason);
    }
    known = session.knownCredentials;
    ctx.authenticated = true;
    const { documents } = session;

    // Notices describe what a command prints, so documents a command only
    // checks report theirs into a set that is dropped.
    const printed = (command) => (options.command === command ? notices : new Set());
    const capabilities = capabilitySummary(documents.capabilities, ctx, printed("capabilities"));
    if (!capabilities.ok) return end(capabilities.outcome, capabilities.reason);
    ctx.capabilities = capabilities.value;

    if (options.command === "status" || options.command === "context") {
      const context = workspaceContext(documents.workspace, ctx, printed("context"));
      if (!context.ok) return end(context.outcome, context.reason);
      ctx.verifiedWorkspace = context.value.workspace.id;
      if (options.command === "status") {
        notices.add("application_traffic_not_verified");
        return end("ok", null);
      }
      return end("ok", null, context.value);
    }
    if (options.command === "capabilities") return end("ok", null, capabilities.value);

    const read = READS[options.command];
    const entry = capabilities.value.agent[read.capability];
    if (entry === null || entry.available !== true) return end("capability_unavailable", "capability_unavailable");
    // The service's own bounds; a request beyond them is refused, never
    // clamped into a different question.
    const { bounds } = capabilities.value;
    if ((options.days !== null && options.days > bounds.max_days) || options.limit > bounds.max_rows) {
      return end("unsupported", "exceeds_service_bounds");
    }

    const response = await fetchRead(session.session, read.path, queryFor(options), limit.signal);
    if (!response.ok) {
      const settled = settle(response);
      return end(settled.outcome, settled.reason, response.retryAfter === undefined ? null : { retry_after_seconds: response.retryAfter });
    }
    const report = read.validate(response.body, ctx, requestOf(options), notices);
    if (!report.ok) return end(report.outcome, report.reason);
    return end("ok", null, report.value);
  } catch (error) {
    if (error instanceof Stop) {
      const settled = settle(error);
      return end(settled.outcome, settled.reason);
    }
    throw error;
  } finally {
    trap.release();
  }
}

function requestOf(options) {
  return {
    days: options.days,
    limit: options.limit,
    route: options.route ?? null,
    status: options.status ?? null,
    cursor: options.cursor ?? null,
  };
}

// The query string is built here from validated options only. The routes
// endpoint takes none.
function queryFor(options) {
  if (options.command === "routes") return null;
  const query = new URLSearchParams();
  query.set("days", String(options.days));
  query.set("limit", String(options.limit));
  if (options.command === "traces") {
    if (options.route !== null) query.set("route", options.route);
    if (options.status !== null) query.set("status", options.status);
    if (options.cursor !== null) query.set("cursor", options.cursor);
  }
  return query;
}

// Unauthenticated GET /healthz on the bound origin, so status can tell an
// unreachable service from a refused grant. status then checks GET
// /v1/deployment with doctor's decoder, under the same deadline.
async function checkHealth(origin, signal) {
  const response = await send(origin, "/healthz", { signal, maxBytes: MAX_BODY_BYTES });
  const reachable = response.kind === "response" || response.status !== null;
  const failure = failureOf(response);
  if (failure !== null) {
    return { ok: false, ...failure, reachable, healthy: failure.outcome === "unhealthy" ? false : null };
  }
  if (response.status !== 200) return { ok: false, outcome: "unsupported", reason: "unexpected_status", reachable, healthy: null };
  const body = parseJsonObject(response);
  if (body === null || typeof body.ok !== "boolean") {
    return { ok: false, outcome: "unsupported", reason: "invalid_response", reachable, healthy: null };
  }
  if (!body.ok) return { ok: false, outcome: "unhealthy", reason: "reported_unhealthy", reachable, healthy: false };
  return { ok: true, reachable, healthy: true };
}

const RETRY_AFTER = /^[0-9]{1,5}$/;
const INSUFFICIENT_SCOPE = /(?:^|[\s,])error\s*=\s*"?insufficient_scope"?(?:$|[\s,])/i;

// True when any string in value (keys included) contains one of the known
// credential values. An exact containment check against values this run
// holds, not a guess at what looks secret.
function holdsKnown(value, known) {
  if (known.length === 0) return false;
  if (typeof value === "string") return known.some((secret) => value.includes(secret));
  if (value === null || typeof value !== "object") return false;
  for (const [key, entry] of Object.entries(value)) {
    if (holdsKnown(key, known) || holdsKnown(entry, known)) return true;
  }
  return false;
}

// One GET with the session's access token. A refused token is never
// refreshed and retried here: the grant was valid moments ago, so a refusal
// means it was revoked or access was lost.
async function fetchRead(session, path, query, signal) {
  const response = await send(session.origin, path, {
    signal,
    maxBytes: READ_MAX_BYTES,
    bearer: session.accessToken,
    query,
  });
  if (response.kind === "response") {
    const { status } = response;
    if (status === 401) return { ok: false, outcome: "login_required", reason: "access_revoked" };
    if (status === 403) {
      const body = parseJsonObject(response);
      const header = response.headers["www-authenticate"];
      const scope =
        (typeof header === "string" && INSUFFICIENT_SCOPE.test(header)) ||
        (body !== null && body.error === "insufficient_scope");
      return { ok: false, outcome: "permission_denied", reason: scope ? "insufficient_scope" : "forbidden" };
    }
    if (status === 429) {
      const header = response.headers["retry-after"];
      const seconds = typeof header === "string" && RETRY_AFTER.test(header.trim()) ? Number(header.trim()) : null;
      return {
        ok: false,
        outcome: "rate_limited",
        reason: "rate_limited",
        retryAfter: seconds !== null && seconds <= 86400 ? seconds : null,
      };
    }
    if (status === 404) return { ok: false, outcome: "unsupported", reason: "endpoint_unavailable" };
    if (status === 400 || status === 422) return { ok: false, outcome: "unsupported", reason: "request_rejected" };
  }
  const failure = failureOf(response);
  if (failure !== null) return { ok: false, ...failure };
  if (response.status !== 200) return { ok: false, outcome: "unsupported", reason: "unexpected_status" };
  const body = parseJsonObject(response);
  if (body === null) return { ok: false, outcome: "verification_failed", reason: "read_response_invalid" };
  return { ok: true, body };
}

// The shape shared by context, capabilities, usage, routes and traces.
function readData(ctx, report, notices, outcome) {
  return {
    origin: ctx.origin,
    workspace: ctx.workspaceId === null ? null : { id: ctx.workspaceId },
    deployment_profile: ctx.profile,
    authenticated: ctx.authenticated,
    scopes: ctx.authenticated ? [METADATA_SCOPE] : [],
    result: outcome === "ok" ? report : null,
    retry_after_seconds: outcome === "rate_limited" ? report?.retry_after_seconds ?? null : null,
    notices: [...notices].sort(),
    next_action: nextAction(outcome),
  };
}

// status keeps configured, reachable, authenticated, the bound and verified
// workspace and the capability flags apart. Application traffic is never
// claimed: existing data or a configured SDK does not prove it.
function statusData(ctx, notices, outcome) {
  const agent = ctx.capabilities?.agent ?? null;
  return {
    origin: ctx.origin,
    configured: ctx.configured,
    reachable: ctx.reachable,
    healthy: ctx.healthy,
    authenticated: ctx.authenticated,
    deployment_profile: ctx.profile,
    // true when GET /v1/deployment reported exactly the bound profile, false
    // when it reported another one, null when it was not checked.
    deployment_profile_verified: ctx.profileVerified,
    workspace: {
      intended: ctx.workspaceId,
      actual: ctx.verifiedWorkspace,
      match: ctx.verifiedWorkspace === null ? null : ctx.verifiedWorkspace === ctx.workspaceId,
    },
    scopes: ctx.authenticated ? [METADATA_SCOPE] : [],
    capabilities:
      agent === null ? null : Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, agent[name]?.available ?? null])),
    content_access: false,
    application_traffic_verified: false,
    notices: [...notices].sort(),
    next_action: nextAction(outcome),
  };
}

function nextAction(outcome) {
  if (outcome === "login_required") {
    return { kind: "login", message: 'Run "metergraph login --runtime local" in this project to sign in again.' };
  }
  if (outcome === "rate_limited") return { kind: "retry_later", message: "Wait, then run the same command again." };
  return null;
}
