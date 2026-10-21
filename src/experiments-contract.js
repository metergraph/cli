import { normalizeUuid } from "./auth-oauth.js";
import { EXPERIMENT_MAX_TRACKED_FIELDS, EXPERIMENT_MAX_TREATMENTS, EXPERIMENT_REASONING_EFFORTS } from "./constants.js";
import {
  Invalid,
  displayText,
  hasUnsafeText,
  isAmount,
  isCount,
  isObject,
  isTimestamp,
  isToken,
  provenance,
  rowObject,
  run,
} from "./read-contract.js";

// Validators for the service's experiment documents (GET and POST
// /v1/agent/experiments...). They follow read-contract.js: each checks the
// document against the bound workspace and profile and the request this run
// sent, and returns a new object built only from fields it validated. The
// list, estimate, summary and start documents are Metadata: content_included
// must be false, and none carries an input, an output or a tracked field's
// value. Results are { ok: true, value } or { ok: false, outcome, reason }.

const STATUSES = Object.freeze(["queued", "running", "done", "failed"]);
const TERMINAL = Object.freeze(["done", "failed"]);
const BLOCKING = Object.freeze(["over_budget", "daily_budget_exhausted"]);
// The built-in statistics per arm, in the order they are shown. Rates are
// fractions from 0 to 1; any may be null when nothing returned.
export const STATISTICS = Object.freeze([
  "cost_per_call_usd",
  "latency_ms_p50",
  "output_tokens_p50",
  "output_chars_p50",
  "json_parse_rate",
  "same_keys_rate",
  "empty_or_refused_rate",
  "cut_off_rate",
]);
const RATES = new Set(["json_parse_rate", "same_keys_rate", "empty_or_refused_rate", "cut_off_rate"]);
const MAX_LIST = 50;
const MAX_MAP = 50;
const MAX_LINK = 2048;

const fail = (reason) => {
  throw new Invalid("verification_failed", reason);
};

function contentExcluded(body) {
  if (body.content_included !== false) throw new Invalid("verification_failed", "content_access_granted");
}

function nullableText(value, notices, reason) {
  return value === null || value === undefined ? null : displayText(value, notices, reason);
}

function nullableCount(value, reason) {
  if (value === null || value === undefined) return null;
  if (!isCount(value)) fail(reason);
  return value;
}

function nullableTimestamp(value, reason) {
  if (value === null || value === undefined) return null;
  if (!isTimestamp(value)) fail(reason);
  return value;
}

function amount(value, reason) {
  if (!isAmount(value)) fail(reason);
  return value;
}

function status(value, reason) {
  if (!STATUSES.includes(value)) fail(reason);
  return value;
}

function terminal(body, statusValue, reason) {
  if (body.terminal !== TERMINAL.includes(statusValue)) fail(reason);
  return body.terminal;
}

function errorCode(value, reason) {
  if (value === null || value === undefined) return null;
  if (!isToken(value)) fail(reason);
  return value;
}

// Extra request fields a treatment may set from the service's allowlist,
// such as web_search_options.search_context_size: tokens only.
function extraParams(value, reason) {
  if (!isObject(value) || Object.keys(value).length > MAX_MAP) fail(reason);
  const result = {};
  for (const [key, fields] of Object.entries(value)) {
    if (!isToken(key) || !isObject(fields) || Object.keys(fields).length > MAX_MAP) fail(reason);
    result[key] = {};
    for (const [name, entry] of Object.entries(fields)) {
      if (!isToken(name) || !isToken(entry)) fail(reason);
      result[key][name] = entry;
    }
  }
  return result;
}

// temperature, max_tokens, reasoning_effort and extra_params, as the service bounds them.
function settings(value, reason) {
  if (value === undefined || value === null) return {};
  if (!isObject(value)) fail(reason);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key === "temperature" && typeof entry === "number" && entry >= 0 && entry <= 2) result.temperature = entry;
    else if (key === "max_tokens" && Number.isSafeInteger(entry) && entry >= 1) result.max_tokens = entry;
    else if (key === "reasoning_effort" && EXPERIMENT_REASONING_EFFORTS.includes(entry)) result.reasoning_effort = entry;
    else if (key === "extra_params") result.extra_params = extraParams(entry, reason);
    else fail(reason);
  }
  return result;
}

function armSetup(value, notices, reason) {
  const arm = rowObject(value, reason);
  return {
    label: displayText(arm.label, notices, reason),
    provider: displayText(arm.provider, notices, reason),
    model: displayText(arm.model, notices, reason),
    settings: settings(arm.settings, reason),
  };
}

