import { agentKeySource, keySession, keyTarget, readAgentKey } from "./agent-key.js";
import { readBinding, resolveProject } from "./auth-binding.js";
import { checkDeployment } from "./doctor.js";
import { sessionFor } from "./auth-session.js";
import { Stop, openStore, readCredential, resolveConfigDir } from "./auth-store.js";
import {
  DEFAULT_ORIGIN,
  MAX_BODY_BYTES,
  READ_MAX_BYTES,
  READ_MAX_LIMIT,
  READ_PATHS,
  WORKFLOW_DEPLOYMENT_CAPABILITY,
  WORKFLOW_PERMISSIONS,
} from "./constants.js";
import { parseJsonObject } from "./http.js";
import {
  readQuery,
  groupedRequest,
  workspaceLabel,
  workspacePinned,
  READ_ENVIRONMENTS,
  CAPABILITY_NAMES,
  capabilitySummary,
  routesReport,
  tracesReport,
  usageAggregatesReport,
  usageReport,
  workspaceContext,
} from "./read-contract.js";
import { compareReports, priorWindow, rankReport } from "./usage-aggregates.js";
import { deadline, failureOf, send, trapSignals } from "./transport.js";
import { experimentNextAction, experimentRead } from "./experiments.js";
import { toolsNextAction, toolsRead } from "./tools.js";
import { agentKeyAction, classifyEnvironment, handoffPages } from "./environment.js";

// The read commands: status, context, capabilities, usage, routes and traces.
// Each one uses either the project's existing verified session or a
// coding-agent key with Metadata access (agent-key.js); never a browser,
// never a new grant. A saved project grant is used when one exists, unless
// --agent-token-file names a key explicitly; otherwise a key in
// METERGRAPH_AGENT_TOKEN is used. Each one shares one total deadline across
// every request, including a token refresh, and sends GET requests only, to fixed paths on
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
const GROUPED_USAGE = Object.freeze({
  capability: "usage_aggregates",
  path: READ_PATHS.usageAggregates,
  validate: usageAggregatesReport,
});

