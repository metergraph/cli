import http from "node:http";

// Isolated protocol fixture. Its rows do not prove application traffic.
export const TRACE_WORKSPACE = "11111111-1111-4111-8111-111111111111";
export const TRACE_ID = "example-sdk-trace";
export const REQUEST_ID = "example-provider-request";
export const STARTED = "2026-01-01T00:00:01.000Z";
export const SINCE = "2026-01-01T00:00:00.000Z";
export const UNTIL = "2026-01-01T00:00:03.000Z";
export const provenance = () => ({ workspace_id: TRACE_WORKSPACE, deployment_profile: "local", source: "live-database", generated_at: "2026-01-01T00:00:04.000Z" });
export function capabilities() {
  return {
    schema_version: "metergraph.agent-access/v1", provenance: provenance(), deployment_profile: "local",
    deployment_capabilities: [], privacy_classes: [],
    agent: { trace_metadata: { available: true, content: false, mutates: false, external_calls: false, privacy_class: "metadata", required_scope: "agent:metadata", schema: "agent-access/trace-metadata" } },
    bounds: { max_days: 90, max_rows: 200, max_response_bytes: 1048576, content_included_by_default: false },
  };
}
export const selection = () => ({ traceId: TRACE_ID, requestId: null, since: SINCE, until: UNTIL, days: 1, source: "synthetic" });
export const context = (origin = "https://example.com") => ({ origin, workspaceId: TRACE_WORKSPACE, profile: "local" });
export function traceDocument(origin = "https://example.com", { found = true, request = false, link = false } = {}) {
  const trace = { id: TRACE_ID, trace_id: TRACE_ID, started_at: STARTED, last_span_at: "2026-01-01T00:00:02.000Z", span_count: 3, status: "success" };
  if (link) trace.metergraph_links = { trace: origin + "/#traces?" + new URLSearchParams({ from: STARTED, to: "2026-01-01T00:00:01.001Z", q: TRACE_ID, trace: TRACE_ID }).toString() };
  return {
    schema_version: "metergraph.agent-access/v1", provenance: provenance(), content_included: false,
    window: { days: 1, since: SINCE, until: UNTIL },
    page: { limit: 2, truncated: false, next_cursor: null }, truncated: false, next_cursor: null,
    evidence: { sources: ["calls"], rows: found ? 1 : 0, complete: true }, warnings: [], traces: found ? [trace] : [],
    ...(request ? { request_match: { request_id: REQUEST_ID, candidate_trace_count: found ? 1 : 0, ambiguous: false } } : {}),
  };
}

export async function startTraceServer(handler = null) {
  const requests = [];
  let origin;
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    const request = { method: req.method, path: req.url, message, authorization: req.headers.authorization };
    requests.push(request);
    const response = handler ? await handler(request, requests.length, origin) : {};
    if (response?.hang) return;
    const document = response?.document ?? traceDocument(origin, { request: Object.hasOwn(message.params.arguments, "request_id"), link: true });
    const result = { jsonrpc: "2.0", id: message.id, result: { isError: false, structuredContent: document, content: [{ type: "text", text: "omitted fixture data" }] } };
    res.writeHead(response?.status ?? 200, { "content-type": "application/json", ...response?.headers });
    res.end(JSON.stringify(response?.message ?? result));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${server.address().port}`;
  return {
    origin, requests,
    session: async () => ({ ok: true, session: { origin, workspaceId: TRACE_WORKSPACE, profile: "local", scopes: ["agent:metadata"], accessToken: "example-access-secret" }, documents: { capabilities: capabilities() }, knownCredentials: ["example-access-secret", "example-refresh-secret"] }),
    close: async () => { server.closeAllConnections(); await new Promise((resolve) => server.close(resolve)); },
  };
}
