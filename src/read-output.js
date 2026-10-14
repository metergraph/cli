import { authMessage } from "./output.js";
import { PLAIN, fields, headline, paragraph, render, steps, toneFor } from "./style.js";

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
  filter_mismatch: "The service reported different filters than the ones requested. Nothing from it was printed.",
  filter_not_applied:
    "The service returned traces that do not match the requested filter. Nothing from it was printed.",
  metadata_filter_unsupported:
    "The service did not confirm the metadata filter, so the CLI cannot show that it applied. " +
    "The service may predate metadata filters. Nothing from it was printed.",
  metadata_filter_mismatch:
    "The service reported different metadata filters than the ones requested. Nothing from it was printed.",
  group_by_mismatch:
    "The service did not group by the requested dimensions or metadata key. The service may predate that grouping. " +
    "Nothing from it was printed.",
  coverage_not_reported:
    "The service's grouped usage response carries no coverage evidence, so its groups cannot be checked. " +
    "Nothing from it was printed.",
  window_mismatch:
    "The service read a different UTC window than the one requested. Nothing from it was printed.",
  usage_aggregates_unavailable:
    "This deployment does not offer grouped usage (by provider, model, route or UTC day) to the project's " +
    "Metadata grant. Nothing was read.",
  temporarily_unavailable:
    "The service stopped this read at its time budget and returned nothing partial. Nothing was retried.",
  response_too_large:
    "The response is larger than the read's size budget, so nothing from it was printed.",
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
  metadata_groups_truncated:
    "More metadata values exist than --limit. Calls in the window still counts every call.",
  metadata_key_mostly_missing:
    "Most of this window's calls or cost have no value for the grouped key, so the rows with a value explain less than half of it.",
  metadata_values_missing:
    "Some calls have no usable value for the grouped key (missing, not a string or too long). They are shown as (no value) and totalled as not attributed to any value.",
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
  groups_truncated:
    "More groups matched than --limit. Only the highest-cost groups are listed; the all-calls totals still cover every matching call.",
  ranking_partial:
    "The service returns the highest-cost groups first, so this ranking covers only the listed groups, not every group.",
  current_day_partial:
    "The window ends now, part way through the current UTC day, so that day is partial.",
  partial_day_comparison:
    "A partial current UTC day is compared with a whole prior period. The totals are not like for like.",
  comparison_incomplete:
    "One of the compared windows is incomplete, so a change may be missing groups. A group absent from a cut window is unknown, not zero.",
  environment_restricted_key:
    "The grant is restricted to some environments, so totals cover only those environments.",
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
    if (requested && effective && requested.since !== effective.since) {
      lines.push(`Window read: ${effective.since} to ${effective.until} (requested from ${requested.since})`);
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
// - Grouped usage prints the partial UTC day in its Window line, the spend
//   without a key value in its metadata lines, and the comparison's window
//   lengths, prior coverage and completeness in its comparison lines.
// A metadata grouping where no call has a value: every call is unattributed.
function noCallHasTheKey(report) {
  const groups = report?.metadata_groups;
  if (!groups || !report.totals) return false;
  return report.totals.calls > 0 && groups.listed_with_value.calls === 0 &&
    groups.unlisted.other_values.calls === 0 && groups.unattributed.calls === report.totals.calls;
}

function textNotices(tokens, report) {
  const shown = new Set(tokens);
  const coverage = report?.coverage ?? null;
  if (coverage && coverage.completeness !== "complete") {
    for (const token of ["evidence_incomplete", "rows_truncated", "groups_truncated"]) shown.delete(token);
  }
  if (report?.pricing) shown.delete("pricing_lower_bound");
  if (report?.source === "usage_aggregates") {
    shown.delete("current_day_partial");
    if (report.metadata_groups) shown.delete("metadata_values_missing");
    if (report.comparison) {
      for (const token of ["partial_day_comparison", "comparison_incomplete"]) shown.delete(token);
      for (const token of tokens) if (token.startsWith("prior_")) shown.delete(token);
    }
  }
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
  if (token.startsWith("prior_")) {
    const text = NOTICES[token.slice("prior_".length)];
    return text === undefined ? null : `Prior window: ${text}`;
  }
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
  if (data.next_action?.message) lines.push("", ...steps(style, [["", data.next_action.message]]));
  return render(lines);
}

function statusRows(data, rows) {
  rows.push(
    ["Configured", data.configured ? "yes (.metergraph/project.json)" : "no"],
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
  if (command === "usage" && report.source === "usage_aggregates") {
    aggregateUsageLines(report, lines);
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
    lines.push(
      "Costs: whole-trace totals" +
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

const DIMENSION_TITLES = { provider: "PROVIDER", model: "MODEL", route: "ROUTE", day: "DAY_UTC" };
const titleOf = (dimension) => DIMENSION_TITLES[dimension] ?? "METADATA_VALUE";
// One group's cell for a dimension. The metadata group without a value is
// named, not shown as an empty string.
const cellOf = (item, dimension) => {
  if (dimension === "day") return `${item.day}${item.partial_day ? " (partial)" : ""}`;
  if (dimension.startsWith("metadata.")) return item.has_value ? show(item.metadata_value) : "(no value)";
  return show(item[dimension]);
};
const signed = (value, format) => (value === null ? "-" : `${value > 0 ? "+" : value < 0 ? "-" : ""}${format(Math.abs(value))}`);
const percent = (value) => (value === null ? "-" : `${value > 0 ? "+" : ""}${value}%`);

function windowLine(window) {
  const kind = window.preset === "utc_days"
    ? window.days === 1
      ? "today so far"
      : `the current UTC day so far and the ${window.days - 1} whole UTC days before it`
    : "explicit window";
  const partial = window.partial_days.length > 0 ? `; partial UTC day ${window.partial_days.join(", ")}` : "";
  return `${window.since} to ${window.until} UTC, ${window.hours} h (${kind}${partial})`;
}

// Grouped usage: one row per group in the chosen order, then all-calls
// totals, coverage, pricing, attribution and the latency definitions.
function aggregateUsageLines(report, lines) {
  const filters = Object.entries(report.filters)
    .filter(([key, count]) => key !== "metadata" && count > 0)
    .map(([key, count]) => `${key} (${count} value${count === 1 ? "" : "s"})`);
  lines.push(`Window: ${windowLine(report.window)}`, `Grouped by: ${report.group_by.join(", ")}`);
  const metadataDimension = report.group_by.find((dimension) => dimension.startsWith("metadata."));
  if (metadataDimension) {
    lines.push(`Metadata key: ${metadataDimension.slice("metadata.".length)} (a route is not a prompt; one route can carry several values)`);
  }
  if (filters.length > 0) lines.push(`Filters: exact match on ${filters.join(", ")}`);
  if (report.filters.metadata.count > 0) lines.push(metadataFilterLine(report.filters.metadata));
  lines.push(
    `Ranked by: ${report.sort.meaning}${report.sort.complete ? "" : " (listed groups only)"}`,
    "",
  );
  if (report.empty) {
    lines.push("No calls match this window and these filters.");
  } else {
    const rows = report.items.map((item) => [
      String(item.rank),
      ...report.group_by.map((dimension) => cellOf(item, dimension)),
      usd(item.cost_usd),
      String(item.calls),
      usd(item.cost_per_call_usd),
      String(item.error_calls),
      show(item.latency.avg_ms),
      show(item.latency.p95_ms),
    ]);
    lines.push(...table(
      ["#", ...report.group_by.map(titleOf), "COST", "CALLS", "COST/CALL", "ERRORS",
        "AVG_MS", "P95_MS_EST"],
      rows,
    ));
  }
  const all = report.totals;
  lines.push(
    "",
    `Groups: ${report.rows} listed of ${report.matched_groups ?? "an unreported number of"} matched.`,
    `All matching calls: ${all.calls} calls, ${all.error_calls} errors, ${usd(all.cost_usd)}, ` +
      `${usd(all.cost_per_call_usd)} per call, ${all.input_tokens} input and ${all.output_tokens} output tokens.`,
  );
  if (noCallHasTheKey(report)) {
    lines.push(
      `No call in this window has a value for ${report.metadata_groups.key}. ` +
        "Check the key's spelling and that the SDK sets it.",
    );
  }
  if (report.metadata_groups) {
    const groups = report.metadata_groups;
    const { other_values: other, missing_key: missing, ineligible_value: ineligible } = groups.unlisted;
    lines.push(
      `Attributed to a ${groups.key} value: ${groups.listed_with_value.calls} listed calls ` +
        `(${usd(groups.listed_with_value.cost_usd)}); ${other.groups} more values past --limit: ` +
        `${other.calls} calls (${usd(other.cost_usd)}).`,
      `Not attributed to any ${groups.key} value: ${groups.unattributed.calls} calls ` +
        `(${usd(groups.unattributed.cost_usd)}): without the key ${missing.calls} (${usd(missing.cost_usd)}), ` +
        `non-string or oversize value ${ineligible.calls} (${usd(ineligible.cost_usd)}).`,
    );
  }
  coverageLines(lines, report);
  if (report.attribution) {
    lines.push(
      `Attribution: per ${report.attribution.level}; ` +
        (report.attribution.per_provider_exact
          ? "a trace that used several providers adds each call's cost to that call's provider"
          : "cost is not split exactly by provider"),
    );
  }
  lines.push(
    "Latency: AVG_MS is the mean over calls that reported latency; P95_MS_EST is estimated from a fixed latency " +
      "histogram, not an exact percentile.",
    `Evidence: ${report.complete ? "complete" : "incomplete"}`,
  );
  if (report.comparison) comparisonLines(report, lines);
}

function comparisonLines(report, lines) {
  const comparison = report.comparison;
  const { totals } = comparison;
  lines.push(
    "",
    `Compared with ${comparison.mode === "previous" ? "the whole previous period" : "the previous period to the same elapsed time"}: ` +
      windowLine(comparison.prior.window),
    `Total cost: ${usd(totals.current.cost_usd)} now, ${usd(totals.prior.cost_usd)} before, ` +
      `${signed(totals.cost_change.delta, (value) => `$${value.toFixed(4)}`)} (${percent(totals.cost_change.percent)})`,
    `Calls: ${totals.current.calls} now, ${totals.prior.calls} before, ` +
      `${signed(totals.calls_change.delta, String)} (${percent(totals.calls_change.percent)})`,
  );
  if (comparison.partial_day_compared_with_full) {
    lines.push(
      `Not like for like: ${comparison.hours.current} h now against ${comparison.hours.prior} h before.`,
    );
  }
  if (comparison.items.length > 0) {
    const rows = comparison.items.map((item) => [
      ...report.group_by.map((dimension) => (dimension === "day" ? show(item.day) : cellOf(item, dimension))),
      item.current === null ? "unknown" : usd(item.current.cost_usd),
      item.prior === null ? "unknown" : usd(item.prior.cost_usd),
      signed(item.cost_change.delta, (value) => `$${value.toFixed(4)}`),
      percent(item.cost_change.percent),
      item.current === null ? "unknown" : String(item.current.calls),
      item.prior === null ? "unknown" : String(item.prior.calls),
    ]);
    lines.push(
      "",
      ...table(
        [...report.group_by.map(titleOf), "COST", "PRIOR_COST", "CHANGE", "CHANGE_%",
          "CALLS", "PRIOR_CALLS"],
        rows,
      ),
    );
  }
  const prior = comparison.prior;
  lines.push(
    "",
    `Prior coverage: ${prior.coverage?.completeness ?? "not reported"}` +
      (prior.coverage && prior.coverage.reasons.length > 0 ? ` (${prior.coverage.reasons.join(", ")})` : "") +
      `; pricing ${prior.pricing?.cost === "exact" ? "exact" : prior.pricing ? "lower bound" : "not reported"}`,
    `Comparison: ${comparison.complete ? "complete" : "incomplete"}`,
  );
}
