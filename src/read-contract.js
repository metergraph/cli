import { normalizeUuid } from "./auth-oauth.js";
import { AGENT_CONTRACT_VERSION, MAX_CURSOR_LENGTH, METADATA_SCOPE } from "./constants.js";
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

function hasUnsafeText(value) {
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
    if (body.days !== request.days || typeof body.truncated !== "boolean") {
      throw new Invalid("verification_failed", reason);
    }
    const proof = evidence(body.evidence, reason);
    const codes = warnings(body.warnings, notices, reason);
    if (!Array.isArray(body.items) || body.items.length > request.limit) {
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
      };
    });
    const complete = proof.complete && !body.truncated;
    if (!proof.complete) notices.add("evidence_incomplete");
    if (body.truncated) notices.add("rows_truncated");
    return {
      provenance: origin,
      window: span,
      evidence: proof,
      warnings: codes,
      content_included: false,
      truncated: body.truncated,
      complete,
      empty: items.length === 0,
      rows: items.length,
      items,
      totals: totalsOf(items, complete),
    };
  });
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
        (row.status !== "success" && row.status !== "error")
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
        link: link.value,
        link_workspace_bound: link.workspaceBound === true,
      };
    });
    if (!proof.complete) notices.add("evidence_incomplete");
    if (page.truncated) notices.add("more_pages");
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
      },
      page: { limit: page.limit, rows: traces.length, truncated: page.truncated, next_cursor: page.next_cursor },
      truncated: page.truncated,
      next_cursor: page.next_cursor,
      complete: proof.complete && !page.truncated,
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