// A token-to-count map (production models seen, skip reasons, limitations).
function counts(value, notices, reason, { text = false } = {}) {
  if (value === undefined || value === null) return {};
  if (!isObject(value) || Object.keys(value).length > MAX_MAP) fail(reason);
  const result = {};
  for (const [key, entry] of Object.entries(value)) {
    if (!isCount(entry)) fail(reason);
    if (text) {
      const name = displayText(key, notices, reason);
      if (name !== null) result[name] = entry;
    } else {
      if (!isToken(key)) fail(reason);
      result[key] = entry;
    }
  }
  return result;
}

function statistics(value, reason) {
  if (!isObject(value) || !isCount(value.cases) || !isCount(value.errors)) fail(reason);
  const result = { cases: value.cases, errors: value.errors };
  for (const name of STATISTICS) {
    const entry = value[name];
    if (entry === null || entry === undefined) {
      result[name] = null;
      continue;
    }
    if (!isAmount(entry) || (RATES.has(name) && entry > 1)) fail(reason);
    result[name] = entry;
  }
  for (const name of ["temperature_dropped", "response_format_dropped", "temperature_ignored_with_reasoning"]) {
    result[name] = value[name] === undefined ? 0 : nullableCount(value[name], reason) ?? 0;
  }
  return result;
}

function sample(value, notices, reason) {
  if (!isObject(value)) fail(reason);
  return {
    last_n: nullableCount(value.last_n, reason),
    model: nullableText(value.model, notices, reason),
    cases: nullableCount(value.cases, reason),
  };
}

function trackedFields(value, notices, reason) {
  if (!Array.isArray(value) || value.length > EXPERIMENT_MAX_TRACKED_FIELDS) fail(reason);
  return value.map((path) => displayText(path, notices, reason));
}

// A browser link to the Experiments page, kept only when it is on the bound
// origin, names exactly this experiment or workload and the bound workspace.
// Anything else is dropped with a notice, never printed or opened.
export function experimentLink(raw, ctx, expected, notices) {
  if (raw === null || raw === undefined) return null;
  const dropped = () => {
    notices.add("experiment_link_omitted");
    return null;
  };
  if (typeof raw !== "string" || raw.length > MAX_LINK || /[^\x21-\x7e]|\\/.test(raw)) return dropped();
  try {
    decodeURIComponent(raw);
  } catch {
    return dropped();
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    return dropped();
  }
  if (url.origin !== ctx.origin || url.username || url.password || url.pathname !== "/" || url.search ||
      !(url.hash === "#experiments" || url.hash.startsWith("#experiments?"))) {
    return dropped();
  }
  const query = new URLSearchParams(url.hash.slice("#experiments?".length));
  const seen = new Set();
  for (const [key, value] of query) {
    if (!["workload", "id", "view", "workspace"].includes(key) || seen.has(key) || hasUnsafeText(value)) return dropped();
    seen.add(key);
  }
  if (query.get("workspace") !== ctx.workspaceId) return dropped();
  for (const key of ["workload", "id", "view"]) {
    if ((query.get(key) ?? null) !== (expected[key] ?? null)) return dropped();
  }
  return raw;
}

// GET /v1/agent/experiments?workload_id=&limit=
export function experimentsList(body, ctx, request, notices) {
  return run(() => {
    const reason = "experiments_response_invalid";
    const origin = provenance(body, ctx, reason);
    contentExcluded(body);
    if ((body.workload_id ?? null) !== request.workloadId) throw new Invalid("verification_failed", "filter_mismatch");
    if (!isObject(body.page) || body.page.limit !== request.limit || typeof body.page.truncated !== "boolean") fail(reason);
    if (!Array.isArray(body.experiments) || body.experiments.length > Math.min(request.limit, MAX_LIST)) fail(reason);
    const experiments = body.experiments.map((value) => {
      const row = rowObject(value, reason);
      const id = normalizeUuid(row.id);
      const state = status(row.status, reason);
      const workload = displayText(row.workload_id, notices, reason);
      if (id === null) fail(reason);
      if (request.workloadId !== null && row.workload_id !== request.workloadId) {
        throw new Invalid("verification_failed", "filter_not_applied");
      }
      if (!Array.isArray(row.arms) || row.arms.length > EXPERIMENT_MAX_TREATMENTS) fail(reason);
      return {
        id,
        status: state,
        terminal: terminal(row, state, reason),
        workload_id: workload,
        sample: sample(row.sample, notices, reason),
        arms: row.arms.map((arm) => armSetup(arm, notices, reason)),
        estimate_usd: amount(row.estimate_usd, reason),
        budget_usd: amount(row.budget_usd, reason),
        spent_usd: amount(row.spent_usd, reason),
        error_code: errorCode(row.error_code, reason),
        created_at: nullableTimestamp(row.created_at, reason),
        finished_at: nullableTimestamp(row.finished_at, reason),
        app_url: experimentLink(row.app_url, ctx, { workload: row.workload_id, id: row.id }, notices),
      };
    });
    return { provenance: origin, workload_id: request.workloadId, page: { limit: request.limit, truncated: body.page.truncated }, experiments };
  });
}

