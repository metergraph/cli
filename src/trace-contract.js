import { AGENT_CONTRACT_VERSION } from "./constants.js";
import { normalizeUuid } from "./auth-oauth.js";

const object = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const count = (v) => Number.isSafeInteger(v) && v >= 0;
const token = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:/+-]{0,127}$/.test(v);
const timestamp = (v) => typeof v === "string" && v.length <= 40 &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(v) && Number.isFinite(Date.parse(v));
const identity = (v) => typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(v);
const fail = (reason, outcome = "verification_failed") => ({ ok: false, outcome, reason });

// Exact identity plus the application's own invocation window. There is no
// default identity, latest-row fallback, or implied application provenance.
export function traceSelection(options, now = Date.now()) {
  const traceId = options.traceId ?? null;
  const requestId = options.requestId ?? null;
  if ((traceId === null) === (requestId === null) || !identity(traceId ?? requestId)) {
    return fail("invalid_trace_identity", "invalid_input");
  }
  if (!timestamp(options.since) || !timestamp(options.until) ||
      Date.parse(options.since) > Date.parse(options.until) || Date.parse(options.until) > now) {
    return fail("invalid_invocation_window", "invalid_input");
  }
  const days = options.days ?? Math.max(1, Math.ceil((now - Date.parse(options.since)) / 86400000));
  if (!Number.isSafeInteger(days) || days < 1 || days > 90 || now - Date.parse(options.since) > days * 86400000) {
    return fail("invocation_window_outside_bounds", "invalid_input");
  }
  const source = options.source ?? "unspecified";
  if (!["application", "synthetic", "demo", "import", "unspecified"].includes(source)) return fail("invalid_source", "invalid_input");
  return { ok: true, value: { traceId, requestId, since: options.since, until: options.until, days, source } };
}

// Validate only content-free evidence and build a new receipt. The caller
// receives no server names, warning prose, prompts, responses, or unknown keys.
export function traceReceipt(body, ctx, selected) {
  if (!object(body)) return fail("trace_response_invalid");
  if (body.schema_version !== AGENT_CONTRACT_VERSION) return fail("contract_version_unsupported", "unsupported");
  const p = body.provenance;
  if (!object(p) || !timestamp(p.generated_at) || !token(p.source)) return fail("trace_response_invalid");
  if (normalizeUuid(p.workspace_id) !== ctx.workspaceId) return fail("workspace_context_mismatch");
  if (p.deployment_profile !== ctx.profile) return fail("profile_mismatch");
  if (body.content_included !== false) return fail("content_in_metadata_response");
  const w = body.window;
  if (!object(w) || w.days !== selected.days || !timestamp(w.since) || !timestamp(w.until) ||
      Date.parse(w.since) > Date.parse(w.until)) return fail("trace_response_invalid");
  const page = body.page;
  if (!object(page) || page.limit !== 2 || typeof page.truncated !== "boolean" ||
      !(page.next_cursor === null || (typeof page.next_cursor === "string" && /^[\x21-\x7e]{1,512}$/.test(page.next_cursor))) ||
      body.truncated !== page.truncated || body.next_cursor !== page.next_cursor) return fail("trace_response_invalid");
  const e = body.evidence;
  if (!object(e) || !Array.isArray(e.sources) || e.sources.length > 64 || !e.sources.every(token) ||
      !count(e.rows) || typeof e.complete !== "boolean" || !Array.isArray(body.traces) ||
      body.traces.length > 2 || e.rows !== body.traces.length || !Array.isArray(body.warnings) ||
      body.warnings.length > 50 || !body.warnings.every((v) => object(v) && token(v.code))) return fail("trace_response_invalid");
  const warnings = body.warnings.map((v) => ({ code: v.code }));
  let requestMatch = null;
  if (selected.requestId !== null) {
    const match = body.request_match;
    if (!object(match) || match.request_id !== selected.requestId) return fail("request_identity_unavailable", "unsupported");
    if (!count(match.candidate_trace_count) || typeof match.ambiguous !== "boolean") return fail("trace_response_invalid");
    if (match.candidate_trace_count > 1 || match.ambiguous) return fail("ambiguous_trace_identity");
    if (match.candidate_trace_count !== body.traces.length) return fail("trace_response_invalid");
    requestMatch = { request_id: selected.requestId, candidate_trace_count: match.candidate_trace_count, ambiguous: false };
  }
  if (body.traces.length > 1) return fail("duplicate_trace_identity");
  if (page.truncated || page.next_cursor !== null || !e.complete) return fail("trace_evidence_incomplete");
  const provenance = { workspace_id: ctx.workspaceId, deployment_profile: ctx.profile, generated_at: p.generated_at, source: p.source };
  const base = {
    origin: ctx.origin, workspace: { id: ctx.workspaceId }, deployment_profile: ctx.profile,
    provenance, invocation: { trace_id: selected.traceId, request_id: selected.requestId, since: selected.since, until: selected.until, source: selected.source },
    request_match: requestMatch, warnings, complete: true, content_included: false,
    application_traffic_verified: false,
    readiness: { accepted: null, processed: false, metadata_available: false, capture_retained: null, classification_pending: null, analysis_ready: null },
    trace: null, app_url: null, link_status: "server_link_unavailable", link_workspace_bound: false,
  };
  if (body.traces.length === 0) return { ok: true, found: false, value: base };
  const row = body.traces[0];
  if (!object(row)) return fail("trace_response_invalid");
  if (Object.keys(row).some((k) => /^(prompt|prompts|input|inputs|output|outputs|messages|text|content|completion|request|response|spans|system|tool_calls|tool_definitions|api_key|token|access_token|refresh_token|authorization|password|secret|email)$/i.test(k))) {
    return fail("content_in_metadata_response");
  }
  if (!identity(row.trace_id) || row.id !== row.trace_id || !timestamp(row.started_at) || !timestamp(row.last_span_at) ||
      Date.parse(row.last_span_at) < Date.parse(row.started_at) || !count(row.span_count) || row.span_count === 0 ||
      !["success", "error"].includes(row.status)) return fail("trace_response_invalid");
  if (selected.traceId !== null && row.trace_id !== selected.traceId) return fail("trace_identity_mismatch");
  if (Date.parse(row.started_at) < Date.parse(selected.since) || Date.parse(row.started_at) > Date.parse(selected.until)) {
    return fail("trace_outside_invocation_window");
  }
  if (!e.sources.includes("calls")) return fail("processed_trace_evidence_unavailable");
  const trace = { trace_id: row.trace_id, started_at: row.started_at, last_span_at: row.last_span_at, span_count: row.span_count, status: row.status };
  const link = traceLink(row.metergraph_links?.trace ?? null, ctx.origin, trace, ctx.workspaceId);
  if (!link.ok) return link;
  // Only a server link carrying the row's verified workspace can authorize
  // opening. Older links remain available for manual inspection.
  return { ok: true, found: true, value: { ...base, trace, app_url: link.value,
    link_status: link.value === null ? "server_link_unavailable" :
      link.workspaceBound ? "available" : "workspace_binding_unavailable",
    link_workspace_bound: link.workspaceBound === true,
    readiness: { ...base.readiness, processed: true, metadata_available: true } } };
}

