import { setTimeout as wait } from "node:timers/promises";
import { verifiedSession } from "./auth-session.js";
import { Stop } from "./auth-store.js";
import { AUTH_PATHS, READ_MAX_BYTES } from "./constants.js";
import { parseJsonObject } from "./http.js";
import { capabilitySummary } from "./read-contract.js";
import { deadline, failureOf, send, trapSignals } from "./transport.js";
import { traceReceipt, traceSelection } from "./trace-contract.js";
import { openTrace } from "./trace-open.js";

// One total deadline includes session refresh/lock waits and every poll.
// The fixed MCP Metadata query reuses the service's identity resolver. No
// retained content, ingestion, classification, provider or analysis call is
// ever made here. Dependency hooks let deterministic tests own their service.
export async function runVerify(options, dependencies = {}) {
  const timeoutMs = options.timeoutMs ?? 30000;
  const pollIntervalMs = options.pollIntervalMs ?? 1000;
  const maxAttempts = options.maxAttempts ?? 30;
  const selected = traceSelection(options);
  if (!selected.ok) return { outcome: selected.outcome, reason: selected.reason, data: null };
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 60000 ||
      !Number.isSafeInteger(pollIntervalMs) || pollIntervalMs < 100 || pollIntervalMs > 10000 ||
      !Number.isSafeInteger(maxAttempts) || maxAttempts < 1 || maxAttempts > 60) {
    return { outcome: "invalid_input", reason: "invalid_poll_bounds", data: null };
  }
  const trap = trapSignals();
  const cancel = options.cancel ? AbortSignal.any([trap.signal, options.cancel]) : trap.signal;
  const limit = deadline(timeoutMs, cancel);
  let known = [];
  let receipt = null;
  let attempts = 0;
  const end = (outcome, reason, data = receipt) => {
    if (holdsKnown(data, known)) return { outcome: "verification_failed", reason: "credential_in_metadata_response", data: null };
    return { outcome, reason, data: data === null ? null : { ...data, attempts } };
  };
  const interrupted = () => limit.timedOut() ? end("connection_failed", "verification_timeout") : end("cancelled", "cancelled");
  try {
    const sessionResult = await (dependencies.session ?? verifiedSession)({ project: options.project, configDir: options.configDir, cancel: limit.signal });
    if (limit.signal.aborted) return interrupted();
    if (!sessionResult.ok) return end(sessionResult.outcome, sessionResult.reason);
    known = sessionResult.knownCredentials;
    const session = sessionResult.session;
    const ctx = { origin: session.origin, workspaceId: session.workspaceId, profile: session.profile };
    const capabilities = capabilitySummary(sessionResult.documents.capabilities, ctx, new Set());
    if (!capabilities.ok) return end(capabilities.outcome, capabilities.reason);
    if (capabilities.value.agent.trace_metadata?.available !== true) return end("capability_unavailable", "capability_unavailable");
    if (selected.value.days > capabilities.value.bounds.max_days || capabilities.value.bounds.max_rows < 2) return end("unsupported", "exceeds_service_bounds");
    for (attempts = 1; attempts <= maxAttempts; attempts++) {
      if (limit.signal.aborted) return interrupted();
      const response = await queryTrace(session, selected.value, attempts, limit.signal, dependencies.send ?? send);
      if (limit.signal.aborted) return interrupted();
      if (!response.ok) return end(response.outcome, response.reason);
      const checked = traceReceipt(response.body, ctx, selected.value);
      if (!checked.ok) return end(checked.outcome, checked.reason);
      receipt = checked.value;
      if (holdsKnown(receipt, known)) return end("verification_failed", "credential_in_metadata_response", null);
      if (checked.found) {
        if (options.open) {
          const opened = await openTrace(receipt, { ...options, signal: limit.signal }, dependencies.launch);
          if (limit.signal.aborted) return interrupted();
          return end(opened.outcome, opened.reason, opened.data);
        }
        return end("ok", null);
      }
      if (attempts === maxAttempts) return end("verification_failed", "trace_not_found_within_bounds");
      try { await wait(pollIntervalMs, null, { signal: limit.signal }); } catch { return interrupted(); }
    }
  } catch (error) {
    if (limit.signal.aborted) return interrupted();
    if (error instanceof Stop) return end(error.outcome, error.reason);
    throw error;
  } finally { trap.release(); }
}

async function queryTrace(session, selection, id, signal, request) {
  const args = { days: selection.days, limit: 2, [selection.traceId === null ? "request_id" : "trace_id"]: selection.traceId ?? selection.requestId };
  const response = await request(session.origin, AUTH_PATHS.resource, {
    method: "POST", signal, maxBytes: READ_MAX_BYTES, bearer: session.accessToken,
    json: { jsonrpc: "2.0", id, method: "tools/call", params: { name: "metergraph_query_traces", arguments: args } },
  });
  if (response.kind === "response") {
    if (response.status === 401) return failure("login_required", "access_revoked");
    if (response.status === 403) return failure("permission_denied", "forbidden");
    if (response.status === 429) return failure("rate_limited", "rate_limited");
    if (response.status === 404) return failure("unsupported", "endpoint_unavailable");
  }
  const fault = failureOf(response);
  if (fault !== null) return { ok: false, ...fault };
  if (response.status !== 200) return failure("unsupported", "unexpected_status");
  const message = parseJsonObject(response);
  const result = message?.result;
  if (message?.jsonrpc === "2.0" && message.id === id && [-32601, -32602].includes(message.error?.code)) {
    return failure("unsupported", "identity_query_unavailable");
  }
  if (message?.jsonrpc !== "2.0" || message.id !== id || message.error !== undefined ||
      result === null || typeof result !== "object" || Array.isArray(result) || typeof result.isError !== "boolean") return failure("verification_failed", "trace_response_invalid");
  if (result.isError) {
    const code = result.structuredContent?.error?.code;
    const errors = { forbidden: ["permission_denied", "forbidden"], unsupported_capability: ["capability_unavailable", "capability_unavailable"], not_found: ["unsupported", "identity_query_unavailable"], rate_limited: ["rate_limited", "rate_limited"], response_too_large: ["unsupported", "response_too_large"] };
    return Object.hasOwn(errors, code) ? failure(...errors[code]) : failure("unsupported", "identity_query_unavailable");
  }
  return { ok: true, body: result.structuredContent };
}

const failure = (outcome, reason) => ({ ok: false, outcome, reason });
function holdsKnown(value, known) {
  if (typeof value === "string") {
    // A server link can URI-encode a credential into an otherwise allowed
    // query value. Check the decoded URL as well as its printed spelling.
    const variants = [value];
    try { variants.push(decodeURIComponent(value)); } catch { /* Plain metadata need not be URI encoded. */ }
    if (value.includes("#traces?")) {
      const query = new URLSearchParams(value.slice(value.indexOf("#traces?") + 8));
      for (const [key, entry] of query) variants.push(key, entry);
    }
    return known.some((secret) => typeof secret === "string" && secret.length > 0 && variants.some((variant) => variant.includes(secret)));
  }
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) => holdsKnown(key, known) || holdsKnown(entry, known));
}
