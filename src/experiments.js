import { agentKeySource, keySession, keyTarget, readAgentKey } from "./agent-key.js";
import { readBinding, resolveProject } from "./auth-binding.js";
import { Stop, openStore, readProjectCredential, resolveConfigDir } from "./auth-store.js";
import { DEFAULT_ORIGIN, EXPERIMENT_PATHS, EXPERIMENT_START_SCOPE, METADATA_SCOPE, READ_MAX_BYTES } from "./constants.js";
import { AGENT_URL_ENV, classifyEnvironment, handoffPages } from "./environment.js";
import {
  experimentEstimate,
  experimentRefusal,
  experimentStarted,
  managedExperiment,
  experimentSummary,
  experimentsList,
} from "./experiments-contract.js";
import { parseJsonObject } from "./http.js";
import { parseOrigin } from "./origin.js";
import { workspaceLabel, workspacePinned } from "./read-contract.js";
import { holdsKnown, outputHoldsKnown } from "./read.js";
import { deadline, failureOf, send, trapSignals } from "./transport.js";

// Experiments: replay a workload's recent production calls on 1 to 3
// treatments and read the built-in statistics per arm against production.
//
// list, estimate and get are Metadata reads. runRead (read.js) establishes
// their session exactly as for every other read command, a saved grant or a
// coding-agent key, and calls experimentRead with it. They send only these
// requests and print only validated fields; no input, output or tracked
// field value is ever requested.
//
// start changes a workspace. It needs a coding-agent key with Debug access
// and the agent:analysis-run grant (Allow analysis starts), from
// --agent-token-file or METERGRAPH_AGENT_TOKEN, verified before it is used
// for this one POST (auth-oauth.js checkStartWorkspace and
// checkStartCapabilities). A saved sign in is Metadata only and never starts
// one. Each start creates a new experiment, so a start that succeeded is not
// retried.

const CAPABILITIES = Object.freeze({ list: "experiments", estimate: "experiment_estimate", get: "experiment" });
const RETRY_AFTER = /^[0-9]{1,5}$/;
// The service's refusal reasons with their own fixed message here; any other
// is reported as experiment_refused with its code kept in data.refusal.
export const REFUSAL_REASONS = Object.freeze([
  "over_budget",
  "no_replayable_calls",
  "experiments_in_progress",
  "daily_budget_exhausted",
  "route_unpriced",
  "invalid_reasoning_effort",
  "invalid_settings",
  "invalid_sample",
  "invalid_treatment",
  "invalid_treatments",
  "invalid_tracked_fields",
  "invalid_request",
]);
export const POLL_AFTER_SECONDS = 15;

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);

// A Metadata capability this grant can read: listed, available and plainly
// metadata only.
function readable(entry) {
  return isObject(entry) && entry.available === true && entry.content === false && entry.mutates === false &&
    entry.external_calls === false && entry.privacy_class === "metadata" && entry.required_scope === METADATA_SCOPE;
}

function retryAfterOf(response) {
  const header = response.headers["retry-after"];
  const seconds = typeof header === "string" && RETRY_AFTER.test(header.trim()) ? Number(header.trim()) : null;
  return seconds !== null && seconds <= 86400 ? seconds : null;
}