// A server-authoritative link from the same provenance-bound row. The known
// dashboard fragment must target precisely that row's trace and start time.
// No URL is synthesized when the service omits its link.
export function traceLink(raw, origin, trace, workspaceId = null) {
  if (raw === null || raw === undefined) return { ok: true, value: null };
  if (typeof raw !== "string" || raw.length > 2048 || /[^\x21-\x7e]|\\/.test(raw)) return fail("unsafe_trace_link");
  // URLSearchParams tolerates malformed escapes. Reject them before either
  // output or launch so decoding cannot hide an encoded credential.
  try { decodeURIComponent(raw); } catch { return fail("unsafe_trace_link"); }
  let url;
  try { url = new URL(raw); } catch { return fail("unsafe_trace_link"); }
  if (url.origin !== origin || url.username || url.password || url.pathname !== "/" || url.search || !url.hash.startsWith("#traces?")) return fail("unsafe_trace_link");
  const query = new URLSearchParams(url.hash.slice(8));
  const allowed = ["from", "to", "q", "trace", "workspace", "env"];
  const seen = new Set();
  for (const [key, value] of query) {
    if (!allowed.includes(key) || seen.has(key) || value.length > 256 || /[\x00-\x1f\x7f-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/.test(value)) return fail("unsafe_trace_link");
    seen.add(key);
  }
  if (query.get("trace") !== trace.trace_id || query.get("q") !== trace.trace_id ||
      !timestamp(query.get("from")) || !timestamp(query.get("to")) ||
      Date.parse(query.get("from")) !== Date.parse(trace.started_at) ||
      Date.parse(query.get("to")) !== Date.parse(trace.started_at) + 1) return fail("unsafe_trace_link");
  const workspace = query.get("workspace");
  if (workspace !== null && (normalizeUuid(workspace) !== workspace ||
      (workspaceId !== null && workspace !== workspaceId))) return fail("unsafe_trace_link");
  return { ok: true, value: raw, workspaceBound: workspace !== null && workspaceId !== null };
}