// The service echoes the request it read, with default labels and settings
// filled in. It must be the request this run sent.
function echoedRequest(value, sent, notices, reason) {
  if (!isObject(value) || value.workload_id !== sent.workload_id || !isObject(value.sample)) {
    throw new Invalid("verification_failed", "request_mismatch");
  }
  if (value.sample.last_n !== sent.sample.last_n || (value.sample.model ?? null) !== (sent.sample.model ?? null)) {
    throw new Invalid("verification_failed", "request_mismatch");
  }
  if (!Array.isArray(value.treatments) || value.treatments.length !== sent.treatments.length) {
    throw new Invalid("verification_failed", "request_mismatch");
  }
  const treatments = value.treatments.map((arm, index) => {
    const mine = sent.treatments[index];
    if (!isObject(arm) || arm.provider !== mine.provider || arm.model !== mine.model ||
        (mine.label !== undefined && arm.label !== mine.label)) {
      throw new Invalid("verification_failed", "request_mismatch");
    }
    const setup = armSetup(arm, notices, reason);
    for (const [key, entry] of Object.entries(mine.settings ?? {})) {
      if (setup.settings[key] !== entry) throw new Invalid("verification_failed", "request_mismatch");
    }
    return setup;
  });
  const tracked = trackedFields(value.tracked_fields, notices, reason);
  if (JSON.stringify(value.tracked_fields) !== JSON.stringify(sent.tracked_fields)) {
    throw new Invalid("verification_failed", "request_mismatch");
  }
  return {
    workload_id: sent.workload_id,
    sample: { last_n: sent.sample.last_n, ...(sent.sample.model ? { model: sent.sample.model } : {}) },
    treatments,
    tracked_fields: tracked,
  };
}

function armEstimates(value, treatments, notices, reason) {
  if (!Array.isArray(value) || value.length !== treatments.length) fail(reason);
  return value.map((entry, index) => {
    const arm = rowObject(entry, reason);
    const treatment = treatments[index];
    if (arm.label !== treatment.label || arm.gateway_model !== `${treatment.provider}/${treatment.model}`) fail(reason);
    return {
      label: displayText(arm.label, notices, reason),
      gateway_model: displayText(arm.gateway_model, notices, reason),
      estimate_usd: amount(arm.estimate_usd, reason),
    };
  });
}

function estimatedSample(value, notices, reason) {
  return { ...sample(value, notices, reason), models_seen: counts(value.models_seen, notices, reason, { text: true }) };
}

// POST /v1/agent/experiments/estimate. Writes and spends nothing.
export function experimentEstimate(body, ctx, request, notices) {
  return run(() => {
    const reason = "experiment_estimate_invalid";
    const origin = provenance(body, ctx, reason);
    contentExcluded(body);
    const echoed = echoedRequest(body.request, request, notices, reason);
    const estimate = body.estimate;
    if (!isObject(estimate)) fail(reason);
    for (const flag of ["over_budget", "daily_budget_exhausted"]) {
      if (typeof estimate[flag] !== "boolean") fail(reason);
    }
    if (!Array.isArray(body.blocking_reasons) || !body.blocking_reasons.every((entry) => BLOCKING.includes(entry))) fail(reason);
    for (const flag of BLOCKING) {
      if (body.blocking_reasons.includes(flag) !== estimate[flag]) fail(reason);
    }
    const start = body.start;
    if (!isObject(start) || start.tool !== "metergraph_start_experiment" || typeof start.granted !== "boolean") fail(reason);
    const links = isObject(body.metergraph_links) ? body.metergraph_links : {};
    return {
      provenance: origin,
      request: echoed,
      estimate: {
        estimate_usd: amount(estimate.estimate_usd, reason),
        budget_usd: amount(estimate.budget_usd, reason),
        over_budget: estimate.over_budget,
        daily_budget_usd: amount(estimate.daily_budget_usd, reason),
        spent_24h_usd: amount(estimate.spent_24h_usd, reason),
        daily_budget_exhausted: estimate.daily_budget_exhausted,
        sample: estimatedSample(estimate.sample, notices, reason),
        arms: armEstimates(estimate.arms, echoed.treatments, notices, reason),
      },
      blocking_reasons: [...body.blocking_reasons],
      start_granted: start.granted,
      new_experiment_url: experimentLink(links.new_experiment, ctx, { workload: request.workload_id, view: "new" }, notices),
    };
  });
}

