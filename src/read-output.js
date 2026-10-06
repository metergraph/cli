import { authMessage } from "./output.js";

// Fixed text for read command reasons and notices. Reasons shared with sign
// in and doctor fall back to their wording. Nothing here contains a value from
// a server response other than validated metadata printed by readText.

const READ_MESSAGES = {
  not_signed_in: 'This project is not signed in. Run "metergraph login --runtime local" first.',
  capability_unavailable:
    "The service does not offer this read to the project's Metadata grant. No data was read and no broader access was requested.",
  exceeds_service_bounds:
    "The requested --days or --limit is larger than the service allows. It was not reduced automatically. No data was read.",
  insufficient_scope: "The service refused this read because the grant lacks a required scope. No broader scope was requested.",
  forbidden: "The service refused this read for the signed in grant.",
  rate_limited: "The service is rate limiting requests. Nothing was retried.",
  endpoint_unavailable: "This service does not offer this read endpoint.",
  request_rejected:
    "The service rejected the request parameters, for example an expired or foreign cursor. No data was read.",
  contract_version_unsupported: "The service answered with an agent access contract version this CLI does not support.",
  content_in_metadata_response:
    "The service's Metadata response contained a field that could carry captured content or a credential. Nothing from it was printed.",
  filter_mismatch: "The service reported different trace filters than the ones requested. Nothing from it was printed.",
  filter_not_applied:
    "The service returned traces that do not match the requested filter. Nothing from it was printed.",
  read_response_invalid: "The service's response is not usable JSON. Nothing from it was printed.",
  usage_response_invalid: "The service's usage response does not match the contract. Nothing from it was printed.",
  routes_response_invalid: "The service's routes response does not match the contract. Nothing from it was printed.",
  traces_response_invalid: "The service's traces response does not match the contract. Nothing from it was printed.",
  workspace_context_mismatch:
    "The service answered for a different workspace than this project is bound to. Nothing from it was printed.",
  profile_mismatch:
    "The service reported a different deployment profile than this project is bound to. Nothing from it was printed.",
  timeout: "The command did not finish within --timeout-ms.",
  cancelled:
    "The command was interrupted. Read commands never change workspace configuration or telemetry. " +
    "An interrupted grant refresh may require running login again.",
  credential_in_metadata_response:
    "The service's Metadata response contained a credential this CLI holds for the project. Nothing from it was printed.",
};

export function readMessage(outcome, reason) {
  return READ_MESSAGES[reason] ?? authMessage(outcome, reason);
}

const NOTICES = {
  application_traffic_not_verified:
    "Application traffic is not verified. A signed in project, existing data or a configured SDK alone does not prove it.",
  evidence_incomplete: "The service marked this evidence as incomplete.",
  rows_truncated: "The service returned fewer rows than exist. Totals cover the returned rows only.",
  more_pages: "More traces exist. Pass --cursor with next_cursor to read the next page.",
  routes_truncated_locally:
    "The service returned more routes than --limit. Only the first rows are shown; the routes endpoint has no server limit or window.",
  route_details_omitted: "Route descriptions, constraints and evaluation contract bodies are not printed.",
  warning_messages_omitted: "Service warning messages are not printed; only their codes are.",
  unsafe_text_omitted: "Some names contained control or formatting characters and are shown as null.",
  unrecognized_capabilities_ignored: "Capabilities this CLI does not recognize are not shown.",
  privacy_class_details_omitted: "Privacy class descriptions are not printed.",
  trace_links_unavailable:
    "The service does not provide workspace-bound trace links yet, so no link is shown.",
};

export function noticeText(token) {
  return NOTICES[token] ?? null;
}

const yesNo = (value) => (value === true ? "yes" : value === false ? "no" : "not checked");
const show = (value) => (value === null || value === undefined ? "-" : String(value));
const usd = (value) => (value === null ? "-" : `$${value.toFixed(4)}`);

function table(header, rows) {
  const widths = header.map((title, column) =>
    Math.min(40, Math.max(title.length, ...rows.map((row) => row[column].length))),
  );
  const line = (cells) => cells.map((cell, column) => cell.padEnd(widths[column])).join("  ").trimEnd();
  return [line(header), ...rows.map(line)];
}

export function readText(result, message) {
  const data = result.data;
  const lines = [`Metergraph ${result.command} (Metadata only)`];
  if (data.origin !== null) lines.push(`Origin: ${data.origin}`);
  if (result.command === "status") {
    statusLines(data, lines);
  } else {
    if (data.workspace !== null) lines.push(`Workspace: ${data.workspace.id}`);
    if (result.ok) resultLines(result.command, data.result, lines);
  }
  const notices = data.notices.map(noticeText).filter(Boolean);
  if (notices.length > 0) lines.push("", ...notices.map((text) => `Note: ${text}`));
  if (!result.ok) {
    lines.push("", `Result: ${result.outcome} (exit ${result.exit_code})`, message);
    if (data.retry_after_seconds !== null && data.retry_after_seconds !== undefined) {
      lines.push(`Retry after: ${data.retry_after_seconds} seconds`);
    }
  }
  if (data.next_action?.message) lines.push(`Next: ${data.next_action.message}`);
  return `${lines.join("\n")}\n`;
}

