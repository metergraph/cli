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
const isTimestamp = (value) =>
  typeof value === "string" && value.length <= 40 && TIMESTAMP.test(value) && Number.isFinite(Date.parse(value));
const isDate = (value) =>
  typeof value === "string" && DATE.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`));

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
export function readQuery(options) {
  if (options.command === "routes") return null;
  const query = new URLSearchParams();
  query.set("days", String(options.days));
  query.set("limit", String(options.limit));
  if (options.command === "usage" && options.groupByMetadata) {
    query.set("group_by", `metadata.${options.groupByMetadata}`);
  }
  if (options.metadata) query.set("metadata", metadataQueryValue(options.metadata));
  if (options.command === "traces") {
    if (options.route !== null) query.set("route", options.route);
    if (options.status !== null) query.set("status", options.status);
    if (options.cursor !== null) query.set("cursor", options.cursor);
  }
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
const FILTER_KEYS = ["route", "status", "workload", "trace_id", "request_id", "environments"];

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

const PRICING_COUNTS = ["priced_calls", "zero_cost_calls", "partial_calls", "unpriced_calls", "unknown_calls"];

function pricingOf(value, notices, reason, { note = true } = {}) {
  if (value === undefined || value === null) return null;
  if (
    !isObject(value) ||
    !PRICING_COUNTS.every((key) => isCount(value[key])) ||
    value.zero_cost_calls > value.priced_calls ||
    (value.cost !== "exact" && value.cost !== "lower_bound")
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

function attributionOf(value, reason) {
  if (value === undefined || value === null) return null;
  const nullableCount = (entry) => entry === null || isCount(entry);
  if (
    !isObject(value) ||
    (value.level !== "call" && value.level !== "trace") ||
    (value.cost_basis !== "call" && value.cost_basis !== "trace_total") ||
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
    if (request.groupByMetadata) {
      // GET /v1/agent/usage/aggregates with group_by=metadata.KEY.
      return groupedUsage(body, request, notices, { origin, span, proof, codes, metadataFilters });
    }
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
        pricing: pricingOf(row.pricing, notices, reason, { note: false }),
      };
    });
    const coverage = coverageOf(body.coverage, notices, reason);
    const complete = proof.complete && !body.truncated && (coverage === null || coverage.completeness === "complete");
    if (!proof.complete) notices.add("evidence_incomplete");
    if (body.truncated) notices.add("rows_truncated");
    return {
      provenance: origin,
      window: span,
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
      population_totals: populationTotalsOf(body.totals, reason),
      pricing: pricingOf(body.pricing, notices, reason),
      attribution: attributionOf(body.attribution, reason),
    };
  });
}

// Filter values are not printed back, like any other free-text argument;
// only the keys and how many were applied.
function metadataSupplied(request) {
  const filters = request.metadata ?? [];
  return { count: filters.length, keys: filters.map((filter) => filter.key) };
}

// The listed groups cannot exceed the population totals on any metric, and
// when nothing was cut they must equal them. Cost is compared with a small
// tolerance for per-group rounding.
const COST_TOLERANCE_USD = 1e-6;
function groupsMatchTotals(items, population, truncated) {
  for (const field of ["calls", "error_calls", "input_tokens", "output_tokens", "cost_usd"]) {
    const listed = items.reduce((total, item) => total + item[field], 0);
    const slack = field === "cost_usd" ? COST_TOLERANCE_USD * Math.max(1, items.length) : 0;
    if (listed > population[field] + slack) return false;
    if (!truncated && Math.abs(listed - population[field]) > slack) return false;
  }
  return true;
}

// Usage grouped by one metadata key, from the usage aggregates read. Calls
// without an eligible value for the key are the group whose value is null,
// so the groups add up to the population totals. Truncation is trusted only
// through the shared coverage evidence.
function groupedUsage(body, request, notices, { origin, span, proof, codes, metadataFilters }) {
  const reason = "usage_response_invalid";
  const key = request.groupByMetadata;
  const dimension = `metadata.${key}`;
  if (!Array.isArray(body.group_by) || body.group_by.length !== 1 || body.group_by[0] !== dimension) {
    throw new Invalid("verification_failed", "group_by_mismatch");
  }
  const coverage = coverageOf(body.coverage, notices, reason);
  if (coverage === null) throw new Invalid("unsupported", "group_by_mismatch");
  const population = populationTotalsOf(body.totals, reason);
  if (population === null) throw new Invalid("verification_failed", reason);
  const seen = new Set();
  const items = body.items.map((raw) => {
    const row = rowObject(raw, reason);
    const value = row[dimension];
    const latency = row.latency;
    const nullableCount = (entry) => entry === null || isCount(entry);
    const valueKey = value === null ? "\u0000null" : value;
    if (
      !(value === null || typeof value === "string") ||
      seen.has(valueKey) ||
      !isCount(row.calls) ||
      !isAmount(row.cost_usd) ||
      !isCount(row.input_tokens) ||
      !isCount(row.output_tokens) ||
      !isCount(row.error_calls) ||
      row.error_calls > row.calls ||
      !isObject(latency) ||
      !nullableCount(latency.avg_ms) ||
      !nullableCount(latency.p95_ms)
    ) {
      throw new Invalid("verification_failed", reason);
    }
    seen.add(valueKey);
    return {
      metadata_key: key,
      // null: calls without the key or with a non-string or oversize value.
      metadata_value: value === null ? null : metadataText(value, notices, reason),
      has_value: value !== null,
      calls: row.calls,
      error_calls: row.error_calls,
      cost_usd: row.cost_usd,
      input_tokens: row.input_tokens,
      output_tokens: row.output_tokens,
      avg_latency_ms: latency.avg_ms,
      p95_latency_ms: latency.p95_ms,
      pricing: pricingOf(row.pricing, notices, reason, { note: false }),
    };
  });
  const rows = coverage.rows;
  const truncated = rows.truncated === true;
  if (
    rows.shape !== "top_n" ||
    // Rows must be the promised order: highest cost first.
    typeof rows.ordering !== "string" ||
    !rows.ordering.startsWith("cost_usd desc") ||
    items.some((item, index) => index > 0 && item.cost_usd > items[index - 1].cost_usd) ||
    rows.returned !== items.length ||
    rows.limit !== request.limit ||
    rows.matched === null ||
    // A top-N read has no cursor, so it must fill the limit when more matched.
    items.length !== Math.min(rows.limit, rows.matched) ||
    truncated !== rows.matched > items.length ||
    coverage.totals_scope !== "population" ||
    !groupsMatchTotals(items, population, truncated)
  ) {
    throw new Invalid("verification_failed", reason);
  }
  const complete = proof.complete && !truncated && coverage.completeness === "complete";
  if (!proof.complete) notices.add("evidence_incomplete");
  if (truncated) notices.add("metadata_groups_truncated");
  if (coverage.reasons.some((code) => METADATA_REASONS.has(code))) notices.add("metadata_values_missing");
  if (codes.some((entry) => entry.code === "metadata_key_mostly_missing")) notices.add("metadata_key_mostly_missing");
  return {
    provenance: origin,
    window: span,
    evidence: proof,
    warnings: codes,
    content_included: false,
    group_by: { dimension: "metadata", metadata_key: key },
    filters: { metadata: metadataFilters },
    truncated,
    complete,
    empty: items.length === 0,
    rows: items.length,
    items,
    totals: totalsOf(items, complete),
    coverage,
    population_totals: population,
    pricing: pricingOf(body.pricing, notices, reason),
    attribution: attributionOf(body.attribution, reason),
  };
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
        pricing: pricingOf(row.pricing, notices, reason, { note: false }),
        link: link.value,
        link_workspace_bound: link.workspaceBound === true,
      };
    });
    if (!proof.complete) notices.add("evidence_incomplete");
    if (page.truncated) notices.add("more_pages");
    const coverage = coverageOf(body.coverage, notices, reason);
    if (coverage !== null && coverage.next_cursor !== page.next_cursor) {
      throw new Invalid("verification_failed", reason);
    }
    const pagePricing = pricingOf(body.pricing, notices, reason);
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
      attribution: attributionOf(body.attribution, reason) ?? {
        // Trace rows are whole-trace totals whether or not the service says so.
        level: "trace",
        cost_basis: "trace_total",
        per_provider_exact: false,
        mixed_provider_rows: traces.filter((trace) => trace.mixed_providers).length,
        mixed_model_rows: traces.filter((trace) => trace.mixed_models).length,
      },
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
