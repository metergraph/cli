import { normalizeUuid } from "./auth-oauth.js";
import {
  AGENT_CONTRACT_VERSION,
  MAX_CURSOR_LENGTH,
  MAX_METADATA_VALUE_LENGTH,
  METADATA_SCOPE,
} from "./constants.js";
import { traceLink } from "./trace-contract.js";

// Validators for the service's Metadata read documents. Each one checks the
// document against the agent access contract, the bound workspace and the
// bound deployment profile, and returns a new object built only from fields it
// validated. Nothing from a document is copied by reflection: unknown fields,
// including any that would carry captured content, are never returned, and
// their names are never reported. Results are
//   { ok: true, value } or { ok: false, outcome, reason }
// with fixed tokens. notices is a Set that collects fixed notice tokens.

// Every capability name the contract defines, in its order. The last three
// read content or replay and are never available to a Metadata grant.
export const CAPABILITY_NAMES = Object.freeze([
  "workspace_context",
  "capability_discovery",
  "routes",
  "usage",
  "usage_aggregates",
  "ingestion_health",
  "incidents",
  "trace_metadata",
  "reports",
  "report_detail",
  "report_evidence",
  "trace_content",
  "trace_replay",
]);
const PRIVACY_CLASSES = Object.freeze(["metadata", "content", "replay"]);
const SCOPES = Object.freeze(["agent:metadata", "agent:read", "agent:replay"]);