// POST /v1/agent/experiments, 202. The only write this CLI makes.
export function experimentStarted(body, ctx, request, notices) {
  return run(() => {
    const reason = "experiment_start_invalid";
    const origin = provenance(body, ctx, reason);
    contentExcluded(body);
    const echoed = echoedRequest(body.request, request, notices, reason);
    const experiment = rowObject(body.experiment, reason);
    const id = normalizeUuid(experiment.id);
    if (id === null || experiment.workload_id !== request.workload_id) fail(reason);
    const state = status(experiment.status, reason);
    if (state === "failed" && !isToken(experiment.error_code)) fail(reason);
    return {
      provenance: origin,
      request: echoed,
      experiment: {
        id,
        status: state,
        terminal: terminal(experiment, state, reason),
        workload_id: request.workload_id,
        error_code: errorCode(experiment.error_code, reason),
        estimate_usd: amount(experiment.estimate_usd, reason),
        budget_usd: amount(experiment.budget_usd, reason),
        sample: estimatedSample(experiment.sample, notices, reason),
        arms: armEstimates(experiment.arms, echoed.treatments, notices, reason),
      },
      app_url: experimentLink(body.app_url, ctx, { workload: request.workload_id, id: experiment.id }, notices),
    };
  });
}

// GET /v1/agent/experiments/<id>: status while it runs, then the built-in
// statistics per arm next to the production control over the same cases.
// They show differences; nothing here judges a treatment.
export function experimentSummary(body, ctx, request, notices) {
  return run(() => {
    const reason = "experiment_response_invalid";
    const origin = provenance(body, ctx, reason);
    contentExcluded(body);
    const experiment = rowObject(body.experiment, reason);
    if (normalizeUuid(experiment.id) !== request.id) fail(reason);
    const state = status(experiment.status, reason);
    const sampled = experiment.sample;
    if (!isObject(sampled) || !isCount(sampled.replayed) || !isCount(sampled.not_replayable)) fail(reason);
    const spend = experiment.spend;
    if (!isObject(spend)) fail(reason);
    const control = experiment.control;
    if (!isObject(control)) fail(reason);
    if (!Array.isArray(experiment.arms) || experiment.arms.length > EXPERIMENT_MAX_TREATMENTS) fail(reason);
    const workload = displayText(experiment.workload_id, notices, reason);
    return {
      provenance: origin,
      experiment: {
        id: request.id,
        status: state,
        terminal: terminal(experiment, state, reason),
        workload_id: workload,
        error_code: errorCode(experiment.error_code, reason),
        created_at: nullableTimestamp(experiment.created_at, reason),
        started_at: nullableTimestamp(experiment.started_at, reason),
        finished_at: nullableTimestamp(experiment.finished_at, reason),
        sample: {
          ...sample(sampled, notices, reason),
          replayed: sampled.replayed,
          not_replayable: sampled.not_replayable,
          not_replayable_reasons: counts(sampled.not_replayable_reasons, notices, reason),
          limitations: counts(sampled.limitations, notices, reason),
        },
        tracked_fields: trackedFields(experiment.tracked_fields, notices, reason),
        spend: {
          estimate_usd: amount(spend.estimate_usd, reason),
          budget_usd: amount(spend.budget_usd, reason),
          spent_usd: amount(spend.spent_usd, reason),
          reserved_usd: amount(spend.reserved_usd, reason),
        },
        control: {
          model: nullableText(control.model, notices, reason),
          provider: nullableText(control.provider, notices, reason),
          models_seen: counts(control.models_seen, notices, reason, { text: true }),
          statistics: statistics(control.summary, reason),
        },
        arms: experiment.arms.map((value) => {
          const arm = rowObject(value, reason);
          if (typeof arm.temperature_ignored_with_reasoning !== "boolean") fail(reason);
          return {
            ...armSetup(arm, notices, reason),
            temperature_ignored_with_reasoning: arm.temperature_ignored_with_reasoning,
            statistics: statistics(arm.summary, reason),
            control_statistics: statistics(arm.control_summary, reason),
          };
        }),
        app_url: experimentLink(experiment.app_url, ctx, { workload: experiment.workload_id, id: experiment.id }, notices),
      },
    };
  });
}

// The service's refusal of an estimate, start or read, as fixed tokens and
// validated numbers. Its message text is never kept.
export function experimentRefusal(body) {
  const error = isObject(body?.error) ? body.error : null;
  if (error === null || !isToken(error.code)) return null;
  const refusal = { code: error.code, reason: isToken(error.reason) ? error.reason : null };
  for (const key of ["estimate_usd", "budget_usd", "spent_24h_usd", "daily_budget_usd", "committed_usd"]) {
    if (isAmount(error[key])) refusal[key] = error[key];
  }
  if (Array.isArray(error.allowed) && error.allowed.length <= EXPERIMENT_REASONING_EFFORTS.length &&
      error.allowed.every((entry) => EXPERIMENT_REASONING_EFFORTS.includes(entry))) {
    refusal.allowed = [...error.allowed];
  }
  return refusal;
}
