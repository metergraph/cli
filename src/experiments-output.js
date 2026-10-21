import { STATISTICS } from "./experiments-contract.js";
import { readMessage } from "./read-output.js";
import { PLAIN, fields, headline, paragraph, render, steps, toneFor, workspaceShown } from "./style.js";

// Fixed text for experiments results. Nothing here contains a value from a
// service response other than validated metadata; the service's own refusal
// message is never printed.

const MESSAGES = {
  experiments_unavailable:
    "This deployment does not offer experiments to this credential, for example because the feature is off. " +
    "Nothing was read or started.",
  experiment_start_key_required:
    "Starting an experiment needs a coding-agent key with the Debug role and Allow analysis starts, in " +
    "--agent-token-file or METERGRAPH_AGENT_TOKEN. A saved sign in is Metadata only. " +
    "Nothing was sent.",
  experiment_start_not_granted:
    "This key cannot start experiments: it needs Debug access and the Allow analysis starts grant from a " +
    "workspace owner, and no Replay access. Nothing was started.",
  experiment_start_unavailable:
    "The service does not offer experiment starts to this key, for example because the feature is off or the " +
    "granting owner is no longer an owner. Nothing was started.",
  experiment_not_found: "No experiment with this ID is visible to this credential's workspace.",
  over_budget:
    "The estimate is above the experiment's budget. Sample fewer calls, drop a treatment or lower max_tokens. " +
    "Nothing was started.",
  no_replayable_calls:
    "The workload has no recent calls with a captured prompt and response to replay. Nothing was started.",
  experiments_in_progress: "Two experiments are already running in this workspace. Nothing was started.",
  daily_budget_exhausted: "This workspace has used its daily experiment budget. Nothing was started.",
  route_unpriced: "A treatment's model has no catalog price, so its replays cannot be budgeted. Nothing was started.",
  invalid_reasoning_effort:
    "A treatment's reasoning_effort is not offered by its model; data.refusal.allowed lists the ones it offers.",
  experiment_refused: "The service refused the experiment request; data.refusal has its code. Nothing was started.",
  request_mismatch:
    "The service did not confirm the request this command sent, so nothing from its answer was printed.",
  experiment_estimate_invalid: "The service's estimate did not match the experiments contract. Nothing from it was printed.",
  experiment_start_unconfirmed:
    "The start request reached the service, but its answer was not confirmed. An experiment may exist and may be " +
    "running: list this workload's experiments before starting again, since each start creates one.",
  experiment_launch_failed:
    "The service recorded the experiment but could not launch its runner, so it failed and nothing ran.",
  experiment_response_invalid: "The service's experiment did not match the experiments contract. Nothing from it was printed.",
  experiments_response_invalid: "The service's experiment list did not match the experiments contract. Nothing from it was printed.",
};
for (const reason of ["invalid_settings", "invalid_sample", "invalid_treatment", "invalid_treatments", "invalid_tracked_fields", "invalid_request"]) {
  MESSAGES[reason] = "The service refused the request's arguments; data.refusal has its reason. Nothing was started.";
}

const NOTICES = {
  experiment_link_omitted:
    "A dashboard link was left out because it did not point at this origin, workspace and experiment.",
  workspace_not_pinned: "No workspace was pinned, so the key's own workspace was used.",
  unsafe_text_omitted: "Some names were left out because they contained characters that could change how a terminal shows text.",
};

const TITLES = {
  list: "Experiments",
  estimate: "Experiment estimate",
  start: "Experiment started",
  get: "Experiment",
};

export function experimentsMessage(outcome, reason) {
  return MESSAGES[reason] ?? readMessage(outcome, reason);
}

const usd = (value) => (value === null ? "n/a" : `$${value < 0.01 && value > 0 ? value.toFixed(6) : value.toFixed(2)}`);
const rate = (value) => (value === null ? "n/a" : `${Math.round(value * 100)}%`);
const number = (value) => (value === null ? "n/a" : String(Math.round(value)));

function settingsText(settings) {
  const parts = Object.entries(settings).map(([key, value]) =>
    key === "extra_params"
      ? Object.entries(value).flatMap(([name, fields]) => Object.entries(fields).map(([field, entry]) => `${name}.${field}=${entry}`)).join(" ")
      : `${key}=${value}`);
  return parts.length > 0 ? parts.join(" ") : "production settings";
}

function armLine(arm) {
  return `${arm.label}: ${arm.provider}/${arm.model} (${settingsText(arm.settings)})`;
}

const STATISTIC_TITLES = {
  cost_per_call_usd: "COST/CALL",
  latency_ms_p50: "P50_MS",
  output_tokens_p50: "P50_OUT_TOK",
  output_chars_p50: "P50_CHARS",
  json_parse_rate: "JSON_OK",
  same_keys_rate: "SAME_KEYS",
  empty_or_refused_rate: "EMPTY_REFUSED",
  cut_off_rate: "CUT_OFF",
};

function statisticCell(name, value) {
  if (name === "cost_per_call_usd") return usd(value);
  if (name.endsWith("_rate")) return rate(value);
  return number(value);
}