// One answer from an experiments endpoint as { ok: true, body } or a failure
// with fixed tokens. A refusal keeps the service's code, reason and numbers.
function answer(response, expected) {
  if (response.kind === "response") {
    const { status } = response;
    if (status === 401) return { ok: false, outcome: "login_required", reason: "access_revoked" };
    if (status === 403) return { ok: false, outcome: "permission_denied", reason: "forbidden" };
    if (status === 429) return { ok: false, outcome: "rate_limited", reason: "rate_limited", retryAfter: retryAfterOf(response) };
    if (status === 501) return { ok: false, outcome: "capability_unavailable", reason: "experiments_unavailable" };
    if (status === 404 || status === 409 || status === 422) {
      const refusal = experimentRefusal(parseJsonObject(response));
      if (refusal === null) return { ok: false, outcome: "unsupported", reason: "request_rejected" };
      const named = refusal.code === "not_found" ? "experiment_not_found" : refusal.reason;
      const reason = named === "experiment_not_found" || REFUSAL_REASONS.includes(named) ? named : "experiment_refused";
      return { ok: false, outcome: "refused", reason, refusal };
    }
  }
  const failure = failureOf(response);
  if (failure !== null) return { ok: false, ...failure };
  if (response.status !== expected) return { ok: false, outcome: "unsupported", reason: "unexpected_status" };
  const body = parseJsonObject(response);
  if (body === null) return { ok: false, outcome: "verification_failed", reason: "experiment_response_invalid" };
  return { ok: true, body };
}

// The list, estimate or summary read for runRead, with its verified session.
export async function experimentRead(session, options, ctx, documents, signal, notices) {
  if (!readable(documents.capabilities?.agent?.[CAPABILITIES[options.action]])) {
    return { ok: false, outcome: "capability_unavailable", reason: "experiments_unavailable" };
  }
  const request = options.experiment;
  const common = { signal, maxBytes: READ_MAX_BYTES, bearer: session.accessToken };
  let response;
  let validate;
  if (options.action === "list") {
    const query = new URLSearchParams();
    if (request.workloadId !== null) query.set("workload_id", request.workloadId);
    query.set("limit", String(request.limit));
    response = await send(session.origin, EXPERIMENT_PATHS.list, { ...common, query });
    validate = (body) => experimentsList(body, ctx, request, notices);
  } else if (options.action === "estimate") {
    response = await send(session.origin, EXPERIMENT_PATHS.estimate, { ...common, method: "POST", json: request.request });
    validate = (body) => experimentEstimate(body, ctx, request.request, notices);
  } else {
    // The ID is a validated UUID, so the path is still a fixed shape.
    response = await send(session.origin, `${EXPERIMENT_PATHS.list}/${request.id}`, common);
    validate = (body) => experimentSummary(body, ctx, request, notices);
  }
  const read = answer(response, 200);
  if (!read.ok) {
    if (read.reason === "access_revoked" && ctx.credential === "agent_key") read.reason = "agent_key_rejected";
    return read;
  }
  return validate(read.body);
}

// What an agent does next with an experiments result, or undefined for the
// read commands' shared handling (keys, sign in, workspace, rate limits).
export function experimentNextAction(outcome, ctx, options, report) {
  if (options.command !== "experiments") return undefined;
  const origin = ctx.origin;
  if (outcome === "ok" && options.action === "estimate") {
    return {
      kind: report.blocking_reasons.length > 0 ? "change_experiment" : "start_experiment",
      message: report.blocking_reasons.length > 0
        ? "A start now would be refused: this estimate is above the experiment budget or the workspace's daily " +
          "cap. Sample fewer calls, drop a treatment or lower max_tokens, then estimate again."
        : 'Run the same command as "metergraph experiments start" to start it. A start needs a coding-agent key ' +
          "with Debug access and Allow analysis starts, in --agent-token-file or METERGRAPH_AGENT_TOKEN; " +
          "or start it in the dashboard.",
      url: report.new_experiment_url,
      start_granted: report.start_granted,
    };
  }
  if (outcome === "ok" && options.action === "get") return pollOrOpen(report.experiment);
  if (outcome === "refused" && ctx.reason === "experiment_not_found") {
    return {
      kind: "list_experiments",
      message: "No experiment with this ID is visible to this credential's workspace. List them to find it.",
      command: "metergraph experiments list --json",
    };
  }
  if (outcome === "refused") return refusedAction(ctx.reason);
  if (outcome === "capability_unavailable") {
    return {
      kind: "use_dashboard",
      message:
        "This deployment does not offer experiments to this credential: the feature may be off for it. " +
        "Nothing was read or started.",
      url: origin === null ? null : `${origin}/#experiments`,
    };
  }
  return undefined;
}