const TOKEN = /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/;
const IDENT = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const HASH = /^[A-Za-z0-9:._+/=-]{1,256}$/;
const CURSOR = new RegExp(`^[\\x21-\\x7e]{1,${MAX_CURSOR_LENGTH}}$`);
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// Code point ranges that change how a terminal shows text: C0 and C1
// controls, zero-width and bidirectional formatting, line and paragraph
// separators, and the byte order mark.
const UNSAFE_RANGES = Object.freeze([
  [0x0000, 0x001f],
  [0x007f, 0x009f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
]);
const MAX_TEXT = 256;
const MAX_LIST = 64;
const MAX_WARNINGS = 50;
const MAX_ROUTE_ROWS = 10000;

// Keys that would carry captured content or credentials. A metadata row that
// has one is refused as a whole; none of its values is returned.
const FORBIDDEN_ROW_KEYS = new Set([
  "prompt",
  "prompts",
  "input",
  "inputs",
  "output",
  "outputs",
  "messages",
  "text",
  "content",
  "completion",
  "request",
  "response",
  "spans",
  "system",
  "tool_calls",
  "tool_definitions",
  "api_key",
  "token",
  "access_token",
  "refresh_token",
  "authorization",
  "password",
  "secret",
  "email",
]);

class Invalid extends Error {
  constructor(outcome, reason) {
    super(reason);
    this.outcome = outcome;
    this.reason = reason;
  }
}

function run(work) {
  try {
    return { ok: true, value: work() };
  } catch (error) {
    if (error instanceof Invalid) return { ok: false, outcome: error.outcome, reason: error.reason };
    throw error;
  }
}

const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const isCount = (value) => Number.isSafeInteger(value) && value >= 0;
const isAmount = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const isToken = (value) => typeof value === "string" && TOKEN.test(value);
// An ISO 8601 timestamp with a real calendar date and clock time; the parser
// would roll 2026-02-29 or 24:00 over to another instant.
const isTimestamp = (value) => {
  if (typeof value !== "string" || value.length > 40 || !TIMESTAMP.test(value)) return false;
  if (!Number.isFinite(Date.parse(value))) return false;
  const [year, month, day] = value.slice(0, 10).split("-").map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    return false;
  }
  const [hours, minutes, seconds] = value.slice(11, 19).split(":").map(Number);
  return hours <= 23 && minutes <= 59 && seconds <= 59;
};
// A real calendar date: the parser rolls 2026-02-30 over to March, so the
// parsed date must print back as the same string.
const isDate = (value) => {
  if (typeof value !== "string" || !DATE.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
};

export function hasUnsafeText(value) {
  for (const char of value) {
    const code = char.codePointAt(0);
    if (UNSAFE_RANGES.some(([low, high]) => code >= low && code <= high)) return true;
  }
  return false;
}

export function isCursor(value) {
  return typeof value === "string" && CURSOR.test(value);
}

export function isSafeFilter(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && !hasUnsafeText(value);
}

// The one JSON object sent as the metadata query parameter. filters are
// already sorted by key, so the text is stable.
export function metadataQueryValue(filters) {
  return JSON.stringify(Object.fromEntries(filters.map(({ key, value }) => [key, value])));
}

// The query string a read command sends, built only from validated options.
// Argument validation measures this same object, so its length check and the
// transport's agree exactly. The routes endpoint takes none.
export function readQuery(options, request = null) {
  if (options.command === "routes") return null;
  if (options.command === "usage" && options.grouped) return groupedReadQuery(request ?? groupedRequest(options));
  const query = new URLSearchParams();
  query.set("days", String(options.days));
  query.set("limit", String(options.limit));
  if (options.metadata) query.set("metadata", metadataQueryValue(options.metadata));
  if (options.command === "traces") {
    if (options.route !== null) query.set("route", options.route);
    if (options.status !== null) query.set("status", options.status);
    if (options.cursor !== null) query.set("cursor", options.cursor);
  }
  return query;
}

// What a grouped usage document must echo back, from validated options.
export function groupedRequest(options) {
  const { groupBy, filters, since, until } = options.grouped;
  return {
    days: options.days,
    since,
    until,
    limit: options.limit,
    groupBy,
    filters,
    metadata: options.metadata ?? null,
  };
}

// Grouped usage query: one group_by parameter per dimension (a metadata key
// is sent whole, never split on a comma), a preset or an explicit window, and
// one repeated parameter per exact filter value.
function groupedReadQuery(request) {
  const query = new URLSearchParams();
  for (const dimension of request.groupBy) query.append("group_by", dimension);
  if (request.days !== null) query.set("days", String(request.days));
  else {
    query.set("since", request.since);
    if (request.until !== null) query.set("until", request.until);
  }
  query.set("limit", String(request.limit));
  for (const key of ["route", "provider", "model", "environment"]) {
    for (const value of request.filters[key] ?? []) query.append(key, value);
  }
  if (request.metadata) query.set("metadata", metadataQueryValue(request.metadata));
  return query;
}

// Rows do not carry metadata, so the only proof a metadata filter applied is
// the service's echo in coverage.filters.metadata. It must list exactly the
// requested pairs, in key order. A service that does not echo them (an older
// one) is refused rather than trusted, and an echo of pairs the CLI did not
// send is refused too.
function checkMetadataEcho(body, request) {
  const requested = request.metadata ?? [];
  const filters = isObject(body.coverage) && isObject(body.coverage.filters) ? body.coverage.filters : null;
  const echoed = filters === null ? undefined : filters.metadata;
  if (echoed === undefined || echoed === null) {
    if (requested.length > 0) throw new Invalid("unsupported", "metadata_filter_unsupported");
    return;
  }
  if (!Array.isArray(echoed) || echoed.length !== requested.length) {
    throw new Invalid("verification_failed", "metadata_filter_mismatch");
  }
  echoed.forEach((entry, index) => {
    if (
      !isObject(entry) ||
      entry.key !== requested[index].key ||
      entry.value !== requested[index].value
    ) {
      throw new Invalid("verification_failed", "metadata_filter_mismatch");
    }
  });
}

// A metadata value is a customer's opaque string. Like a route name it is
// untrusted text: one that could change how a terminal shows output is
// replaced with null and noted.
function metadataText(value, notices, reason) {
  if (typeof value !== "string" || value.length > MAX_METADATA_VALUE_LENGTH) {
    throw new Invalid("verification_failed", reason);
  }
  if (hasUnsafeText(value)) {
    notices.add("unsafe_text_omitted");
    return null;
  }
  return value;
}

// Text a person reads, such as a route or model name. It is untrusted
// metadata, never an instruction. A string that could change how a terminal
// shows output is replaced with null and noted; any other type is invalid.
function displayText(value, notices, reason, { nullable = false } = {}) {
  if (value === null && nullable) return null;
  if (typeof value !== "string") throw new Invalid("verification_failed", reason);
  if (!isSafeFilter(value)) {
    notices.add("unsafe_text_omitted");
    return null;
  }
  return value;
}

function rowObject(value, reason) {
  if (!isObject(value)) throw new Invalid("verification_failed", reason);
  for (const key of Object.keys(value)) {
    if (FORBIDDEN_ROW_KEYS.has(key.toLowerCase())) {
      throw new Invalid("verification_failed", "content_in_metadata_response");
    }
  }
  return value;
}

// Every document names the bound workspace and profile in its provenance.
function provenance(body, ctx, reason) {
  if (!isObject(body)) throw new Invalid("verification_failed", reason);
  if (body.schema_version !== AGENT_CONTRACT_VERSION) {
    throw new Invalid("unsupported", "contract_version_unsupported");
  }
  const source = body.provenance;
  if (!isObject(source)) throw new Invalid("verification_failed", reason);
  if (normalizeUuid(source.workspace_id) !== ctx.workspaceId) {
    throw new Invalid("verification_failed", "workspace_context_mismatch");
  }
  if (source.deployment_profile !== ctx.profile) throw new Invalid("verification_failed", "profile_mismatch");
  if (!isTimestamp(source.generated_at) || !isToken(source.source)) {
    throw new Invalid("verification_failed", reason);
  }
  return {
    deployment_profile: ctx.profile,
    workspace_id: ctx.workspaceId,
    generated_at: source.generated_at,
    source: source.source,
  };
}

function contentExcluded(body) {
  if (body.content_included !== false) throw new Invalid("verification_failed", "content_access_granted");
}

function window(value, days, reason) {
  if (!isObject(value) || value.days !== days || !isTimestamp(value.since) || !isTimestamp(value.until)) {
    throw new Invalid("verification_failed", reason);
  }
  if (Date.parse(value.since) > Date.parse(value.until)) throw new Invalid("verification_failed", reason);
  return { days, since: value.since, until: value.until };
}

function evidence(value, reason) {
  if (
    !isObject(value) ||
    !Array.isArray(value.sources) ||
    value.sources.length > MAX_LIST ||
    !value.sources.every(isToken) ||
    !isCount(value.rows) ||
    typeof value.complete !== "boolean"
  ) {
    throw new Invalid("verification_failed", reason);
  }
  return { sources: [...value.sources], rows: value.rows, complete: value.complete };
}

// Only warning codes are returned. Warning messages are server text and are
// never printed.
function warnings(value, notices, reason) {
  if (!Array.isArray(value) || value.length > MAX_WARNINGS) throw new Invalid("verification_failed", reason);
  return value.map((entry) => {
    if (!isObject(entry) || !isToken(entry.code)) throw new Invalid("verification_failed", reason);
    if (entry.message !== undefined && entry.message !== null) {
      if (typeof entry.message !== "string") throw new Invalid("verification_failed", reason);
      notices.add("warning_messages_omitted");
    }
    return { code: entry.code };
  });
}

function nameList(value, notices, reason) {
  if (!Array.isArray(value) || value.length > MAX_LIST) throw new Invalid("verification_failed", reason);
  const names = [];
  for (const entry of value) {
    const name = displayText(entry, notices, reason);
    if (name !== null) names.push(name);
  }
  return names;
}

// Coverage, pricing and attribution evidence. The service adds these objects
// to usage and trace documents; an older service omits them, and that is
// reported rather than read as complete. Reasons are fixed tokens. A reason
// this CLI does not know is kept, and unless the service already says
// partial it makes completeness unknown: unknown evidence never reads as
// complete.
const PARTIAL_REASONS = new Set([
  "row_limit",
  "page_unread",
  "window_clamped",
  "retention_clipped",
  "ingestion_pending",
  "ingestion_failed",
  "scope_incomplete",
]);
const UNKNOWN_REASONS = new Set(["ingestion_unverified", "evidence_missing"]);
const PRICING_REASONS = new Set(["pricing_missing", "pricing_partial", "pricing_unknown"]);
// Name why a metadata grouping has a null group (calls without the key, or
// with an ineligible value). Those calls are still counted, so these never
// change completeness.
const METADATA_REASONS = new Set(["metadata_key_missing", "metadata_value_ineligible"]);
const COMPLETENESS = ["complete", "partial", "unknown"];
const RANK = Object.freeze({ complete: 0, unknown: 1, partial: 2 });
const ROW_SHAPES = ["top_n", "page", "all"];
const TOTALS_SCOPES = ["population", "returned_rows", "page"];
const FILTER_KEYS = ["route", "provider", "model", "status", "workload", "trace_id", "request_id", "environments"];

// The worst of the service's completeness and what the reasons imply.
export function completenessOf(stated, reasons) {
  let derived = "complete";
  for (const reason of reasons) {
    if (PARTIAL_REASONS.has(reason)) derived = "partial";
    else if (!PRICING_REASONS.has(reason) && !METADATA_REASONS.has(reason) && derived === "complete") {
      derived = "unknown";
    }
  }
  return RANK[stated] >= RANK[derived] ? stated : derived;
}

function windowSpan(value, reason) {
  if (value === null) return null;
  if (!isObject(value) || !isTimestamp(value.since) || !isTimestamp(value.until) || !isAmount(value.days)) {
    throw new Invalid("verification_failed", reason);
  }
  return { since: value.since, until: value.until, days: value.days };
}

function coverageOf(value, notices, reason) {
  if (value === undefined || value === null) {
    notices.add("coverage_not_reported");
    return null;
  }
  const rows = value.rows;
  const nullableCount = (entry) => entry === null || isCount(entry);
  if (
    !isObject(value) ||
    !isTimestamp(value.as_of) ||
    !isObject(value.filters) ||
    !isObject(rows) ||
    !ROW_SHAPES.includes(rows.shape) ||
    !(rows.ordering === null || isSafeFilter(rows.ordering)) ||
    !isCount(rows.returned) ||
    !nullableCount(rows.limit) ||
    !(rows.truncated === null || typeof rows.truncated === "boolean") ||
    !nullableCount(rows.matched) ||
    !(value.next_cursor === null || isCursor(value.next_cursor)) ||
    !TOTALS_SCOPES.includes(value.totals_scope) ||
    !COMPLETENESS.includes(value.completeness) ||
    !Array.isArray(value.reasons) ||
    value.reasons.length > MAX_LIST ||
    !value.reasons.every(isToken)
  ) {
    throw new Invalid("verification_failed", reason);
  }
  // Applied filters are echoed by name only, as whether one was applied.
  // Their values are request arguments or names and are not printed back.
  const filters = {};
  for (const key of FILTER_KEYS) {
    if (Object.hasOwn(value.filters, key)) filters[key] = value.filters[key] !== null;
  }
  // Metadata is echoed as a list of pairs; an empty list means none applied.
  if (Object.hasOwn(value.filters, "metadata")) {
    filters.metadata = Array.isArray(value.filters.metadata) && value.filters.metadata.length > 0;
  }
  const reasons = [...new Set(value.reasons)].sort();
  const completeness = completenessOf(value.completeness, reasons);
  if (completeness === "partial") notices.add("coverage_partial");
  if (completeness === "unknown") notices.add("coverage_unknown");
  return {
    as_of: value.as_of,
    requested_window: windowSpan(value.requested_window ?? null, reason),
    effective_window: windowSpan(value.effective_window ?? null, reason),
    filters_applied: filters,
    rows: {
      shape: rows.shape,
      ordering: rows.ordering,
      returned: rows.returned,
      limit: rows.limit,
      truncated: rows.truncated,
      matched: rows.matched,
    },
    next_cursor: value.next_cursor,
    totals_scope: value.totals_scope,
    completeness,
    reasons,
  };
}

// The coverage object must describe the document it arrived in: the same row
// shape, totals scope, limit, returned count, truncation, cursor and
// requested days. Stale or mismatched coverage fails closed rather than
// deciding completeness.
function checkCoverage(coverage, expected, reason) {
  if (coverage === null) return;
  const rows = coverage.rows;
  if (
    rows.shape !== expected.shape ||
    coverage.totals_scope !== expected.totalsScope ||
    rows.limit !== expected.limit ||
    rows.returned !== expected.returned ||
    rows.truncated !== expected.truncated ||
    coverage.next_cursor !== expected.nextCursor ||
    (rows.matched !== null && rows.matched < rows.returned) ||
    (coverage.requested_window !== null && coverage.requested_window.days !== expected.days)
  ) {
    throw new Invalid("verification_failed", reason);
  }
}

const PRICING_COUNTS = ["priced_calls", "zero_cost_calls", "partial_calls", "unpriced_calls", "unknown_calls"];

// calls is the number of calls the pricing describes, when the document
// states it. The four disjoint classes must account for exactly those calls,
// so an undercounted pricing object can never present cost as exact.
function pricingOf(value, notices, reason, { note = true, calls = null } = {}) {
  if (value === undefined || value === null) return null;
  if (
    !isObject(value) ||
    !PRICING_COUNTS.every((key) => isCount(value[key])) ||
    value.zero_cost_calls > value.priced_calls ||
    (value.cost !== "exact" && value.cost !== "lower_bound") ||
    (calls !== null &&
      value.priced_calls + value.partial_calls + value.unpriced_calls + value.unknown_calls !== calls)
  ) {
    throw new Invalid("verification_failed", reason);
  }
  // Exact cost needs every call priced; a service claiming otherwise is
  // read as a lower bound.
  const unpricedAny = value.partial_calls + value.unpriced_calls + value.unknown_calls > 0;
  const cost = unpricedAny ? "lower_bound" : value.cost;
  if (cost === "lower_bound" && note) notices.add("pricing_lower_bound");
  return { ...Object.fromEntries(PRICING_COUNTS.map((key) => [key, value[key]])), cost };
}

// trace_total: each trace row aggregates the whole trace. matching_calls: a
// route, status or request filter selected calls, so each row covers only
// its matching calls.
const TRACE_COST_BASES = Object.freeze(["trace_total", "matching_calls"]);

// level, when given, is the only attribution level the read can have:
// trace reads return whole-trace totals whatever the document claims.
function attributionOf(value, reason, level = null) {
  if (value === undefined || value === null) return null;
  if (level !== null && isObject(value) && (value.level !== level ||
      (level === "trace" && (!TRACE_COST_BASES.includes(value.cost_basis) || value.per_provider_exact !== false)))) {
    throw new Invalid("verification_failed", reason);
  }
  const nullableCount = (entry) => entry === null || isCount(entry);
  if (
    !isObject(value) ||
    (value.level !== "call" && value.level !== "trace") ||
    (value.cost_basis !== "call" && !TRACE_COST_BASES.includes(value.cost_basis)) ||
    typeof value.per_provider_exact !== "boolean" ||
    !nullableCount(value.mixed_provider_rows) ||
    !nullableCount(value.mixed_model_rows)
  ) {
    throw new Invalid("verification_failed", reason);
  }
  // A whole-trace total is never an exact per-provider split, whatever the
  // document says.
  const perProviderExact = value.level === "trace" ? false : value.per_provider_exact;
  return {
    level: value.level,
    cost_basis: value.cost_basis,
    per_provider_exact: perProviderExact,
    mixed_provider_rows: value.mixed_provider_rows,
    mixed_model_rows: value.mixed_model_rows,
  };
}

function populationTotalsOf(value, reason) {
  if (value === undefined || value === null) return null;
  if (
    !isObject(value) ||
    value.scope !== "population" ||
    !isCount(value.calls) ||
    !isCount(value.error_calls) ||
    !isAmount(value.cost_usd) ||
    !isCount(value.input_tokens) ||
    !isCount(value.output_tokens)
  ) {
    throw new Invalid("verification_failed", reason);
  }
  return {
    scope: "population",
    calls: value.calls,
    error_calls: value.error_calls,
    cost_usd: value.cost_usd,
    input_tokens: value.input_tokens,
    output_tokens: value.output_tokens,
  };
}

// Grouped usage: GET /v1/agent/usage/aggregates (the MCP tool
// metergraph_get_usage_aggregates returns the same document). Groups are
// computed by the service per call, so a trace that used two providers adds
// each call's cost to that call's provider. totals cover every call the
// window and filters match, whatever the limit. The window is UTC.
const USAGE_GROUP_DIMENSIONS = ["provider", "model", "route", "day"];
// At most one "metadata.<key>" dimension; its group field is the whole name.
const METADATA_DIMENSION = "metadata.";
const TOKEN_COUNTS = ["input_tokens", "output_tokens", "cache_read_tokens", "cache_write_tokens", "reasoning_tokens"];
const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;
const utcMidnight = (ms) => Math.floor(ms / DAY_MS) * DAY_MS;
// How far a window that ends "now" may be from this request: request latency
// plus clock difference between this machine and the service.
const REQUEST_TIME_SKEW_MS = 15 * 60 * 1000;

const P95_METHOD = "histogram_estimate";
// The service rounds amounts to 8 decimals; a product or sum of n rounded
// amounts may differ from the exact value by about n half-units, plus slack.
const costTolerance = (count) => 1e-6 + count * 1e-8;
// The service's order for grouped usage; truncation keeps its first groups.
const AGGREGATE_ORDERING = "cost_usd desc, calls desc, group key asc";
// An internal join key built from the raw group values, never printed: a
// value replaced by null for display (unsafe text) still compares by its
// real identity across windows.
export const GROUP_KEY = Symbol("group_key");
// The environments a grouped read covered (the service's echo, or null for
// all), kept off the printed result so comparisons can require the same set.
export const READ_ENVIRONMENTS = Symbol("read_environments");

// One group's or the population's metrics, shared by items and totals.
// Latency is labelled as the service defines it: avg_ms is the mean over the
// calls that reported latency (samples) and p95_ms is an estimate from a
// fixed histogram (p95_method), never an exact percentile.
function usageMetrics(row, reason) {
  const nullableCount = (value) => value === null || isCount(value);
  const latency = row.latency;
  if (
    !isCount(row.calls) ||
    !isCount(row.error_calls) ||
    row.error_calls > row.calls ||
    !isAmount(row.cost_usd) ||
    !(row.cost_per_call_usd === null || isAmount(row.cost_per_call_usd)) ||
    (row.calls === 0) !== (row.cost_per_call_usd === null) ||
    !TOKEN_COUNTS.every((key) => isCount(row[key])) ||
    !isObject(latency) ||
    !nullableCount(latency.avg_ms) ||
    !nullableCount(latency.p95_ms) ||
    // Output labels p95 as a fixed-histogram estimate, so only that method is read.
    latency.p95_method !== P95_METHOD ||
    !isCount(latency.samples) ||
    latency.samples > row.calls ||
    // Latency measured from no calls is no latency.
    (latency.samples === 0) !== (latency.avg_ms === null) ||
    (latency.samples === 0) !== (latency.p95_ms === null) ||
    // cost_per_call_usd must be cost_usd / calls, to the service's 8-decimal rounding.
    (row.calls > 0 && Math.abs(row.cost_per_call_usd * row.calls - row.cost_usd) > costTolerance(row.calls))
  ) {
    throw new Invalid("verification_failed", reason);
  }
  return {
    calls: row.calls,
    error_calls: row.error_calls,
    error_rate: row.calls === 0 ? null : Math.round((row.error_calls / row.calls) * 10000) / 10000,
    cost_usd: row.cost_usd,
    cost_per_call_usd: row.cost_per_call_usd,
    ...Object.fromEntries(TOKEN_COUNTS.map((key) => [key, row[key]])),
    latency: {
      avg_ms: latency.avg_ms,
      p95_ms: latency.p95_ms,
      p95_method: latency.p95_method,
      samples: latency.samples,
    },
  };
}

// The UTC window the service read, checked against what was asked. A preset
// covers the current UTC day so far and the days - 1 whole UTC days before
// it; an explicit window is [since, until). partial_days lists the UTC days
// the window covers only part of.
function usageWindow(value, request, reason) {
  if (
    !isObject(value) ||
    value.timezone !== "UTC" ||
    !isTimestamp(value.since) ||
    !isTimestamp(value.until) ||
    typeof value.until_is_request_time !== "boolean"
  ) {
    throw new Invalid("verification_failed", reason);
  }
  const since = Date.parse(value.since);
  const until = Date.parse(value.until);
  if (since >= until) throw new Invalid("verification_failed", reason);
  if (request.days !== null) {
    if (
      value.preset !== "utc_days" ||
      value.days !== request.days ||
      !value.until_is_request_time ||
      since !== utcMidnight(until) - (request.days - 1) * DAY_MS
    ) {
      throw new Invalid("verification_failed", "window_mismatch");
    }
  } else if (
    value.preset !== null ||
    value.days !== null ||
    since !== Date.parse(request.since) ||
    (request.until === null
      ? !value.until_is_request_time
      : value.until_is_request_time || until !== Date.parse(request.until))
  ) {
    throw new Invalid("verification_failed", "window_mismatch");
  }
  // A window that ends at the request time (a preset, or --since without
  // --until) must end within a bounded clock skew of this request, so a
  // response kept from earlier is never read as ending now.
  if (value.until_is_request_time && request.requestedAt !== undefined && request.requestedAt !== null) {
    if (Math.abs(until - request.requestedAt) > REQUEST_TIME_SKEW_MS) {
      throw new Invalid("verification_failed", "window_mismatch");
    }
  }
  const partialDays = [];
  if (since !== utcMidnight(since)) partialDays.push(new Date(since).toISOString().slice(0, 10));
  const lastDay = utcMidnight(until - 1);
  if (until !== utcMidnight(until) && (partialDays.length === 0 || lastDay !== utcMidnight(since))) {
    partialDays.push(new Date(lastDay).toISOString().slice(0, 10));
  }
  const result = {
    // utc_days: from 00:00 UTC, days - 1 whole UTC days before today, to now.
    // explicit: exactly [since, until).
    kind: value.preset === "utc_days" ? "utc_days" : "explicit",
    timezone: "UTC",
    preset: value.preset,
    days: value.days,
    since: value.since,
    until: value.until,
    until_is_request_time: value.until_is_request_time,
    hours: Math.round(((until - since) / HOUR_MS) * 100) / 100,
    partial_days: partialDays,
  };
  // First and last UTC days the window covers; not part of the output.
  Object.defineProperties(result, {
    since_day: { value: new Date(since).toISOString().slice(0, 10) },
    last_day: { value: new Date(until - 1).toISOString().slice(0, 10) },
  });
  return result;
}

// Exact filters echoed in coverage.filters must be the ones requested. An
// environment list the CLI did not ask for is the key's own restriction.
function checkUsageFilters(raw, request, notices) {
  const echoed = raw?.filters;
  if (!isObject(echoed)) throw new Invalid("verification_failed", "usage_response_invalid");
  // Exactly the same values: no duplicates, nothing missing, nothing extra.
  const sameSet = (left, right) =>
    new Set(left).size === left.length &&
    left.length === right.length &&
    left.every((entry) => right.includes(entry));
  // Filters grouped usage never sends must not be reported as applied.
  for (const [key, entry] of Object.entries(echoed)) {
    if (!["route", "provider", "model", "environments", "metadata"].includes(key) && entry !== null && entry !== undefined) {
      throw new Invalid("verification_failed", "filter_mismatch");
    }
  }
  for (const key of ["route", "provider", "model"]) {
    const asked = request.filters[key];
    const got = echoed[key] ?? null;
    if (asked === null ? got !== null : !(Array.isArray(got) && sameSet(got, asked))) {
      throw new Invalid("verification_failed", "filter_mismatch");
    }
  }
  const askedEnv = request.filters.environment;
  const gotEnv = echoed.environments ?? null;
  if (gotEnv !== null && (!Array.isArray(gotEnv) || !gotEnv.every((entry) => typeof entry === "string"))) {
    throw new Invalid("verification_failed", "usage_response_invalid");
  }
  if (askedEnv !== null) {
    if (gotEnv === null || !gotEnv.every((entry) => askedEnv.includes(entry))) {
      throw new Invalid("verification_failed", "filter_mismatch");
    }
    if (!sameSet(gotEnv, askedEnv)) notices.add("environment_restricted_key");
  } else if (gotEnv !== null) {
    notices.add("environment_restricted_key");
  }
  return gotEnv === null ? null : [...gotEnv].sort();
}

// Where a metadata grouping's calls went. Listed groups with a value, values
// past the limit (other_values), calls without the key (missing_key) and
// calls with a non-string or oversize value (ineligible_value) add up to the
// population exactly; a document where they do not is refused.
function metadataGroupsOf(value, items, population, dimension, reason, { truncated, matched, onlyDimension }) {
  const key = dimension.slice(METADATA_DIMENSION.length);
  const bucket = (entry, withGroups = false) => {
    if (!isObject(entry) || !isCount(entry.calls) || !isAmount(entry.cost_usd) || (withGroups && !isCount(entry.groups))) {
      throw new Invalid("verification_failed", reason);
    }
    return withGroups
      ? { groups: entry.groups, calls: entry.calls, cost_usd: entry.cost_usd }
      : { calls: entry.calls, cost_usd: entry.cost_usd };
  };
  if (!isObject(value) || value.key !== key || !isObject(value.unlisted)) {
    throw new Invalid("verification_failed", reason);
  }
  const unlisted = {
    other_values: bucket(value.unlisted.other_values, true),
    missing_key: bucket(value.unlisted.missing_key),
    ineligible_value: bucket(value.unlisted.ineligible_value),
  };
  // The service's eight-decimal precision, so a tiny cost never reads as zero.
  const round = (amount) => Math.round(amount * 1e8) / 1e8;
  const valued = items.filter((item) => item.has_value);
  const listed = {
    calls: valued.reduce((sum, item) => sum + item.calls, 0),
    cost_usd: round(valued.reduce((sum, item) => sum + item.cost_usd, 0)),
  };
  const bucketCost =
    unlisted.other_values.cost_usd + unlisted.missing_key.cost_usd + unlisted.ineligible_value.cost_usd;
  if (
    listed.calls + unlisted.other_values.calls + unlisted.missing_key.calls + unlisted.ineligible_value.calls !==
      population.calls ||
    Math.abs(listed.cost_usd + bucketCost - population.cost_usd) > costTolerance(items.length + 3)
  ) {
    throw new Invalid("verification_failed", reason);
  }
  // Every group has calls, so unlisted values and unlisted calls come
  // together; none exist when nothing was cut, and never more than the
  // matched groups that were not returned.
  const other = unlisted.other_values;
  if (
    (other.groups === 0) !== (other.calls === 0) ||
    (other.calls === 0 && other.cost_usd !== 0) ||
    (!truncated && other.groups !== 0) ||
    (matched !== null && other.groups > matched - items.length)
  ) {
    throw new Invalid("verification_failed", reason);
  }
  // The listed no-value rows are those buckets' calls: all of them when
  // nothing was cut or the key is the only dimension, never more otherwise.
  const noValue = items.filter((item) => !item.has_value);
  const noValueCalls = noValue.reduce((sum, item) => sum + item.calls, 0);
  const noValueCost = noValue.reduce((sum, item) => sum + item.cost_usd, 0);
  const bucketCalls = unlisted.missing_key.calls + unlisted.ineligible_value.calls;
  const bucketNoValueCost = unlisted.missing_key.cost_usd + unlisted.ineligible_value.cost_usd;
  const whole = !truncated || (onlyDimension && noValue.length > 0);
  if (
    whole
      ? noValueCalls !== bucketCalls || Math.abs(noValueCost - bucketNoValueCost) > costTolerance(noValue.length + 2)
      : noValueCalls > bucketCalls || noValueCost - bucketNoValueCost > costTolerance(noValue.length + 2)
  ) {
    throw new Invalid("verification_failed", reason);
  }
  const unattributed = {
    calls: unlisted.missing_key.calls + unlisted.ineligible_value.calls,
    cost_usd: round(unlisted.missing_key.cost_usd + unlisted.ineligible_value.cost_usd),
  };
  return {
    key,
    listed_with_value: listed,
    unlisted,
    // Spend that no value of the key accounts for.
    unattributed,
  };
}

export function usageAggregatesReport(body, ctx, request, notices) {
  return run(() => {
    const reason = "usage_response_invalid";
    const origin = provenance(body, ctx, reason);
    contentExcluded(body);
    const span = usageWindow(body.window, request, reason);
    if (
      !Array.isArray(body.group_by) ||
      body.group_by.length !== request.groupBy.length ||
      body.group_by.some((dimension, index) => dimension !== request.groupBy[index])
    ) {
      throw new Invalid("verification_failed", "group_by_mismatch");
    }
    const proof = evidence(body.evidence, reason);
    const codes = warnings(body.warnings, notices, reason);
    checkMetadataEcho(body, request);
    // Grouped usage always carries coverage; without it the groups cannot be
    // shown to be complete or filtered as asked.
    if (body.coverage === undefined || body.coverage === null) {
      throw new Invalid("unsupported", "coverage_not_reported");
    }
    if (!isObject(body.coverage)) throw new Invalid("verification_failed", reason);
    const readEnvironments = checkUsageFilters(body.coverage, request, notices);
    const coverage = coverageOf(body.coverage, notices, reason);
    if (
      coverage.rows.shape !== "top_n" ||
      coverage.totals_scope !== "population" ||
      coverage.rows.limit !== request.limit ||
      // A top-N read has no pages.
      coverage.next_cursor !== null
    ) {
      throw new Invalid("verification_failed", reason);
    }
    // Coverage must describe the window validated above: the same requested
    // window, and an effective window inside it that ends at the same time
    // (only metadata retention may clip its start, and it names that).
    const requested = coverage.requested_window;
    const effective = coverage.effective_window;
    if (
      requested === null ||
      effective === null ||
      Date.parse(requested.since) !== Date.parse(span.since) ||
      Date.parse(requested.until) !== Date.parse(span.until) ||
      Date.parse(effective.until) !== Date.parse(span.until) ||
      Date.parse(effective.since) < Date.parse(span.since) ||
      Date.parse(effective.since) > Date.parse(effective.until) ||
      (Date.parse(effective.since) !== Date.parse(span.since) && !coverage.reasons.includes("retention_clipped"))
    ) {
      throw new Invalid("verification_failed", "window_mismatch");
    }
    if (!Array.isArray(body.items) || body.items.length > request.limit) {
      throw new Invalid("verification_failed", reason);
    }
    const seen = new Set();
    const metadataDimension = request.groupBy.find((dimension) => dimension.startsWith(METADATA_DIMENSION)) ?? null;
    const items = body.items.map((raw) => {
      const row = rowObject(raw, reason);
      const group = {};
      for (const dimension of USAGE_GROUP_DIMENSIONS) {
        const wanted = request.groupBy.includes(dimension);
        if (!wanted) {
          if (row[dimension] !== undefined) throw new Invalid("verification_failed", reason);
          continue;
        }
        if (dimension === "day") {
          // A UTC day the verified window does not cover is refused.
          if (!isDate(row.day) || row.day < span.since_day || row.day > span.last_day) {
            throw new Invalid("verification_failed", reason);
          }
          group.day = row.day;
        } else {
          group[dimension] = displayText(row[dimension], notices, reason);
        }
      }
      for (const name of Object.keys(row)) {
        if (name.startsWith(METADATA_DIMENSION) && name !== metadataDimension) {
          throw new Invalid("verification_failed", reason);
        }
      }
      if (metadataDimension !== null) {
        // null: calls without the key, or with a non-string or oversize value.
        const value = row[metadataDimension];
        if (value !== null && typeof value !== "string") throw new Invalid("verification_failed", reason);
        group.metadata_key = metadataDimension.slice(METADATA_DIMENSION.length);
        group.metadata_value = value === null ? null : metadataText(value, notices, reason);
        group.has_value = value !== null;
      }
      const key = JSON.stringify(request.groupBy.map((dimension) => raw[dimension]));
      if (seen.has(key)) throw new Invalid("verification_failed", reason);
      seen.add(key);
      const metrics = usageMetrics(row, reason);
      const item = {
        ...group,
        ...metrics,
        pricing: pricingOf(row.pricing, notices, reason, { note: false, calls: metrics.calls }),
      };
      if (group.day !== undefined) item.partial_day = span.partial_days.includes(group.day);
      Object.defineProperty(item, GROUP_KEY, { value: key, enumerable: true });
      return item;
    });
    const totals = body.totals;
    if (!isObject(totals) || totals.scope !== "population") throw new Invalid("verification_failed", reason);
    const population = { scope: "population", ...usageMetrics(totals, reason) };
    let dashboard = null;
    if (body.completeness !== undefined && body.completeness !== null) {
      const value = body.completeness;
      if (!isObject(value) || typeof value.complete !== "boolean" || !isCount(value.returned) || !isCount(value.limit)) {
        throw new Invalid("verification_failed", reason);
      }
      // The dashboard summary must agree with the request and the rows.
      if (value.mode !== "top_n" || value.returned !== body.items.length || value.limit !== request.limit) {
        throw new Invalid("verification_failed", reason);
      }
      dashboard = { mode: "top_n", complete: value.complete, returned: value.returned, limit: value.limit };
    }
    const matched = coverage.rows.matched;
    const truncated =
      coverage.rows.truncated === true || (matched !== null && matched > items.length) || dashboard?.complete === false;
    // The groups partition the matching calls: rows the service says are all
    // of them must add up to the population totals, and a count that says
    // otherwise is refused.
    const listedCalls = items.reduce((sum, item) => sum + item.calls, 0);
    if (
      coverage.rows.returned !== items.length ||
      (matched !== null && matched < items.length) ||
      // A top-N read has no cursor, so it fills the limit when more matched.
      (matched !== null && items.length !== Math.min(request.limit, matched)) ||
      (coverage.rows.truncated === false && matched !== null && matched !== items.length) ||
      // The truncation flag must say exactly whether matched groups were left out.
      (matched !== null && coverage.rows.truncated !== null && coverage.rows.truncated !== (matched > items.length)) ||
      // Evidence describes the returned rows.
      proof.rows !== items.length ||
      listedCalls > population.calls ||
      (!truncated && listedCalls !== population.calls) ||
      // The dashboard summary's completeness must match the coverage rows.
      (dashboard !== null && matched !== null && dashboard.complete !== (matched === items.length)) ||
      // Every group has calls, and calls in the population mean listed groups.
      items.some((item) => item.calls === 0) ||
      (population.calls > 0 && items.length === 0)
    ) {
      throw new Invalid("verification_failed", reason);
    }
    // Every group set must reconcile with the population: an untruncated one
    // exactly (counts) or within rounding (cost), a truncated one never above it.
    const sumOf = (field) =>
      items.reduce((sum, item) => sum + (field === "latency_samples_" ? item.latency.samples : item[field]), 0);
    for (const field of ["error_calls", ...TOKEN_COUNTS]) {
      if (truncated ? sumOf(field) > population[field] : sumOf(field) !== population[field]) {
        throw new Invalid("verification_failed", reason);
      }
    }
    // Calls all priced at zero cost nothing.
    const allZero = (pricing, cost) =>
      pricing &&
      pricing.priced_calls > 0 &&
      pricing.priced_calls === pricing.zero_cost_calls &&
      pricing.partial_calls + pricing.unpriced_calls + pricing.unknown_calls === 0 &&
      cost !== 0;
    if (allZero(body.pricing, population.cost_usd) || items.some((item) => allZero(item.pricing, item.cost_usd))) {
      throw new Invalid("verification_failed", reason);
    }
    // Latency samples and pricing classes add up the same way.
    const pairs = [[sumOf("latency_samples_"), population.latency.samples]];
    const groupPricing = body.pricing;
    for (const key of PRICING_COUNTS) {
      if (isObject(groupPricing) && items.every((item) => item.pricing)) {
        pairs.push([items.reduce((sum, item) => sum + item.pricing[key], 0), groupPricing[key]]);
      }
    }
    for (const [listed, whole] of pairs) {
      if (!isCount(whole) || (truncated ? listed > whole : listed !== whole)) {
        throw new Invalid("verification_failed", reason);
      }
    }
    const costGap = sumOf("cost_usd") - population.cost_usd;
    if (costGap > costTolerance(items.length + 1) || (!truncated && -costGap > costTolerance(items.length + 1))) {
      throw new Invalid("verification_failed", reason);
    }
    // The groups must come in the service's stated cost order; a cut list is
    // only the highest-cost groups when that is the order.
    // Cost descending, then calls descending for equal cost. The final key
    // (group key ascending) follows the service's collation, which the CLI
    // does not reproduce.
    const costOrdered = items.every((item, index) => {
      if (index === 0) return true;
      const before = items[index - 1];
      return before.cost_usd > item.cost_usd || (before.cost_usd === item.cost_usd && before.calls >= item.calls);
    });
    if (!costOrdered || coverage.rows.ordering !== AGGREGATE_ORDERING) {
      throw new Invalid("verification_failed", reason);
    }
    if (truncated) notices.add("groups_truncated");
    if (!proof.complete) notices.add("evidence_incomplete");
    if (span.until_is_request_time && span.partial_days.length > 0) notices.add("current_day_partial");
    if (coverage.reasons.some((code) => METADATA_REASONS.has(code))) notices.add("metadata_values_missing");
    if (codes.some((entry) => entry.code === "metadata_key_mostly_missing")) notices.add("metadata_key_mostly_missing");
    const metadataGroups = metadataDimension === null ? null : metadataGroupsOf(body.metadata_groups, items, population, metadataDimension, reason, {
          truncated, matched, onlyDimension: request.groupBy.length === 1,
        });
    // Grouped usage is attributed per call; anything else is not the promised split.
    const groupedAttribution = attributionOf(body.attribution, reason, "call");
    if (
      groupedAttribution === null ||
      groupedAttribution.cost_basis !== "call" ||
      groupedAttribution.per_provider_exact !== true
    ) {
      throw new Invalid("verification_failed", reason);
    }
    const complete = proof.complete && !truncated && coverage.completeness === "complete";
    const result = {
      provenance: origin,
      source: "usage_aggregates",
      window: span,
      evidence: proof,
      warnings: codes,
      content_included: false,
      group_by: [...request.groupBy],
      filters: {
        route: request.filters.route?.length ?? 0,
        provider: request.filters.provider?.length ?? 0,
        model: request.filters.model?.length ?? 0,
        environment: request.filters.environment?.length ?? 0,
        metadata: metadataSupplied(request),
      },
      truncated,
      complete,
      empty: population.calls === 0,
      rows: items.length,
      matched_groups: matched,
      items,
      totals: population,
      metadata_groups: metadataGroups,
      coverage,
      completeness: dashboard,
      pricing: pricingOf(body.pricing, notices, reason, { calls: population.calls }),
      attribution: groupedAttribution,
    };
    // Not printed (symbol keys are not serialized); compared by --compare.
    result[READ_ENVIRONMENTS] = readEnvironments;
    return result;
  });
}

// Combines the validated reports of consecutive trace pages (as returned by
// tracesReport) into one coverage verdict for a local aggregation. It is
// complete only when the last page has no cursor and no page, read or not,
// carries any other reason the service gave for being incomplete. Running
// out of cursors alone never proves completeness.
export function combinePages(pages) {
  if (!Array.isArray(pages) || pages.length === 0) {
    return { complete: false, completeness: "unknown", reasons: ["evidence_missing"], pages: 0, next_cursor: null };
  }
  const reasons = new Set();
  let completeness = "complete";
  const worse = (value) => {
    if (value === "partial" || (value === "unknown" && completeness === "complete")) completeness = value;
  };
  pages.forEach((page, index) => {
    const last = index === pages.length - 1;
    if (!last && page.next_cursor === null) {
      // A page without a cursor followed by more pages is not a sequence.
      reasons.add("evidence_missing");
      worse("unknown");
    }
    if (page.coverage === null || page.coverage === undefined) {
      if (!page.evidence.complete && !(page.truncated && !last)) {
        reasons.add("evidence_missing");
        worse("unknown");
      }
      return;
    }
    // A cursor that was followed is not an unread page.
    const own = page.coverage.reasons.filter((reason) => last || reason !== "page_unread");
    for (const reason of own) reasons.add(reason);
    worse(completenessOf("complete", own));
  });
  const final = pages[pages.length - 1];
  if (final.next_cursor !== null) {
    reasons.add("page_unread");
    worse("partial");
  }
  return {
    complete: completeness === "complete",
    completeness,
    reasons: [...reasons].sort(),
    pages: pages.length,
    next_cursor: final.next_cursor,
  };
}

// GET /v1/agent/workspace, already checked by checkWorkspace during the
// session. Returns the approved workspace fields only.
export function workspaceContext(body, ctx, notices) {
  return run(() => {
    const reason = "workspace_response_invalid";
    const origin = provenance(body, ctx, reason);
    const workspace = body.workspace;
    if (!isObject(workspace) || normalizeUuid(workspace.id) !== ctx.workspaceId || !isTimestamp(workspace.created_at)) {
      throw new Invalid("verification_failed", reason);
    }
    if (!isObject(body.retention) || !isCount(body.retention.metadata_days)) {
      throw new Invalid("verification_failed", reason);
    }
    if (!isObject(body.content) || typeof body.content.captured !== "boolean" || body.content.included !== false) {
      throw new Invalid("verification_failed", "content_access_granted");
    }
    const scopes = body.access?.scopes;
    if (!Array.isArray(scopes) || scopes.length !== 1 || scopes[0] !== METADATA_SCOPE) {
      throw new Invalid("verification_failed", "scope_mismatch");
    }
    return {
      provenance: origin,
      workspace: {
        id: ctx.workspaceId,
        slug: displayText(workspace.slug, notices, reason),
        name: displayText(workspace.name, notices, reason),
        created_at: workspace.created_at,
      },
      retention: { metadata_days: body.retention.metadata_days },
      content: { captured: body.content.captured, included: false },
      access: { scopes: [METADATA_SCOPE] },
    };
  });
}

function capabilityEntry(entry, reason) {
  if (
    !isObject(entry) ||
    typeof entry.available !== "boolean" ||
    typeof entry.content !== "boolean" ||
    typeof entry.mutates !== "boolean" ||
    typeof entry.external_calls !== "boolean" ||
    !PRIVACY_CLASSES.includes(entry.privacy_class) ||
    !SCOPES.includes(entry.required_scope) ||
    !isToken(entry.schema)
  ) {
    throw new Invalid("verification_failed", reason);
  }
  const metadataOnly =
    entry.content === false &&
    entry.mutates === false &&
    entry.external_calls === false &&
    entry.privacy_class === "metadata" &&
    entry.required_scope === METADATA_SCOPE;
  // checkCapabilities already refuses this; it is checked again here so a
  // summary can never show a sensitive capability as available.
  if (!metadataOnly && entry.available) throw new Invalid("verification_failed", "content_access_granted");
  return {
    available: entry.available,
    content: entry.content,
    mutates: entry.mutates,
    external_calls: entry.external_calls,
    privacy_class: entry.privacy_class,
    required_scope: entry.required_scope,
    schema: entry.schema,
  };
}

// GET /v1/agent/capabilities, already checked by checkCapabilities during the
// session. Known capabilities are returned by name; absent ones are null.
// Unknown capability names and privacy class descriptions are not returned.
export function capabilitySummary(body, ctx, notices) {
  return run(() => {
    const reason = "capabilities_response_invalid";
    const origin = provenance(body, ctx, reason);
    if (body.deployment_profile !== ctx.profile) throw new Invalid("verification_failed", "profile_mismatch");
    const deployment = body.deployment_capabilities;
    if (!Array.isArray(deployment) || deployment.length > MAX_LIST || !deployment.every(isToken)) {
      throw new Invalid("verification_failed", reason);
    }
    if (!isObject(body.agent)) throw new Invalid("verification_failed", reason);
    const agent = {};
    for (const name of CAPABILITY_NAMES) {
      agent[name] = Object.hasOwn(body.agent, name) ? capabilityEntry(body.agent[name], reason) : null;
    }
    if (Object.keys(body.agent).some((name) => !CAPABILITY_NAMES.includes(name))) {
      notices.add("unrecognized_capabilities_ignored");
    }
    const bounds = body.bounds;
    if (
      !isObject(bounds) ||
      !isCount(bounds.max_days) ||
      !isCount(bounds.max_rows) ||
      !isCount(bounds.max_response_bytes) ||
      bounds.content_included_by_default !== false
    ) {
      throw new Invalid("verification_failed", reason);
    }
    let contracts = null;
    if (body.contracts !== undefined && body.contracts !== null) {
      const value = body.contracts;
      if (!isObject(value)) throw new Invalid("verification_failed", reason);
      contracts = {};
      for (const key of ["agent_access", "trace_debug"]) {
        if (value[key] === undefined || value[key] === null) contracts[key] = null;
        else if (isToken(value[key])) contracts[key] = value[key];
        else throw new Invalid("verification_failed", reason);
      }
    }
    if (body.privacy_classes !== undefined) notices.add("privacy_class_details_omitted");
    return {
      provenance: origin,
      deployment_profile: ctx.profile,
      deployment_capabilities: [...deployment],
      agent,
      contracts,
      bounds: {
        max_days: bounds.max_days,
        max_rows: bounds.max_rows,
        max_response_bytes: bounds.max_response_bytes,
        content_included_by_default: false,
      },
    };
  });
}

// GET /v1/agent/usage?days=N&limit=N. The window is relative days only.
export function usageReport(body, ctx, request, notices) {
  return run(() => {
    const reason = "usage_response_invalid";
    const origin = provenance(body, ctx, reason);
    contentExcluded(body);
    const span = window(body.window, request.days, reason);
    const proof = evidence(body.evidence, reason);
    const codes = warnings(body.warnings, notices, reason);
    if (!Array.isArray(body.items) || body.items.length > request.limit) {
      throw new Invalid("verification_failed", reason);
    }
    checkMetadataEcho(body, request);
    const metadataFilters = metadataSupplied(request);
    if (body.days !== request.days || typeof body.truncated !== "boolean") {
      throw new Invalid("verification_failed", reason);
    }
    if (body.group_by !== undefined && body.group_by !== null) {
      throw new Invalid("verification_failed", reason);
    }
    const items = body.items.map((raw) => {
      const row = rowObject(raw, reason);
      const nullableCount = (value) => value === null || isCount(value);
      if (
        !isDate(row.date) ||
        !isCount(row.calls) ||
        !isAmount(row.cost_usd) ||
        !isCount(row.input_tokens) ||
        !isCount(row.output_tokens) ||
        !nullableCount(row.avg_latency_ms) ||
        !nullableCount(row.p95_latency_ms) ||
        !isCount(row.error_calls) ||
        row.error_calls > row.calls
      ) {
        throw new Invalid("verification_failed", reason);
      }
      return {
        date: row.date,
        route: displayText(row.route, notices, reason, { nullable: true }),
        calls: row.calls,
        error_calls: row.error_calls,
        cost_usd: row.cost_usd,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        avg_latency_ms: row.avg_latency_ms,
        p95_latency_ms: row.p95_latency_ms,
        pricing: pricingOf(row.pricing, notices, reason, { note: false, calls: row.calls }),
      };
    });
    const coverage = coverageOf(body.coverage, notices, reason);
    checkCoverage(coverage, {
      shape: "top_n", totalsScope: "population", limit: request.limit, returned: items.length,
      truncated: body.truncated, nextCursor: null, days: request.days,
    }, reason);
    const population = populationTotalsOf(body.totals, reason);
    const complete = proof.complete && !body.truncated && (coverage === null || coverage.completeness === "complete");
    if (!proof.complete) notices.add("evidence_incomplete");
    if (body.truncated) notices.add("rows_truncated");
    return {
      provenance: origin,
      // The route-by-day read's window is the last days x 24 hours, ending
      // now: it is not aligned to UTC days, so its first and last dates are
      // partial. Grouped usage windows are labelled "utc_days" or "explicit".
      window: { ...span, kind: "rolling", timezone: "UTC", hours: span.days * 24, aligned_to_utc_days: false },
      evidence: proof,
      warnings: codes,
      content_included: false,
      group_by: null,
      filters: { metadata: metadataFilters },
      truncated: body.truncated,
      complete,
      empty: items.length === 0,
      rows: items.length,
      items,
      totals: totalsOf(items, complete),
      coverage,
      population_totals: population,
      pricing: pricingOf(body.pricing, notices, reason, { calls: population === null ? null : population.calls }),
      attribution: attributionOf(body.attribution, reason, "call"),
    };
  });
}

// Filter values are not printed back, like any other free-text argument;
// only the keys and how many were applied.
function metadataSupplied(request) {
  const filters = request.metadata ?? [];
  return { count: filters.length, keys: filters.map((filter) => filter.key) };
}

// Sums over the returned rows only. complete says whether those rows are the
// whole window; when it is false these are not workspace totals.
function totalsOf(items, complete) {
  const totals = {
    scope: "returned_rows",
    complete,
    calls: 0,
    error_calls: 0,
    cost_usd: 0,
    input_tokens: 0,
    output_tokens: 0,
  };
  for (const item of items) {
    totals.calls += item.calls;
    totals.error_calls += item.error_calls;
    totals.cost_usd += item.cost_usd;
    totals.input_tokens += item.input_tokens;
    totals.output_tokens += item.output_tokens;
  }
  totals.cost_usd = Math.round(totals.cost_usd * 1e6) / 1e6;
  return totals;
}

// GET /v1/agent/routes. The endpoint takes no limit or window, so every row
// in the bounded response is validated and the first request.limit are kept.
// Descriptions, constraints and evaluation contracts are never returned.
export function routesReport(body, ctx, request, notices) {
  return run(() => {
    const reason = "routes_response_invalid";
    const origin = provenance(body, ctx, reason);
    if (body.content_included !== undefined) contentExcluded(body);
    if (!Array.isArray(body.routes) || body.routes.length > MAX_ROUTE_ROWS) {
      throw new Invalid("verification_failed", reason);
    }
    const rows = body.routes.map((raw) => {
      const row = rowObject(raw, reason);
      const version = row.evaluation_contract_version;
      const hash = row.evaluation_contract_hash;
      const nullish = (value) => value === null || value === undefined;
      if (
        !(nullish(version) || isCount(version) || isToken(version)) ||
        !(nullish(hash) || (typeof hash === "string" && HASH.test(hash))) ||
        !(nullish(row.updated_at) || isTimestamp(row.updated_at)) ||
        !(nullish(row.description) || typeof row.description === "string") ||
        !(nullish(row.constraints) || isObject(row.constraints)) ||
        !isCount(row.calls) ||
        !isCount(row.replay_eligible_calls)
      ) {
        throw new Invalid("verification_failed", reason);
      }
      return {
        route: displayText(row.route, notices, reason),
        updated_at: row.updated_at ?? null,
        calls: row.calls,
        replay_eligible_calls: row.replay_eligible_calls,
        has_description: typeof row.description === "string" && row.description.length > 0,
        has_evaluation_contract: !nullish(row.evaluation_contract),
        evaluation_contract_version: nullish(version) ? null : version,
        evaluation_contract_hash: nullish(hash) ? null : hash,
      };
    });
    notices.add("route_details_omitted");
    const truncated = rows.length > request.limit;
    if (truncated) notices.add("routes_truncated_locally");
    return {
      provenance: origin,
      content_included: false,
      server_rows: rows.length,
      rows: Math.min(rows.length, request.limit),
      truncated,
      truncation: truncated ? "local" : null,
      empty: rows.length === 0,
      omitted_fields: ["description", "constraints", "evaluation_contract"],
      routes: rows.slice(0, request.limit),
    };
  });
}

// GET /v1/agent/traces. One page only. The cursor is opaque and returned for
// the caller to pass back; the CLI never follows it on its own.
export function tracesReport(body, ctx, request, notices) {
  return run(() => {
    const reason = "traces_response_invalid";
    const origin = provenance(body, ctx, reason);
    contentExcluded(body);
    const span = window(body.window, request.days, reason);
    const proof = evidence(body.evidence, reason);
    const codes = warnings(body.warnings, notices, reason);
    const page = body.page;
    const cursorOk = (value) => value === null || isCursor(value);
    if (
      !isObject(page) ||
      page.limit !== request.limit ||
      typeof page.truncated !== "boolean" ||
      !cursorOk(page.next_cursor) ||
      body.truncated !== page.truncated ||
      body.next_cursor !== page.next_cursor
    ) {
      throw new Invalid("verification_failed", reason);
    }
    if (!Array.isArray(body.traces) || body.traces.length > request.limit) {
      throw new Invalid("verification_failed", reason);
    }
    const rawRows = body.traces.map((raw) => rowObject(raw, reason));
    checkFilters(body, rawRows, request);
    checkMetadataEcho(body, request);
    const traces = rawRows.map((row) => {
      const nullableAmount = (value) => value === null || isAmount(value);
      if (
        typeof row.id !== "string" ||
        !IDENT.test(row.id) ||
        typeof row.trace_id !== "string" ||
        !IDENT.test(row.trace_id) ||
        !isTimestamp(row.started_at) ||
        !isTimestamp(row.last_span_at) ||
        !isCount(row.span_count) ||
        !isCount(row.input_tokens) ||
        !isCount(row.output_tokens) ||
        !isCount(row.cache_read_tokens) ||
        !isCount(row.cache_write_tokens) ||
        !nullableAmount(row.cost_usd) ||
        (row.status !== "success" && row.status !== "error") ||
        !(row.mixed_providers === undefined || typeof row.mixed_providers === "boolean") ||
        !(row.mixed_models === undefined || typeof row.mixed_models === "boolean")
      ) {
        throw new Invalid("verification_failed", reason);
      }
      const link = traceLink(row.metergraph_links?.trace ?? null, ctx.origin, row, ctx.workspaceId);
      if (!link.ok) throw new Invalid(link.outcome, link.reason);
      return {
        id: row.id,
        trace_id: row.trace_id,
        trace_name: displayText(row.trace_name, notices, reason, { nullable: true }),
        status: row.status,
        started_at: row.started_at,
        last_span_at: row.last_span_at,
        span_count: row.span_count,
        input_tokens: row.input_tokens,
        output_tokens: row.output_tokens,
        cache_read_tokens: row.cache_read_tokens,
        cache_write_tokens: row.cache_write_tokens,
        cost_usd: row.cost_usd,
        routes: nameList(row.routes, notices, reason),
        providers: nameList(row.providers, notices, reason),
        models: nameList(row.models, notices, reason),
        // Derived from the row's own provider and model lists as well, so an
        // older service that does not flag them still shows a mixed trace.
        mixed_providers: row.mixed_providers === true || (Array.isArray(row.providers) && row.providers.length > 1),
        mixed_models: row.mixed_models === true || (Array.isArray(row.models) && row.models.length > 1),
        pricing: pricingOf(row.pricing, notices, reason, { note: false, calls: row.span_count }),
        link: link.value,
        link_workspace_bound: link.workspaceBound === true,
      };
    });
    if (!proof.complete) notices.add("evidence_incomplete");
    if (page.truncated) notices.add("more_pages");
    const coverage = coverageOf(body.coverage, notices, reason);
    checkCoverage(coverage, {
      shape: "page", totalsScope: "page", limit: page.limit, returned: traces.length,
      truncated: page.truncated, nextCursor: page.next_cursor, days: request.days,
    }, reason);
    const pagePricing = pricingOf(body.pricing, notices, reason, {
      calls: traces.reduce((sum, trace) => sum + trace.span_count, 0),
    });
    if (traces.some((trace) => trace.mixed_providers)) notices.add("mixed_provider_traces");
    if (traces.some((trace) => trace.cost_usd === null)) notices.add("unpriced_traces");
    const missingLinks = traces.length === 0 || traces.some((trace) => trace.link === null);
    if (missingLinks) notices.add("trace_links_unavailable");
    const unboundLinks = traces.some((trace) => trace.link !== null && !trace.link_workspace_bound);
    if (unboundLinks) notices.add("trace_workspace_binding_unavailable");
    return {
      provenance: origin,
      window: span,
      evidence: proof,
      warnings: codes,
      content_included: false,
      // Free-text argument values are not printed back, like any other
      // argument; only whether they were given.
      filters: {
        route_supplied: request.route !== null,
        status: request.status,
        cursor_supplied: request.cursor !== null,
        metadata: metadataSupplied(request),
      },
      page: { limit: page.limit, rows: traces.length, truncated: page.truncated, next_cursor: page.next_cursor },
      truncated: page.truncated,
      next_cursor: page.next_cursor,
      complete: proof.complete && !page.truncated && (coverage === null || coverage.completeness === "complete"),
      coverage,
      pricing: pagePricing,
      // null when the service does not report it, like coverage and
      // pricing. Each trace's mixed_providers flag and cost stay whole-trace
      // facts either way.
      attribution: attributionOf(body.attribution, reason, "trace"),
      empty: traces.length === 0,
      link_status: missingLinks ? "server_link_unavailable" :
        unboundLinks ? "workspace_binding_unavailable" : "available",
      traces,
    };
  });
}

// A filter the service echoes must be exactly the one requested. Without an
// echo, route and status are checked against the rows. The CLI never sends a
// workload filter (the rows cannot show whether one applied), so an echoed
// workload must be absent or null.
function checkFilters(body, rows, request) {
  const requested = { route: request.route, status: request.status, workload: null };
  if (body.filters !== undefined && body.filters !== null) {
    if (!isObject(body.filters)) throw new Invalid("verification_failed", "traces_response_invalid");
    for (const [key, value] of Object.entries(requested)) {
      const echoed = body.filters[key] === undefined ? null : body.filters[key];
      if (echoed !== value) throw new Invalid("verification_failed", "filter_mismatch");
    }
    return;
  }
  for (const row of rows) {
    if (requested.status !== null && row.status !== requested.status) {
      throw new Invalid("verification_failed", "filter_not_applied");
    }
    if (requested.route !== null && !(Array.isArray(row.routes) && row.routes.includes(requested.route))) {
      throw new Invalid("verification_failed", "filter_not_applied");
    }
  }
}