function statisticsTable(experiment) {
  const header = ["ARM", "CASES", "ERRORS", ...STATISTICS.map((name) => STATISTIC_TITLES[name])];
  const row = (label, stats) => [label, String(stats.cases), String(stats.errors), ...STATISTICS.map((name) => statisticCell(name, stats[name]))];
  const rows = [row("production", experiment.control.statistics)];
  for (const arm of experiment.arms) {
    rows.push(row(arm.label, arm.statistics), row(`  production on ${arm.label}'s cases`, arm.control_statistics));
  }
  const widths = header.map((_, index) => Math.max(...[header, ...rows].map((cells) => cells[index].length)));
  return [header, ...rows].map((cells) => cells.map((cell, index) => cell.padEnd(widths[index])).join("  ").trimEnd());
}

function resultLines(action, report) {
  const lines = [];
  if (action === "list") {
    if (report.experiments.length === 0) return [[["Experiments", "none"]], []];
    const rows = [["Experiments", `${report.experiments.length}${report.page.truncated ? " (more exist; only the newest results are shown)" : ""}`]];
    const body = report.experiments.map((item) =>
      `${item.id}  ${item.status.padEnd(7)}  ${item.workload_id ?? "(name omitted)"}  ${item.arms.map((arm) => arm.label).join(", ")}  spent ${usd(item.spent_usd)}`);
    return [rows, body];
  }
  if (action === "estimate") {
    const { estimate } = report;
    const rows = [
      ["Workload", report.request.workload_id],
      ["Sample", `last ${report.request.sample.last_n} replayable calls, ${estimate.sample.cases} found`],
      ["Production models", Object.entries(estimate.sample.models_seen).map(([model, count]) => `${model} (${count})`).join(", ") || "none"],
      ["Estimate", `${usd(estimate.estimate_usd)} of a ${usd(estimate.budget_usd)} budget${estimate.over_budget ? " (over budget)" : ""}`],
      ["Daily cap", `${usd(estimate.spent_24h_usd)} of ${usd(estimate.daily_budget_usd)} committed in 24 hours${estimate.daily_budget_exhausted ? " (a start would pass it)" : ""}`],
      ["Start grant", report.start_granted ? "this credential has it" : "not on this credential"],
    ];
    const body = report.request.treatments.map((arm, index) => `${armLine(arm)}  ~${usd(estimate.arms[index].estimate_usd)}`);
    return [rows, body];
  }
  if (action === "start") {
    const { experiment } = report;
    const rows = [
      ["Experiment", experiment.id],
      ["Status", experiment.status],
      ["Workload", experiment.workload_id],
      ["Estimate", `${usd(experiment.estimate_usd)} of a ${usd(experiment.budget_usd)} budget`],
      ["Dashboard", report.app_url],
    ];
    return [rows, report.request.treatments.map(armLine)];
  }
  const { experiment } = report;
  const rows = [
    ["Experiment", experiment.id],
    ["Status", experiment.status + (experiment.error_code ? ` (${experiment.error_code})` : "")],
    ["Workload", experiment.workload_id],
    ["Cases", `${experiment.sample.replayed} replayed, ${experiment.sample.not_replayable} not replayable`],
    ["Production", experiment.control.model === null ? null : `${experiment.control.provider ?? "?"}/${experiment.control.model}`],
    ["Spent", `${usd(experiment.spend.spent_usd)} of a ${usd(experiment.spend.budget_usd)} budget`],
    ["Tracked fields", experiment.tracked_fields.length > 0 ? experiment.tracked_fields.join(", ") : null],
    ["Dashboard", experiment.app_url],
  ];
  lines.push(...experiment.arms.map(armLine));
  if (experiment.sample.replayed > 0) lines.push("", ...statisticsTable(experiment));
  return [rows, lines];
}

export function experimentsText(result, message, style = PLAIN, action) {
  const data = result.data;
  const title = `${TITLES[action]}${result.ok ? "" : action === "start" ? " was not started" : " could not be read"}`;
  const lines = [
    `${headline(style, result.ok ? "info" : toneFor(result.outcome), title, result.outcome)}  ${
      style.dim(action === "start" ? "Replays captured prompts within the server's budget" : "Metadata only")}`,
    "",
  ];
  const rows = [["Origin", data.origin], ["Workspace", workspaceShown(data.workspace)]];
  if (result.ok) {
    const [more, body] = resultLines(action, data.result);
    lines.push(...fields(style, [...rows, ...more]));
    if (body.length > 0) lines.push("", ...body.map((line) => (line === "" ? "" : `  ${line}`)));
  } else {
    lines.push(...fields(style, rows), "", ...paragraph(style, message));
  }
  const notices = (data.notices ?? []).map((token) => NOTICES[token]).filter(Boolean);
  if (notices.length > 0) {
    lines.push("");
    for (const text of notices) {
      const [first, ...rest] = paragraph(style, text, "    ");
      lines.push(`  ${style.yellow("!")} ${first.trimStart()}`, ...rest);
    }
  }
  const next = data.next_action;
  if (next?.message) {
    lines.push("", ...steps(style, [["", next.message], ["Run", next.command ?? null], ["Open", next.url ?? null]]));
  }
  return render(lines);
}