function pollOrOpen(experiment, { started = false } = {}) {
  if (!experiment.terminal) {
    return {
      kind: "poll_experiment",
      message: started
        ? `The experiment is ${experiment.status}. Poll it in about ${POLL_AFTER_SECONDS} seconds with ` +
          "this project's sign in or a coding-agent key."
        : `The experiment is ${experiment.status}. Run the same command again in about ${POLL_AFTER_SECONDS} seconds.`,
      command: `metergraph experiments get --id ${experiment.id} --json`,
      poll_after_seconds: POLL_AFTER_SECONDS,
    };
  }
  if (experiment.status === "failed") {
    return {
      kind: "open_experiment",
      message:
        "The experiment failed; its error_code says why. Statistics cover only the cases that finished. " +
        "Inputs, outputs and tracked field values are in the dashboard.",
      url: experiment.app_url,
    };
  }
  return {
    kind: "open_experiment",
    message:
      "The statistics show how each treatment differs from production on the same calls; they do not judge it. " +
      "Inputs, outputs and tracked field values are in the dashboard.",
    url: experiment.app_url,
  };
}

function refusedAction(reason) {
  if (reason === "experiments_in_progress" || reason === "daily_budget_exhausted") {
    return {
      kind: "retry_later",
      message: reason === "experiments_in_progress"
        ? "Two experiments are already running in this workspace. Start this one when one finishes."
        : "This workspace has used its daily experiment budget. Try again later.",
    };
  }
  return {
    kind: "change_experiment",
    message:
      "Change the request and estimate it again: sample fewer calls, drop or change a treatment, lower max_tokens " +
      "or pick a workload with captured calls. Nothing was started.",
  };
}