export async function runRead(options) {
  const env = options.env ?? process.env;
  const ctx = {
    command: options.command,
    environment: options.environment ?? classifyEnvironment(env),
    credential: null,
    origin: null,
    workspaceId: null,
    intendedWorkspace: null,
    profile: null,
    configured: false,
    reachable: null,
    healthy: null,
    profileVerified: null,
    authenticated: false,
    // The credential's access ("metadata" or "debug") and scopes, once verified.
    access: null,
    scopes: [],
    // The verified workspace's slug and name, for output. Never its ID.
    workspaceLabel: { slug: null, name: null },
    verifiedWorkspace: null,
    capabilities: null,
  };
  const notices = new Set();
  const trap = trapSignals();
  const limit = deadline(options.timeoutMs, trap.signal);
  // Token values this run holds. Filled after the session is verified.
  let known = [];
  const grouped = options.command === "usage" && options.grouped !== undefined && options.grouped !== null;
  const build = (outcome, report) =>
    options.command === "status"
      ? statusData(ctx, notices, outcome, options)
      : readData(ctx, report, notices, outcome, options, { grouped, report });
  const end = (outcome, reason, report = null) => {
    ctx.reason = reason;
    const data = build(outcome, report);
    // Validated metadata can still be any string the service chose. If any
    // printed string holds a credential this run knows, nothing is printed.
    if (holdsKnown(data, known)) {
      notices.clear();
      ctx.reason = "credential_in_metadata_response";
      // The workspace's name or slug may be what echoed the credential.
      ctx.workspaceLabel = { slug: null, name: null };
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
    const binding = found?.binding ?? null;
    const source = agentKeySource(options, env);
    // The private store matters only for a bound project. With a key at
    // hand, a store that cannot be read means no grant here; without one,
    // its error is the answer, as before.
    let store = null;
    let grantSaved = false;
    let originConfirmed = false;
    if (binding !== null) {
      try {
        store = openStore(configDir, { create: false });
        const record = store === null ? null : readCredential(store, binding.credential_slot);
        grantSaved = record !== null;
        originConfirmed = record !== null && record.origin === binding.origin;
      } catch (error) {
        if (!(error instanceof Stop) || source === null) throw error;
        store = null;
      }
    }
    // An explicit key file wins. Otherwise a saved grant wins over the
    // environment variable, so a project signed in on this machine behaves as
    // it always has; a binding without a grant here (for example one
    // committed to the repository and cloned into a remote workspace) uses
    // the key, pinned to the binding.
    const useKey = source !== null && (source.kind === "file" || !grantSaved);
    if (!useKey && binding === null) return end("login_required", "not_signed_in");
    if (!useKey && source !== null) notices.add("agent_key_not_used");

    ctx.credential = useKey ? "agent_key" : "oauth_grant";
    // A key in the environment is checked for shape before any request,
    // including status's unauthenticated probes.
    if (useKey && source.kind === "env") {
      const shape = readAgentKey(source, env);
      if (!shape.ok) return end(shape.outcome, shape.reason);
    }
    // --url, METERGRAPH_URL (for a key only) and --workspace may repeat the
    // binding but never contradict it.
    const target = keyTarget({ binding, options, env: useKey ? env : {}, originConfirmed: originConfirmed || !useKey });
    if (!target.ok) return end(target.outcome, target.reason);
    Object.assign(ctx, {
      origin: target.origin,
      workspaceId: target.workspaceId,
      intendedWorkspace: target.workspaceId,
      profile: target.profile,
      // configured means this project is bound; a key alone binds nothing.
      configured: binding !== null,
    });

    let verifiedProfile = null;
    if (options.command === "status") {
      const health = await checkHealth(ctx.origin, limit.signal);
      ctx.reachable = health.reachable;
      ctx.healthy = health.healthy;
      if (!health.ok) {
        const settled = settle(health);
        return end(settled.outcome, settled.reason);
      }
      // The service's own unauthenticated profile report must be the bound
      // profile before the grant is even tried.
      const deployment = checkDeployment(
        await send(ctx.origin, "/v1/deployment", { signal: limit.signal, maxBytes: MAX_BODY_BYTES }),
      );
      if (deployment.outcome !== null) {
        if (deployment.outcome === "unhealthy") ctx.healthy = false;
        const settled = settle(deployment);
        return end(settled.outcome, settled.reason);
      }
      verifiedProfile = deployment.profile;
      ctx.profileVerified = ctx.profile === null || deployment.profile === ctx.profile;
      if (!ctx.profileVerified) return end("verification_failed", "profile_mismatch");
      ctx.profile = deployment.profile;
    }

    const session = useKey
      ? await keySession({ target, source, env, signal: limit.signal, verifiedProfile, access: "read" })
      : await sessionFor(binding, store, limit.signal);
    if (!session.ok) {
      const settled = settle(session);
      return end(settled.outcome, settled.reason);
    }
    ctx.profile = session.session.profile;
    ctx.access = session.session.access;
    ctx.scopes = session.session.scopes;
    ctx.workspaceLabel = workspaceLabel(session.documents.workspace?.workspace);
    // A workspace named by slug or name is checked against the verified one.
    if (target.workspaceText !== null && !workspacePinned(session.documents.workspace?.workspace, target.workspaceText)) {
      return end("verification_failed", "workspace_context_mismatch");
    }
    if (ctx.workspaceId === null) {
      ctx.workspaceId = session.session.workspaceId;
      notices.add("workspace_not_pinned");
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
    if (options.command === "tools") {
      const tools = await toolsRead(session.session, options, limit.signal);
      if (!tools.ok) {
        const settled = ["refused", "unconfirmed", "action_required"].includes(tools.outcome) ? tools : settle(tools);
        return end(settled.outcome, settled.reason, tools.report);
      }
      return end("ok", null, tools.value);
    }
    if (options.command === "experiments") {
      const read = await experimentRead(session.session, options, ctx, documents, limit.signal, notices);
      if (!read.ok) {
        const settled = read.outcome === "refused" ? read : settle(read);
        const report = read.refusal ? { refusal: read.refusal }
          : read.retryAfter !== undefined ? { retry_after_seconds: read.retryAfter } : null;
        return end(settled.outcome, settled.reason, report);
      }
      return end("ok", null, read.value);
    }

    const read = grouped ? GROUPED_USAGE : READS[options.command];
    const entry = capabilities.value.agent[read.capability];
    if (entry === null || entry.available !== true) {
      return end("capability_unavailable", grouped ? "usage_aggregates_unavailable" : "capability_unavailable");
    }
    // The service's own bounds; a request beyond them is refused, never
    // clamped into a different question.
    const { bounds } = capabilities.value;
    // An explicit grouped window is held to the same day bound as --days.
    const explicitDays = grouped && options.grouped.since !== null
      ? ((options.grouped.until === null ? Date.now() : Date.parse(options.grouped.until)) -
          Date.parse(options.grouped.since)) / (24 * 60 * 60 * 1000)
      : null;
    if (
      (options.days !== null && options.days > bounds.max_days) ||
      (explicitDays !== null && explicitDays > bounds.max_days) ||
      options.limit > bounds.max_rows
    ) {
      return end("unsupported", "exceeds_service_bounds");
    }

    const fetchOne = async (query, request, into) => {
      // When this read was asked for, to check a window that ends "now".
      request = { ...request, requestedAt: Date.now() };
      const response = await fetchRead(session.session, read.path, query, limit.signal);
      if (!response.ok) {
        // A key refused moments after it was verified was revoked meanwhile.
        if (ctx.credential === "agent_key" && response.reason === "access_revoked") response.reason = "agent_key_rejected";
        const settled = settle(response);
        return {
          ok: false,
          ...settled,
          detail: response.retryAfter === undefined ? null : { retry_after_seconds: response.retryAfter },
        };
      }
      return read.validate(response.body, ctx, request, into);
    };
    if (!grouped) {
      const report = await fetchOne(readQuery(options), requestOf(options), notices);
      if (!report.ok) return end(report.outcome, report.reason, report.detail ?? null);
      return end("ok", null, report.value);
    }

    // Grouped usage: the current window, then for --compare the prior
    // window computed from the window the service actually read.
    const request = groupedRequest(options);
    const current = await fetchOne(readQuery(options, request), request, notices);
    if (!current.ok) return end(current.outcome, current.reason, current.detail ?? null);
    let report = rankReport(current.value, options.grouped.sort, notices);
    if (options.grouped.compare !== null) {
      const window = priorWindow(current.value.window, options.grouped.compare);
      const priorRequest = { ...request, days: null, since: window.since, until: window.until, limit: options.limit };
      // The prior read's own coverage notices describe the prior window; they
      // are kept apart and summarised by the comparison.
      const priorNotices = new Set();
      const prior = await fetchOne(readQuery(options, priorRequest), priorRequest, priorNotices);
      if (!prior.ok) return end(prior.outcome, prior.reason, prior.detail ?? null);
      // Both windows must cover the same environments, or the change compares
      // different populations.
      if (JSON.stringify(prior.value[READ_ENVIRONMENTS]) !== JSON.stringify(current.value[READ_ENVIRONMENTS])) {
        return end("verification_failed", "filter_mismatch");
      }
      for (const token of priorNotices) if (token !== "current_day_partial") notices.add(`prior_${token}`);
      // The ranked report, so comparison rows follow the requested --sort.
      report = { ...report, comparison: compareReports(report, prior.value, options.grouped.compare, notices) };
    }
    return end("ok", null, report);
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
    metadata: options.metadata ?? null,
    groupByMetadata: options.groupByMetadata ?? null,
  };
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
export function holdsKnown(value, known) {
  if (known.length === 0) return false;
  if (typeof value === "string") return known.some((secret) => value.includes(secret));
  if (value === null || typeof value !== "object") return false;
  for (const [key, entry] of Object.entries(value)) {
    if (holdsKnown(key, known) || holdsKnown(entry, known)) return true;
  }
  return false;
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

function retryAfterOf(response) {
  const header = response.headers["retry-after"];
  const seconds = typeof header === "string" && RETRY_AFTER.test(header.trim()) ? Number(header.trim()) : null;
  return seconds !== null && seconds <= 86400 ? seconds : null;
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
      return { ok: false, outcome: "rate_limited", reason: "rate_limited", retryAfter: retryAfterOf(response) };
    }
    if (status === 404) return { ok: false, outcome: "unsupported", reason: "endpoint_unavailable" };
    if (status === 413) return { ok: false, outcome: "unsupported", reason: "response_too_large" };
    if (status === 503) {
      // The service's read budget (time or pool) was exceeded. Nothing is
      // retried here; the result says when to retry and how to narrow it.
      const body = parseJsonObject(response);
      if (isObject(body?.error) && body.error.code === "temporarily_unavailable") {
        return { ok: false, outcome: "unhealthy", reason: "temporarily_unavailable", retryAfter: retryAfterOf(response) };
      }
    }
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
function readData(ctx, report, notices, outcome, options, extra = {}) {
  return {
    origin: ctx.origin,
    workspace: ctx.workspaceId === null ? null : { id: ctx.workspaceId, ...ctx.workspaceLabel },
    deployment_profile: ctx.profile,
    environment: ctx.environment.kind,
    credential: ctx.credential,
    authenticated: ctx.authenticated,
    scopes: ctx.authenticated ? ctx.scopes : [],
    result: outcome === "ok" ? report : null,
    retry_after_seconds: outcome === "rate_limited" || report?.retry_after_seconds !== undefined
      ? report?.retry_after_seconds ?? null : null,
    ...(options.command === "experiments" ? { refusal: outcome === "refused" ? report?.refusal ?? null : null } : {}),
    // A tool's own error document, as the service returned it.
    ...(options.command === "tools" ? { tool_error: outcome === "refused" ? report?.tool_error ?? null : null } : {}),
    notices: [...notices].sort(),
    next_action: nextAction(outcome, ctx, options, extra),
  };
}

// status keeps configured, reachable, authenticated, the bound and verified
// workspace and the capability flags apart. Application traffic is never
// claimed: existing data or a configured SDK does not prove it.
function statusData(ctx, notices, outcome, options) {
  const agent = ctx.capabilities?.agent ?? null;
  return {
    origin: ctx.origin,
    environment: ctx.environment.kind,
    credential: ctx.credential,
    configured: ctx.configured,
    reachable: ctx.reachable,
    healthy: ctx.healthy,
    authenticated: ctx.authenticated,
    deployment_profile: ctx.profile,
    // true when GET /v1/deployment reported exactly the bound profile, false
    // when it reported another one, null when it was not checked.
    deployment_profile_verified: ctx.profileVerified,
    // intended is null for an agent key with no binding and no --workspace;
    // match is then null too, and the notices say workspace_not_pinned.
    workspace: {
      intended: ctx.intendedWorkspace,
      actual: ctx.verifiedWorkspace,
      match:
        ctx.verifiedWorkspace === null || ctx.intendedWorkspace === null
          ? null
          : ctx.verifiedWorkspace === ctx.intendedWorkspace,
      // The verified workspace's slug and name, which output shows instead
      // of either ID.
      ...ctx.workspaceLabel,
    },
    scopes: ctx.authenticated ? ctx.scopes : [],
    capabilities:
      agent === null ? null : Object.fromEntries(CAPABILITY_NAMES.map((name) => [name, agent[name]?.available ?? null])),
    // Whether this credential may read content through Agent Access. The
    // read commands never do, whatever it allows.
    content_access: ctx.access === "debug",
    access: accessFor(ctx),
    application_traffic_verified: false,
    notices: [...notices].sort(),
    next_action: nextAction(outcome, ctx, options),
  };
}

// The credential's role and workflow permissions, by the names the Keys page
// uses. Either role reads. Writing and testing evaluations and starting
// analyses need Debug with all three permissions, on a deployment that offers
// managed evaluations: permissions_offered is false where it does not, and
// null when the capabilities were not read.
export function accessFor(ctx) {
  if (!ctx.authenticated) return null;
  const deployment = ctx.capabilities?.deployment_capabilities ?? null;
  return {
    role: ctx.access,
    permissions: Object.fromEntries(WORKFLOW_PERMISSIONS.map(({ field, scope }) => [field, ctx.scopes.includes(scope)])),
    permissions_offered: deployment === null ? null : deployment.includes(WORKFLOW_DEPLOYMENT_CAPABILITY),
  };
}

const NARROW =
  "Narrow the read: a shorter --days or --since/--until window, exact --route, --provider or --model filters, " +
  "fewer --group-by dimensions or a lower --limit.";

// The next action for a read, by credential and environment. Where browser
// sign in cannot finish (SSH, a cloud workspace, CI), the answer is always
// the agent key handoff, never "run login". Grouped usage adds its own steps
// (a supported read, retry, narrow, raise the limit, compare like for like);
// their text is fixed except a window and limit computed from validated values.
function nextAction(outcome, ctx, options, { grouped = false, report = null } = {}) {
  const origin = ctx.origin ?? options.origin ?? DEFAULT_ORIGIN;
  const keyed = ctx.credential === "agent_key";
  const reason = ctx.reason;
  const capabilities = ctx.capabilities;
  if (outcome === "rate_limited") return { kind: "retry_later", message: "Wait, then run the same command again." };
  const experiment = experimentNextAction(outcome, ctx, options, report);
  if (experiment !== undefined) return experiment;
  const tool = toolsNextAction(ctx, options);
  if (tool !== undefined) return tool;
  if (reason === "usage_aggregates_unavailable" || (grouped && reason === "endpoint_unavailable")) {
    // Offer the route-by-day read only when this grant actually has it.
    if (capabilities?.agent?.usage?.available !== true) return null;
    return {
      kind: "use_supported_read",
      message:
        "This deployment does not offer grouped usage to this grant. \"metergraph usage --days N\" still lists " +
        "cost per route and day over the last N x 24 hours. Grouping by provider, model, UTC day or a metadata key " +
        "needs a service that offers grouped usage; nothing was read.",
      command: "metergraph usage --days 7 --json",
    };
  }
  if (grouped && reason === "temporarily_unavailable") {
    return { kind: "retry_later", message: `The service stopped the read at its time budget. Wait, then retry. ${NARROW}` };
  }
  if (grouped && reason === "response_too_large") return { kind: "narrow_read", message: NARROW };
  if (outcome === "ok" && report?.sort && !report.sort.complete && report.matched_groups !== null) {
    const needed = report.matched_groups;
    // The largest --limit this deployment accepts, not only the CLI's own.
    const maxLimit = Math.min(READ_MAX_LIMIT, capabilities?.bounds?.max_rows ?? READ_MAX_LIMIT);
    return needed <= maxLimit
      ? {
          kind: "raise_limit",
          message: `The ranking covers the ${report.rows} highest-cost groups of ${needed}. ` +
            `Run the same command with --limit ${needed} to rank every group.`,
        }
      : { kind: "narrow_read", message: `The ranking covers the ${report.rows} highest-cost groups of ${needed}. ${NARROW}` };
  }
  if (outcome === "ok" && report?.comparison?.partial_day_compared_with_full) {
    const window = report.comparison.like_for_like_window;
    return {
      kind: "compare_like_for_like",
      message:
        "The current window ends part way through today (UTC) and the prior period is whole days. " +
        "For equal lengths, run the same command with --compare previous-same-time " +
        `(prior window ${window.since} to ${window.until}).`,
    };
  }
  if (keyed && (reason === "agent_key_rejected" || reason === "agent_key_insufficient_scope")) {
    return {
      kind: "replace_agent_key",
      url: handoffPages(origin).keys_url,
      message:
        "The service refused this key: it is unknown, expired or revoked, or it lacks Metadata access. Ask the " +
        "person to create a new coding-agent key with Metadata access on the Keys page and replace the secret. " +
        "Do not ask for the key in chat.",
    };
  }
  if (keyed && (reason === "scope_mismatch" || reason === "content_access_granted")) {
    return {
      kind: "use_metadata_only_key",
      url: handoffPages(origin).keys_url,
      message:
        "This key has Replay access or another scope the CLI does not use. Ask the person for a coding-agent " +
        "key with the Metadata or Debug role, and to replace the secret.",
    };
  }
  if (keyed && reason === "workspace_context_mismatch") {
    return {
      kind: "use_workspace_key",
      url: handoffPages(origin).keys_url,
      workspace: ctx.intendedWorkspace === null ? null : { id: ctx.intendedWorkspace },
      message:
        "This key belongs to a different workspace than this project or --workspace names. Ask the person to " +
        "create the key in the intended workspace, or pass the intended workspace with --workspace.",
    };
  }
  if (keyed && reason === "agent_key_origin_unconfirmed") {
    return {
      kind: "confirm_origin",
      message:
        "This project's binding names a deployment other than the hosted service. A Metadata key is sent there " +
        "only when you confirm the same address: set METERGRAPH_URL or pass --url with it.",
    };
  }
  if (keyed && (reason === "bound_to_other_origin" || reason === "bound_to_other_workspace")) {
    return {
      kind: "match_project_binding",
      message:
        "This project's .metergraph/project.json names a different origin or workspace. Remove --url, " +
        "--workspace or METERGRAPH_URL, or use a key for the bound workspace.",
    };
  }
  if (keyed && reason?.startsWith("agent_token")) {
    return {
      kind: "fix_agent_key",
      message:
        "The key could not be used as given. METERGRAPH_AGENT_TOKEN must hold exactly one key with no label " +
        "or spaces; --agent-token-file must name a private (0600) file owned by this user.",
    };
  }
  if (outcome === "login_required") {
    if (ctx.environment.remote) return agentKeyAction(ctx.environment, origin);
    return {
      kind: "login",
      message: 'Run "metergraph login --runtime local" in this project to sign in again.',
      alternative: agentKeyAction(ctx.environment, origin),
    };
  }
  return null;
}