function statusLines(data, lines) {
  lines.push(
    `Configured: ${data.configured ? "yes (.metergraph/project.json)" : "no"}`,
    `Reachable: ${yesNo(data.reachable)}`,
    `Authenticated: ${data.authenticated ? "yes, verified by the service" : "no"}`,
    `Workspace: bound ${show(data.workspace.intended)}, verified ${show(data.workspace.actual)}`,
    `Deployment profile: bound ${show(data.deployment_profile)}, reported by the service: ${
      data.deployment_profile_verified === true
        ? "same"
        : data.deployment_profile_verified === false
          ? "different"
          : "not checked"
    }`,
    `Scopes: ${data.scopes.length > 0 ? data.scopes.join(" ") : "none"}`,
  );
  if (data.capabilities !== null) {
    const flag = (name) => yesNo(data.capabilities[name]);
    lines.push(
      `Metadata reads: usage ${flag("usage")}, routes ${flag("routes")}, traces ${flag("trace_metadata")}`,
      "Content, evidence and replay: not available to this grant",
    );
  }
  lines.push(`Application traffic verified: no`);
}

function resultLines(command, report, lines) {
  if (command === "context") {
    const { workspace } = report;
    lines.push(
      `Slug: ${show(workspace.slug)}`,
      `Name: ${show(workspace.name)}`,
      `Created: ${workspace.created_at}`,
      `Metadata retention: ${report.retention.metadata_days} days`,
      `Content captured by the workspace: ${report.content.captured ? "yes" : "no"}; included in agent reads: no`,
      `Access: ${report.access.scopes.join(" ")}`,
      `Generated: ${report.provenance.generated_at}`,
    );
    return;
  }
  if (command === "capabilities") {
    lines.push(`Deployment profile: ${report.deployment_profile}`, "");
    const rows = Object.entries(report.agent)
      .filter(([, entry]) => entry !== null)
      .map(([name, entry]) => [name, entry.available ? "yes" : "no", entry.privacy_class, entry.required_scope]);
    lines.push(...table(["CAPABILITY", "AVAILABLE", "CLASS", "SCOPE"], rows));
    const { bounds } = report;
    lines.push(
      "",
      `Bounds: up to ${bounds.max_days} days, ${bounds.max_rows} rows, ${bounds.max_response_bytes} bytes; content included by default: no`,
    );
    return;
  }
  if (command === "usage") {
    lines.push(`Window: last ${report.window.days} days (${report.window.since} to ${report.window.until})`, "");
    if (report.empty) {
      lines.push("No usage rows in this window.");
    } else {
      const rows = report.items.map((item) => [
        item.date,
        show(item.route),
        String(item.calls),
        String(item.error_calls),
        usd(item.cost_usd),
        String(item.input_tokens),
        String(item.output_tokens),
        show(item.p95_latency_ms),
      ]);
      lines.push(...table(["DATE", "ROUTE", "CALLS", "ERRORS", "COST", "IN_TOKENS", "OUT_TOKENS", "P95_MS"], rows));
      const totals = report.totals;
      lines.push(
        "",
        `Returned rows: ${report.rows}. Totals of these rows${totals.complete ? "" : " (incomplete, not workspace totals)"}: ` +
          `${totals.calls} calls, ${totals.error_calls} errors, ${usd(totals.cost_usd)}, ` +
          `${totals.input_tokens} input and ${totals.output_tokens} output tokens.`,
      );
    }
    lines.push(`Evidence: ${report.complete ? "complete" : "incomplete"}`);
    return;
  }
  if (command === "routes") {
    lines.push("");
    if (report.empty) {
      lines.push("No routes.");
    } else {
      const rows = report.routes.map((row) => [
        show(row.route),
        String(row.calls),
        String(row.replay_eligible_calls),
        show(row.evaluation_contract_version),
        show(row.updated_at),
      ]);
      lines.push(...table(["ROUTE", "CALLS", "REPLAY_ELIGIBLE", "CONTRACT_VERSION", "UPDATED"], rows));
      lines.push("", `Shown: ${report.rows} of ${report.server_rows} routes returned by the service.`);
    }
    return;
  }
  if (command === "traces") {
    lines.push(`Window: last ${report.window.days} days`, "");
    if (report.empty) {
      lines.push("No traces on this page.");
    } else {
      const rows = report.traces.map((trace) => [
        trace.last_span_at,
        trace.status,
        trace.trace_id,
        show(trace.trace_name),
        String(trace.span_count),
        usd(trace.cost_usd),
        trace.routes.join(",") || "-",
      ]);
      lines.push(...table(["LAST_SPAN", "STATUS", "TRACE_ID", "NAME", "SPANS", "COST", "ROUTES"], rows));
    }
    lines.push("", `Page: ${report.page.rows} traces, limit ${report.page.limit}`);
    if (report.next_cursor !== null) lines.push(`Next page: --cursor ${report.next_cursor}`);
    lines.push("Trace links: not available from the service yet");
  }
}
