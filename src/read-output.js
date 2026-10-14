import { authMessage } from "./output.js";
import { PLAIN, fields, headline, paragraph, render, steps, toneFor } from "./style.js";

// Fixed text for read command reasons and notices. Reasons shared with sign
// in and doctor fall back to their wording. Nothing here contains a value from
// a server response other than validated metadata printed by readText.

const READ_MESSAGES = {
  not_signed_in:
    'This project is not signed in and no Metadata key was given. Run "metergraph login --runtime local" first, ' +
    "or, where browser sign in cannot finish, give the CLI a coding-agent key with Metadata access in " +
    "METERGRAPH_AGENT_TOKEN.",
  agent_key_rejected:
    "The service refused the Metadata key: it is unknown, expired or revoked. Nothing was read.",
  agent_key_insufficient_scope:
    "The key is valid but lacks Metadata access to this workspace, for example because it is an ingest key. " +
    "No broader access was requested. Nothing was read.",
  agent_token_malformed:
    "METERGRAPH_AGENT_TOKEN does not hold exactly one key with no label, spaces or extra lines. Its value is not " +
    "shown. Nothing was sent.",
  agent_token_missing: "No Metadata key was found. Nothing was sent.",
  metergraph_url_invalid:
    "METERGRAPH_URL is not a bare https origin, or an http origin on localhost. Its value is not shown. Nothing was sent.",
  bound_to_other_origin:
    "This project is bound to a different origin than --url or METERGRAPH_URL names. Nothing was sent.",
  bound_to_other_workspace: "This project is bound to a different workspace than --workspace names. Nothing was sent.",
  agent_key_origin_unconfirmed:
    "This project's binding names a non-hosted origin, and a key is never sent to an origin taken only from a " +
    "project file. Set METERGRAPH_URL or pass --url with the same origin to confirm it. Nothing was sent.",
  scope_mismatch:
    "The credential is not limited to exactly the Metadata scope, so it was not used. The CLI never uses broader access.",
  content_access_granted:
    "The credential would allow content, replay or provider access, so it was not used. The CLI never uses broader access.",
  platform_credential_handoff:
    "--agent-token-file cannot be checked for privacy on this platform. Use METERGRAPH_AGENT_TOKEN instead.",
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
  metadata_filter_unsupported:
    "The service did not confirm the metadata filter, so the CLI cannot show that it applied. " +
    "The service may predate metadata filters. Nothing from it was printed.",
  metadata_filter_mismatch:
    "The service reported different metadata filters than the ones requested. Nothing from it was printed.",
  group_by_mismatch:
    "The service did not group by the requested metadata key. The service may predate metadata grouping. " +
    "Nothing from it was printed.",
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

const AGENT_TOKEN_FILE_MESSAGE =
  "The --agent-token-file file is not usable. It must be an existing regular file owned by this user with mode " +
  "0600 and one link, in a directory only this user can write, holding exactly one key. Its path and content are " +
  "not shown. Nothing was sent.";

export function readMessage(outcome, reason) {
  if (typeof reason === "string" && reason.startsWith("agent_token_file_")) return AGENT_TOKEN_FILE_MESSAGE;
  return READ_MESSAGES[reason] ?? authMessage(outcome, reason);
}

const NOTICES = {
  workspace_not_pinned:
    "No workspace was pinned, so the key's own workspace was verified and used. Pass --workspace, or bind the " +
    "project, so that a key for another workspace fails instead.",
  agent_key_not_used:
    "METERGRAPH_AGENT_TOKEN is set, but this project's saved sign in was used. Pass --agent-token-file to use a key instead.",
  application_traffic_not_verified:
    "Application traffic is not verified. A signed in project, existing data or a configured SDK alone does not prove it.",
  evidence_incomplete: "The service marked this evidence as incomplete.",
  rows_truncated: "The service returned fewer rows than exist. Totals cover the returned rows only.",
  more_pages: "More traces exist. Pass --cursor with next_cursor to read the next page.",
  metadata_groups_truncated:
    "More metadata values exist than --limit. Calls in the window still counts every call.",
  metadata_key_mostly_missing:
    "Most of this window's calls or cost have no value for the grouped key, so the rows with a value explain less than half of it.",
  metadata_values_missing:
    "Some calls have no usable value for the grouped key (missing, not a string or too long). They are the group shown as having no value.",
  routes_truncated_locally:
    "The service returned more routes than --limit. Only the first rows are shown; the routes endpoint has no server limit or window.",
  route_details_omitted: "Route descriptions, constraints and evaluation contract bodies are not printed.",
  warning_messages_omitted: "Service warning messages are not printed; only their codes are.",
  unsafe_text_omitted: "Some names contained control or formatting characters and are shown as null.",
  unrecognized_capabilities_ignored: "Capabilities this CLI does not recognize are not shown.",
  privacy_class_details_omitted: "Privacy class descriptions are not printed.",
  coverage_partial:
    "The service reports this read does not cover the whole question. See coverage.reasons before treating any total as complete.",
  coverage_unknown:
    "The service could not establish whether this read is complete, so it is not treated as complete.",
  coverage_not_reported:
    "This service does not report coverage details. Completeness rests on its evidence and truncation flags alone.",
  pricing_lower_bound:
    "Some calls have missing, partial or unknown pricing, so cost is a lower bound.",
  mixed_provider_traces:
    "Some traces used more than one provider or model. A trace cost is the whole-trace total and cannot be split by provider; use usage for per-route cost.",
  unpriced_traces: "Some traces have no priced call, so their cost is unknown (shown as -), not zero.",
  trace_links_unavailable:
    "The service does not provide workspace-bound trace links yet, so no link is shown.",
};

// Coverage, window and pricing lines shared by usage and traces. Only
// validated fields and fixed tokens are printed.
function coverageLines(lines, report) {
  // Service warning codes, once, on one line. Their messages are never printed.
  const codes = [...new Set((report.warnings ?? []).map((entry) => entry.code))];
  if (codes.length > 0) lines.push(`Service warnings: ${codes.join(", ")}`);
  const coverage = report.coverage;
  if (coverage) {
    const requested = coverage.requested_window;
    const effective = coverage.effective_window;
    if (requested && effective && (requested.since !== effective.since || requested.until !== effective.until)) {
      lines.push(
        `Window read: ${effective.since} to ${effective.until} ` +
          `(requested ${requested.since} to ${requested.until})`,
      );
    }
    const matched = coverage.rows.matched === null ? "" : ` of ${coverage.rows.matched}`;
    // Pricing reasons are shown on the Pricing line instead.
    const reasons = coverage.reasons.filter((reason) => !reason.startsWith("pricing_"));
    lines.push(
      `Coverage: ${coverage.completeness}` +
        (reasons.length > 0 ? ` (${reasons.join(", ")})` : "") +
        `; ${coverage.rows.returned}${matched} ${coverage.rows.shape === "page" ? "rows on this page" : "rows returned"}` +
        `; as of ${coverage.as_of}`,
    );
  } else {
    lines.push("Coverage: not reported by this service");
  }
  const pricing = report.pricing;
  if (pricing) {
    lines.push(
      pricing.cost === "exact"
        ? `Pricing: exact (${pricing.priced_calls} priced calls, ${pricing.zero_cost_calls} priced at zero)`
        : `Pricing: lower bound (${pricing.unpriced_calls} unpriced, ${pricing.partial_calls} partially priced, ` +
            `${pricing.unknown_calls} unknown, ${pricing.priced_calls} priced of which ${pricing.zero_cost_calls} at zero)`,
    );
  }
}

// Notices for human output, without lines that repeat what the report
// already printed. JSON output keeps every notice token.
// - A Coverage line with completeness and reasons supersedes the generic
//   incomplete-evidence and truncation notices.
// - A Pricing line supersedes the lower-bound notice.
// - The "mostly missing" warning supersedes the plain missing-values notice.
// - Service warning codes are printed once on the "Service warnings" line,
//   so the "messages omitted" note adds nothing in text.
// A grouped report whose only rows are the no-value group, holding every call.
function noCallHasTheKey(report) {
  if (!report?.group_by || !report.population_totals || !Array.isArray(report.items)) return false;
  const total = report.population_totals.calls;
  return total > 0 && report.items.length > 0 && report.items.every((item) => !item.has_value)
    && report.totals.calls === total;
}

function textNotices(tokens, report) {
  const shown = new Set(tokens);
  const coverage = report?.coverage ?? null;
  if (coverage && coverage.completeness !== "complete") {
    for (const token of ["evidence_incomplete", "rows_truncated", "metadata_groups_truncated"]) shown.delete(token);
  }
  if (report?.pricing) shown.delete("pricing_lower_bound");
  if (shown.has("metadata_key_mostly_missing")) shown.delete("metadata_values_missing");
  // The grouped body states outright when no call has the key.
  if (noCallHasTheKey(report)) {
    shown.delete("metadata_key_mostly_missing");
    shown.delete("metadata_values_missing");
  }
  shown.delete("warning_messages_omitted");
  return tokens.filter((token) => shown.has(token));
}

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

const READ_TITLES = {
  status: "Project status",
  context: "Workspace context",
  capabilities: "Agent capabilities",
  usage: "Usage",
  routes: "Routes",
  traces: "Traces",
};

export function readText(result, message, style = PLAIN) {
  const data = result.data;
  const title = `${READ_TITLES[result.command] ?? result.command}${result.ok ? "" : " could not be read"}`;
  const lines = [
    `${headline(style, result.ok ? "info" : toneFor(result.outcome), title, result.outcome)}  ${style.dim("Metadata only")}`,
    "",
  ];
  const rows = [["Origin", data.origin]];
  if (result.command === "status") {
    statusRows(data, rows);
    lines.push(...fields(style, rows));
  } else {
    rows.push(["Workspace", data.workspace?.id ?? null]);
    if (result.ok) {
      const body = [];
      resultLines(result.command, data.result, body);
      // "Label: value" lines before the first blank line join the field block.
      let split = 0;
      while (split < body.length && body[split] !== "" && /^[A-Z][^:]{0,40}: /.test(body[split])) {
        const at = body[split].indexOf(": ");
        rows.push([body[split].slice(0, at), body[split].slice(at + 2)]);
        split += 1;
      }
      lines.push(...fields(style, rows), "");
      for (const line of body.slice(split)) {
        lines.push(/^[A-Z_]+( +[A-Z_]+)*$/.test(line.trim()) && line === line.toUpperCase() && line.trim() !== ""
          ? `  ${style.dim(line)}` : line === "" ? "" : `  ${line}`);
      }
    } else {
      lines.push(...fields(style, rows));
    }
  }
  const notices = textNotices(data.notices, result.ok ? data.result : null).map(noticeText).filter(Boolean);
  if (notices.length > 0) {
    lines.push("");
    for (const text of notices) {
      const [first, ...rest] = paragraph(style, text, "    ");
      lines.push(`  ${style.yellow("!")} ${first.trimStart()}`, ...rest);
    }
  }
  if (!result.ok) {
    lines.push("", ...paragraph(style, message));
    if (data.retry_after_seconds !== null && data.retry_after_seconds !== undefined) {
      lines.push(...fields(style, [["Retry after", `${data.retry_after_seconds} seconds`]]));
    }
  }
  if (data.next_action?.message) {
    const next = data.next_action;
    const handoff = next.kind === "use_agent_key";
    const keysUrl = handoff
      ? next.person_steps.find((step) => step.action === "create_metadata_key")?.url ?? null
      : next.url ?? null;
    lines.push("", ...steps(style, [
      ["", next.message],
      ["Keys page", keysUrl],
      ["Connection guide", handoff ? next.url : null],
    ]));
  }
  return render(lines);
}

function statusRows(data, rows) {
  rows.push(
    ["Configured", data.configured ? "yes" : "no"],
    ["Credential", { oauth_grant: "saved sign in", agent_key: "Metadata key" }[data.credential] ?? "none"],
    ["Reachable", yesNo(data.reachable)],
    ["Authenticated", data.authenticated ? "yes, verified by the service" : "no"],
    ["Workspace", `bound ${show(data.workspace.intended)}, verified ${show(data.workspace.actual)}`],
    ["Deployment profile", `bound ${show(data.deployment_profile)}, reported by the service: ${
      data.deployment_profile_verified === true
        ? "same"
        : data.deployment_profile_verified === false
          ? "different"
          : "not checked"
    }`],
    ["Scopes", data.scopes.length > 0 ? data.scopes.join(" ") : "none"],
  );
  if (data.capabilities !== null) {
    const flag = (name) => yesNo(data.capabilities[name]);
    rows.push(
      ["Metadata reads", `usage ${flag("usage")}, routes ${flag("routes")}, traces ${flag("trace_metadata")}`],
      ["Content and replay", "not available to this grant"],
    );
  }
  rows.push(["Application traffic verified", "no"]);
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
  if (command === "usage" && report.group_by !== null) {
    groupedUsageLines(report, lines);
    return;
  }
  if (command === "usage") {
    lines.push(`Window: last ${report.window.days} days (${report.window.since} to ${report.window.until})`);
    if (report.filters.metadata.count > 0) lines.push(metadataFilterLine(report.filters.metadata));
    lines.push("");
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
    if (report.population_totals) {
      const all = report.population_totals;
      lines.push(
        `All matching calls in the window: ${all.calls} calls, ${all.error_calls} errors, ${usd(all.cost_usd)}, ` +
          `${all.input_tokens} input and ${all.output_tokens} output tokens.`,
      );
    }
    coverageLines(lines, report);
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
    lines.push(`Window: last ${report.window.days} days`);
    if (report.filters.metadata.count > 0) lines.push(metadataFilterLine(report.filters.metadata));
    lines.push("");
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
    coverageLines(lines, report);
    const mixed = report.traces.filter((trace) => trace.mixed_providers).length;
    const matching = report.attribution?.cost_basis === "matching_calls";
    lines.push(
      (matching ? "Costs: matching calls only (a filter selected calls, not whole traces)" : "Costs: whole-trace totals") +
        (mixed > 0 ? `; ${mixed} trace${mixed === 1 ? "" : "s"} used several providers, not split by provider` : ""),
    );
    lines.push(`Evidence: ${report.complete ? "complete" : "incomplete"}`);
    lines.push("Trace links: not available from the service yet");
  }
}

// Filter values are not printed back; only the keys they applied to.
function metadataFilterLine(filters) {
  return `Metadata filter: exact match on ${filters.keys.join(", ")}`;
}

function groupedUsageLines(report, lines) {
  const key = report.group_by.metadata_key;
  lines.push(
    `Window: last ${report.window.days} days (${report.window.since} to ${report.window.until})`,
    `Grouped by metadata: ${key}`,
  );
  if (report.filters.metadata.count > 0) lines.push(metadataFilterLine(report.filters.metadata));
  lines.push("");
  if (report.empty) {
    lines.push("No calls in this window.");
  } else {
    const rows = report.items.map((item) => [
      item.has_value ? show(item.metadata_value) : `(no ${key} value)`,
      String(item.calls),
      String(item.error_calls),
      usd(item.cost_usd),
      String(item.input_tokens),
      String(item.output_tokens),
      show(item.p95_latency_ms),
    ]);
    lines.push(...table(["VALUE", "CALLS", "ERRORS", "COST", "IN_TOKENS", "OUT_TOKENS", "P95_MS"], rows));
  }
  const rows = report.coverage.rows;
  const total = report.population_totals;
  if (noCallHasTheKey(report)) {
    lines.push(
      "",
      `No call in this window has a value for ${key}. Check the key's spelling and that the SDK sets it.`,
    );
  }
  lines.push(
    "",
    `Groups: ${rows.returned} shown of ${rows.matched} values.`,
    `Calls in the window: ${total.calls} (${usd(total.cost_usd)}); the shown groups hold ${report.totals.calls}.`,
    `Evidence: ${report.complete ? "complete" : "incomplete"}`,
  );
  coverageLines(lines, report);
}