// experiments start: one POST with a start key, then the experiment to poll.
export async function runExperimentStart(options) {
  const env = options.env ?? process.env;
  const ctx = {
    environment: options.environment ?? classifyEnvironment(env),
    origin: null,
    workspaceId: null,
    intendedWorkspace: null,
    workspaceLabel: { slug: null, name: null },
    profile: null,
    authenticated: false,
    scopes: [],
    reason: null,
    // Where the Keys page is before any origin is resolved.
    keysOrigin: options.origin ?? (typeof env[AGENT_URL_ENV] === "string" ? parseOrigin(env[AGENT_URL_ENV]) : null) ??
      DEFAULT_ORIGIN,
  };
  const notices = new Set();
  const trap = trapSignals();
  const limit = deadline(options.timeoutMs, trap.signal);
  let known = [];
  const end = (outcome, reason, report = null) => {
    ctx.reason = reason;
    const data = startData(ctx, notices, outcome, report);
    if (holdsKnown(data, known)) {
      return { outcome: "verification_failed", reason: "credential_in_metadata_response",
        data: startData({ ...ctx, reason: "credential_in_metadata_response", workspaceLabel: { slug: null, name: null } },
          new Set(), "verification_failed", null),
        validateOutput: (text) => !outputHoldsKnown(text, known) };
    }
    return { outcome, reason, data, validateOutput: (text) => !outputHoldsKnown(text, known) };
  };
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
    const binding = readBinding(root)?.binding ?? null;
    const source = agentKeySource(options, env);
    if (source === null) return end("permission_denied", "experiment_start_key_required");
    // As for reads: a binding's non-hosted origin is confirmed by a saved
    // sign in for it on this machine, or by --url or METERGRAPH_URL.
    let originConfirmed = false;
    if (binding !== null) {
      try {
        const store = openStore(resolveConfigDir(options.configDir), { create: false });
        const record = store === null ? null : readProjectCredential(store, binding.credential_slot, root);
        originConfirmed = record !== null && record.origin === binding.origin;
      } catch (error) {
        if (!(error instanceof Stop)) throw error;
      }
    }
    if (source.kind === "env") {
      const shape = readAgentKey(source, env);
      if (!shape.ok) return end(shape.outcome, shape.reason);
    }
    const target = keyTarget({ binding, options, env, originConfirmed });
    if (!target.ok) return end(target.outcome, target.reason);
    Object.assign(ctx, {
      origin: target.origin, workspaceId: target.workspaceId, intendedWorkspace: target.workspaceId, profile: target.profile,
    });
    const session = await keySession({ target, source, env, signal: limit.signal, access: "experiment_start" });
    if (!session.ok) {
      const settled = settle(session);
      const reason = settled.reason === "agent_key_insufficient_scope" ? "experiment_start_not_granted" : settled.reason;
      return end(settled.outcome, reason);
    }
    ctx.profile = session.session.profile;
    if (target.workspaceText !== null && !workspacePinned(session.documents.workspace?.workspace, target.workspaceText)) {
      return end("verification_failed", "workspace_context_mismatch");
    }
    ctx.workspaceLabel = workspaceLabel(session.documents.workspace?.workspace);
    if (ctx.workspaceId === null) {
      ctx.workspaceId = session.session.workspaceId;
      notices.add("workspace_not_pinned");
    }
    known = session.knownCredentials;
    ctx.authenticated = true;
    ctx.scopes = session.session.scopes;
    const request = options.experiment.request;
    ctx.requestKey = request.request_key ?? null;
    if (request.request_key && session.documents.capabilities?.agent?.experiment_start?.provider_consent_contract !==
        "metergraph.pipeline-managed/v1") {
      return end("capability_unavailable", "managed_consent_unavailable");
    }
    // The start has its own deadline: the service samples, prices and
    // launches within the request, and an answer cut short is ambiguous.
    const post = deadline(options.timeoutMs, trap.signal);
    const response = await send(ctx.origin, EXPERIMENT_PATHS.start, {
      method: "POST", json: request, signal: post.signal, maxBytes: READ_MAX_BYTES, bearer: session.session.accessToken,
    });
    const started = answer(response, 202);
    if (!started.ok) {
      if (unconfirmed(response, started)) return end("unconfirmed", "experiment_start_unconfirmed");
      if (started.reason === "access_revoked") started.reason = "agent_key_rejected";
      if (started.outcome === "permission_denied") started.reason = "experiment_start_not_granted";
      if (started.reason === "timeout" && post.timedOut()) return end("connection_failed", "timeout");
      if (trap.signal.aborted) return end("cancelled", "cancelled");
      return end(started.outcome, started.reason, started.refusal ? { refusal: started.refusal } : null);
    }
    if (request.request_key) {
      const value = managedExperiment(started.body, ctx, request, notices);
      if (!value.ok) return end("unconfirmed", "experiment_start_unconfirmed");
      return end("ok", null, value.value);
    }
    // Legacy accepted start: an experiment exists.
    const value = experimentStarted(started.body, ctx, request, notices);
    if (!value.ok) return end("unconfirmed", "experiment_start_unconfirmed");
    if (value.value.experiment.status === "failed") return end("unhealthy", "experiment_launch_failed", value.value);
    return end("ok", null, value.value);
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

// A start whose request was handed to the network and then failed, or that
// the service answered with a server error, may have been recorded.
function unconfirmed(response, failure) {
  if (response.kind === "error") return response.sent === true;
  if (response.status >= 200 && response.status < 300) return true;
  if (failure.outcome === "unhealthy" && failure.reason === "server_error") return true;
  if (response.status === 503) {
    const body = parseJsonObject(response);
    // A managed-workflow refusal is decided before anything is recorded.
    return !(isObject(body?.error) && body.error.code === "managed_features_disabled");
  }
  return failure.outcome === "unsupported" && failure.reason === "response_too_large";
}

function startData(ctx, notices, outcome, report) {
  return {
    origin: ctx.origin,
    workspace: ctx.workspaceId === null ? null : { id: ctx.workspaceId, ...ctx.workspaceLabel },
    deployment_profile: ctx.profile,
    environment: ctx.environment.kind,
    credential: "agent_key",
    authenticated: ctx.authenticated,
    scopes: ctx.scopes,
    result: outcome === "ok" || ctx.reason === "experiment_launch_failed" ? report : null,
    refusal: outcome === "refused" ? report?.refusal ?? null : null,
    notices: [...notices].sort(),
    next_action: startNextAction(outcome, ctx, report),
    ...(ctx.requestKey ? { request_key: ctx.requestKey } : {}),
  };
}

function startNextAction(outcome, ctx, report) {
  const keys = handoffPages(ctx.origin ?? ctx.keysOrigin).keys_url;
  if (outcome === "ok" && report.managed_operation) {
    const operation = report.managed_operation;
    if (report.approval) return { kind: "review_provider_plan", url: report.approval.consent_url,
      message: "The workspace owner must review the exact data, provider, model and spending limits. After approval, repeat the same request key with this consent ID. Never approve on the owner's behalf." };
    return { kind: operation.terminal ? "inspect_operation" : "poll_operation", url: null,
      message: operation.terminal ? "This operation is terminal. Do not resend an uncertain provider call."
        : "Preparation or execution is pending. Repeat the same request and request key to check progress; do not create another key." };
  }
  if (outcome === "ok") return pollOrOpen({ ...report.experiment, app_url: report.app_url }, { started: true });
  if (outcome === "unconfirmed") {
    if (ctx.requestKey) return { kind: "check_same_operation", url: null,
      message: "The operation may exist. Repeat the identical request with the same request key to check its state. Do not create another key or resend an uncertain provider call." };
    return {
      kind: "check_before_retry",
      message:
        "The start request reached the service, but its answer was not confirmed: an experiment may exist and " +
        "may be running. List the newest experiments with this project's sign in or a coding-agent key before " +
        "starting again; each start creates a new experiment.",
      command: "metergraph experiments list --json",
    };
  }
  if (ctx.reason === "experiment_launch_failed") {
    return {
      kind: "start_again_later",
      message:
        "The service recorded the experiment but could not launch its runner, so it failed and nothing ran. " +
        "Start it again later.",
      url: report.app_url,
    };
  }
  if (outcome === "refused") return refusedAction(ctx.reason);
  if (["experiment_start_key_required", "experiment_start_not_granted", "experiment_start_unavailable"].includes(ctx.reason)) {
    return {
      kind: "use_experiment_start_key",
      url: keys,
      message:
        "Starting an experiment needs a coding-agent key with the Debug role and Allow analysis starts, which " +
        "only a workspace owner can grant on the Keys page (or, on the customer-local bundle, with " +
        "bin/agent-key). Pass it with --agent-token-file or METERGRAPH_AGENT_TOKEN; " +
        "do not ask for it in chat. A start replays the sampled calls' captured prompts on each treatment's " +
        "provider within the server's budget. Or start the experiment in the dashboard.",
      required_scope: EXPERIMENT_START_SCOPE,
    };
  }
  if (ctx.reason === "agent_key_rejected") {
    return { kind: "replace_agent_key", url: keys, message: "The service refused this key: it is unknown, expired or revoked." };
  }
  if (ctx.reason === "workspace_context_mismatch") {
    return { kind: "use_workspace_key", url: keys, message: "This key belongs to a different workspace than this project or --workspace names." };
  }
  if (outcome === "rate_limited") return { kind: "retry_later", message: "Wait, then run the same command again." };
  if (outcome === "capability_unavailable") {
    return { kind: "use_dashboard", message: "This deployment does not offer experiments to this key. Nothing was started.", url: null };
  }
  return null;
}
