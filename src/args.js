import { parsePricing, PRICING_ACTIONS, PRICING_OPTIONS } from "./pricing-args.js";
import { parseRepository } from "./repository-identity.js";
import {
  DEFAULT_ORIGIN,
  DEFAULT_TIMEOUT_MS,
  EXPERIMENT_LAST_N,
  EXPERIMENT_LIST_DEFAULT_LIMIT,
  EXPERIMENT_LIST_MAX_LIMIT,
  EXPERIMENT_MAX_TOKENS,
  EXPERIMENT_MAX_TRACKED_FIELDS,
  EXPERIMENT_MAX_TREATMENTS,
  EXPERIMENT_REASONING_EFFORTS,
  EXPERIMENT_TEXT_LIMITS,
  HANDOFF_SKILL_CLIENTS,
  HANDOFF_SKILL_RUNTIMES,
  HANDOFF_LOGIN_RUNTIMES,
  LOGIN_DEFAULT_TIMEOUT_MS,
  LOGIN_MAX_TIMEOUT_MS,
  LOGIN_MIN_TIMEOUT_MS,
  LOGIN_RUNTIMES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  READ_DEFAULT_DAYS,
  READ_DEFAULT_LIMIT,
  READ_DEFAULT_TIMEOUT_MS,
  READ_MAX_DAYS,
  READ_MAX_LIMIT,
  READ_MAX_TIMEOUT_MS,
  READ_MIN_TIMEOUT_MS,
  SKILL_CLIENTS,
  SKILL_RUNTIMES,
  TRACES_DEFAULT_LIMIT,
  MAX_METADATA_FILTERS,
  MAX_METADATA_KEY_LENGTH,
  MAX_QUERY_LENGTH,
  MAX_METADATA_VALUE_LENGTH,
  USAGE_COMPARISONS,
  USAGE_DEFAULT_GROUP_BY,
  USAGE_DIMENSIONS,
  USAGE_MAX_FILTER_VALUES,
  USAGE_SORTS,
  WORKFLOW_PERMISSIONS,
} from "./constants.js";
import { parseOrigin } from "./origin.js";
import { groupedRequest, hasUnsafeText, isCursor, isSafeFilter, readQuery } from "./read-contract.js";
import { TOOL_ARGS_MAX_BYTES, TOOL_NAME } from "./tools.js";

export const READ_COMMANDS = Object.freeze(["status", "context", "capabilities", "usage", "routes", "traces"]);
const COMMANDS = new Set(["pricing", "doctor", "help", "skill", "skills", "login", "logout", "setup", "verify", "experiments", "tools", ...READ_COMMANDS]);
const HELP_TOPICS = new Set(["agents", "exit-codes", "pricing", "doctor", "skill", "skills", "login", "logout", "setup", "verify", "experiments", "tools", ...READ_COMMANDS]);
export const TOOLS_ACTIONS = Object.freeze(["list", "call"]);
// The roles login asks for: Metadata, or Debug, to which --allow-* adds the
// workflow permissions a workspace owner approves. Replay is never asked for.
export const LOGIN_ROLES = Object.freeze(["metadata", "debug"]);
// Each --allow-* switch and the scope it asks for, by the names bin/agent-key
// and the Keys page use.
const LOGIN_PERMISSIONS = Object.freeze(
  WORKFLOW_PERMISSIONS.map(({ field, scope }) => [`--${field.replaceAll("_", "-")}`, scope]),
);
export const EXPERIMENT_ACTIONS = Object.freeze(["list", "estimate", "start", "get"]);
const SKILL_ACTIONS = new Set(["install", "update"]);
const SKILLS_ACTIONS = new Set(["install", "update", "list"]);
const READ_BASE = ["--project", "--config-dir", "--timeout-ms"];
// The read commands may name where an agent key is sent and which workspace
// it must be for, and a private file holding the key. The key itself is
// never an argument.
const READ_KEY = ["--url", "--workspace", "--agent-token-file"];
const OPTIONS = {
  pricing: new Set(PRICING_OPTIONS),
  doctor: new Set(["--url", "--timeout-ms"]),
  skill: new Set(["--client", "--runtime", "--project"]),
  skills: new Set(["--client", "--runtime", "--project"]),
  login: new Set(["--runtime", "--url", "--workspace", "--role", "--project", "--config-dir", "--timeout-ms"]),
  setup: new Set(["--runtime", "--url", "--workspace", "--project", "--config-dir", "--env-file", "--client", "--timeout-ms", "--deployment", "--agent-token-file", "--repository"]),
  logout: new Set(["--project", "--config-dir"]),
  status: new Set([...READ_BASE, ...READ_KEY]),
  context: new Set([...READ_BASE, ...READ_KEY]),
  capabilities: new Set([...READ_BASE, ...READ_KEY]),
  usage: new Set([
    ...READ_BASE, ...READ_KEY, "--days", "--limit", "--metadata", "--metadata-json", "--group-by-metadata",
    "--group-by", "--route", "--provider", "--model", "--environment", "--since", "--until", "--sort", "--compare",
  ]),
  routes: new Set([...READ_BASE, ...READ_KEY, "--limit"]),
  traces: new Set([
    ...READ_BASE, ...READ_KEY, "--days", "--limit", "--route", "--status", "--cursor", "--metadata", "--metadata-json",
  ]),
  verify: new Set([...READ_BASE, "--trace-id", "--request-id", "--since", "--until", "--source", "--days", "--poll-ms", "--max-attempts"]),
  experiments: new Set([
    ...READ_BASE, ...READ_KEY, "--workload", "--limit", "--treatment", "--last-n", "--sample-model", "--track", "--id", "--request-key", "--consent-id",
  ]),
  tools: new Set([...READ_BASE, ...READ_KEY, "--name", "--args", "--args-file"]),
};
// Which experiments options each action takes, beyond READ_BASE and READ_KEY.
const EXPERIMENT_OPTIONS = {
  list: new Set(["--workload", "--limit"]),
  estimate: new Set(["--workload", "--treatment", "--last-n", "--sample-model", "--track"]),
  start: new Set(["--workload", "--treatment", "--last-n", "--sample-model", "--track", "--request-key", "--consent-id"]),
  get: new Set(["--id"]),
};
// Requests the read commands recognize and refuse, so a script gets an
// explicit unsupported result instead of an unknown argument or, worse, a
// broader query than it asked for. Nothing is sent for them.
const REFUSED = {
  "--environment": { value: true, reason: "environment_selector_unsupported" },
  "--workload": { value: true, reason: "workload_filter_unsupported" },
  "--since": { value: true, reason: "time_range_unsupported" },
  "--until": { value: true, reason: "time_range_unsupported" },
  "--sql": { value: true, reason: "query_unsupported" },
  "--query": { value: true, reason: "query_unsupported" },
  "--content": { value: false, reason: "content_access_unsupported" },
  "--include-content": { value: false, reason: "content_access_unsupported" },
  "--debug": { value: false, reason: "content_access_unsupported" },
  "--replay": { value: false, reason: "content_access_unsupported" },
};
const REFUSED_MESSAGES = {
  environment_selector_unsupported:
    "--environment is supported only by usage, which sends it to the grouped usage read. This command has no " +
    "environment selector, so the CLI never sends one. Results cover the bound workspace. No request was made.",
  workload_filter_unsupported:
    "--workload is not supported by this CLI version: it cannot verify from the returned traces that a " +
    "workload filter was applied, so it never sends one. No request was made.",
  time_range_unsupported:
    "--since and --until are supported only by usage. Use --days N (1 to 90) for a window relative to now. " +
    "No request was made.",
  query_unsupported:
    "Free-form queries are not supported. Use the fixed options of this command. No request was made.",
  content_access_unsupported:
    "Read commands return Metadata only. They never read retained content, debug data or replays. No request was made.",
};
// Options that may be given more than once; their values are kept in order.
const REPEATABLE = new Set(["--metadata"]);
const EXPERIMENT_REPEATABLE = new Set(["--treatment", "--track"]);
// usage takes several values for each of its exact-match filters.
const USAGE_REPEATABLE = new Set(["--route", "--provider", "--model", "--environment"]);
// usage reads a time range and environments itself, through grouped usage.
const USAGE_ACCEPTS = new Set(["--environment", "--since", "--until"]);
// Options that select grouped usage (GET /v1/agent/usage/aggregates).
const USAGE_GROUPED = [
  "--group-by", "--group-by-metadata", "--route", "--provider", "--model", "--environment", "--since", "--until", "--sort", "--compare",
];
// Options that take no value.
const FLAGS = {
  pricing: new Set(["--batch"]),
  login: new Set(["--signup", "--no-browser", "--reconnect", ...LOGIN_PERMISSIONS.map(([flag]) => flag)]),
  setup: new Set(["--no-browser", "--repair", "--signup", "--reconnect", "--skip-skill", "--confirm-prerequisites", "--no-repository"]),
  verify: new Set(["--open", "--no-browser"]),
  usage: new Set(["--today"]),
  tools: new Set(["--yes"]),
};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Parses argv into one of:
//   { ok: true, command: "help", topic, json }
//   { ok: true, command: "version", json }
//   { ok: true, command: "doctor", origin, timeoutMs, json }
//   { ok: true, command: "skill", action, client, runtime, project, json }
//   { ok: true, command: "skills", action, client, runtime, project, json }
//     (client and runtime are null for list)
//   { ok: true, command: "login", runtime, origin, workspace, project,
//     configDir, timeoutMs, signup, noBrowser, reconnect, json }
//   { ok: true, command: "logout", project, configDir, json }
//   { ok: true, command: one of READ_COMMANDS, project, configDir, timeoutMs,
//     days, limit, route, status, cursor, json }
//   { ok: false, command, json, code, message, outcome }
// outcome is invalid_input, or unsupported for a recognized request the read
// commands refuse (such as --environment).
// Error messages are fixed strings. They never contain an argument value,
// because a mistyped argument can be a credential.
export function parseArgs(argv) {
  const json = argv.includes("--json");

  const helpCommand = argv.find(arg => arg !== "--json") === "help";
  if (argv.includes("--help") || argv.includes("-h") || helpCommand) {
    const parts = argv.filter(arg => !["--json", "--help", "-h", "--advanced"].includes(arg));
    if (parts[0] === "help") parts.shift();
    const topic = HELP_TOPICS.has(parts[0]) ? parts[0] : null;
    const actions = { pricing: PRICING_ACTIONS, experiments: EXPERIMENT_ACTIONS,
      skill: [...SKILL_ACTIONS], skills: [...SKILLS_ACTIONS] };
    const action = actions[topic]?.includes(parts[1]) ? parts[1] : null;
    if (helpCommand && (parts.length > (action ? 2 : topic ? 1 : 0))) {
      return { ok: false, command: "help", json, code: "unknown_help_topic", outcome: "invalid_input",
        message: 'Unknown help topic. Run "metergraph --help" for commands.' };
    }
    return { ok: true, command: "help", topic, ...(action ? { action } : {}), ...(argv.includes("--advanced") ? { advanced: true } : {}), json };
  }

  let command = null;
  let action = null;
  let toolName = null;
  let topic = null;
  let version = false;
  const values = {};
  const flags = new Set();

  const fail = (code, message, outcome = "invalid_input") => ({
    ok: false,
    command: (command === "skill" || command === "skills" || command === "experiments" || command === "tools") && action !== null
      ? `${command} ${action}`
      : command ?? (version ? "version" : null),
    json,
    code,
    message,
    outcome,
  });

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const position = index + 1;

    if (arg === "--json") continue;

    if (command === null && !version && COMMANDS.has(arg)) {
      command = arg;
      continue;
    }
    if (command === null && arg === "--version") {
      version = true;
      continue;
    }
    if (command === "help" && topic === null && HELP_TOPICS.has(arg)) {
      topic = arg;
      continue;
    }
    if (command === "pricing" && action === null && PRICING_ACTIONS.includes(arg)) {
      action = arg;
      continue;
    }
    if (command === "skill" && action === null && SKILL_ACTIONS.has(arg)) {
      action = arg;
      continue;
    }
    if (command === "skills" && action === null && SKILLS_ACTIONS.has(arg)) {
      action = arg;
      continue;
    }
    if (command === "experiments" && action === null && EXPERIMENT_ACTIONS.includes(arg)) {
      action = arg;
      continue;
    }
    if (command === "tools" && action === null && TOOLS_ACTIONS.includes(arg)) {
      action = arg;
      continue;
    }
    if (command === "tools" && action === "call" && toolName === null && !arg.startsWith("-")) {
      toolName = arg;
      continue;
    }

    if (READ_COMMANDS.includes(command)) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (Object.hasOwn(REFUSED, name) && !(command === "usage" && USAGE_ACCEPTS.has(name))) {
        const { reason } = REFUSED[name];
        return fail(reason, REFUSED_MESSAGES[reason], "unsupported");
      }
    }

    if (Object.hasOwn(OPTIONS, command ?? "")) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (FLAGS[command]?.has(name)) {
        if (equals !== -1) return fail("unexpected_value", `${name} does not take a value.`);
        if (flags.has(name)) return fail("duplicate_option", `${name} may be given only once.`);
        flags.add(name);
        continue;
      }
      if (OPTIONS[command].has(name)) {
        let value;
        if (equals === -1) {
          index += 1;
          value = argv[index];
        } else {
          value = arg.slice(equals + 1);
        }
        if (value === undefined) {
          return fail("missing_value", `${name} requires a value.`);
        }
        if (REPEATABLE.has(name) || (command === "usage" && USAGE_REPEATABLE.has(name)) ||
            (command === "experiments" && EXPERIMENT_REPEATABLE.has(name))) {
          values[name] = [...(values[name] ?? []), value];
          continue;
        }
        if (values[name] !== undefined) {
          return fail("duplicate_option", `${name} may be given only once.`);
        }
        values[name] = value;
        continue;
      }
    }

    if (command === null && !version && !arg.startsWith("-")) {
      return fail(
        "unknown_command",
        `Unknown command at argument ${position}. Run "metergraph --help" for usage.`,
      );
    }
    if (command === "skill" && action === null && !arg.startsWith("-")) {
      return fail(
        "unknown_subcommand",
        `Unknown skill subcommand at argument ${position}. Use install or update.`,
      );
    }
    if (command === "skills" && action === null && !arg.startsWith("-")) {
      return fail(
        "unknown_subcommand",
        `Unknown skills subcommand at argument ${position}. Use install, update or list.`,
      );
    }
    if (command === "experiments" && action === null && !arg.startsWith("-")) {
      return fail(
        "unknown_subcommand",
        `Unknown experiments subcommand at argument ${position}. Use list, estimate, start or get.`,
      );
    }
    if (command === "tools" && action === null && !arg.startsWith("-")) {
      return fail("unknown_subcommand", `Unknown tools subcommand at argument ${position}. Use list or call.`);
    }
    return fail(
      "unknown_argument",
      `Unrecognized argument at position ${position}. Run "metergraph --help" for usage.`,
    );
  }

  if (version) return { ok: true, command: "version", json };
  if (command === null || command === "help") {
    return { ok: true, command: "help", topic, json };
  }
  if (command === "pricing") return parsePricing(action, values, flags, json, fail);
  if (command === "skill") return parseSkill(action, values, json, fail);
  if (command === "skills") return parseSkills(action, values, json, fail);
  if (command === "login") return parseLogin(values, flags, json, fail);
  if (command === "setup") return parseSetup(values, flags, json, fail);
  if (command === "verify") return parseVerify(values, flags, json, fail);
  if (command === "experiments") return parseExperiments(action, values, json, fail);
  if (command === "tools") return parseTools(action, toolName, values, flags, json, fail);
  if (READ_COMMANDS.includes(command)) return parseRead(command, values, flags, json, fail);
  if (command === "logout") {
    const paths = parsePaths(values, fail);
    if (!paths.ok) return paths;
    return { ok: true, command: "logout", project: paths.project, configDir: paths.configDir, json };
  }

  const origin = parseUrlOption(values);
  if (origin === null) return fail("invalid_url", INVALID_URL);

  const rawTimeout = values["--timeout-ms"];
  const timeoutMs =
    rawTimeout === undefined ? DEFAULT_TIMEOUT_MS : parseTimeout(rawTimeout);
  if (timeoutMs === null) {
    return fail(
      "invalid_timeout",
      `--timeout-ms must be a whole number from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}.`,
    );
  }

  return { ok: true, command: "doctor", origin, timeoutMs, json };
}

// --url, --workspace and --agent-token-file, shared by the read commands and
// experiments: { ok: true, origin, workspace, agentTokenFile } or a failure.
// --workspace names a workspace by its slug (on its Settings page, and in
// "metergraph context"), by its name, or by its ID. Returns { workspace,
// workspaceText }: workspace is an ID, workspaceText a slug or name, which is
// matched against the workspace the service reports. null for a bad value.
function workspaceOption(raw) {
  if (raw === undefined) return { workspace: null, workspaceText: null };
  if (UUID.test(raw)) return { workspace: raw.toLowerCase(), workspaceText: null };
  const text = raw.trim();
  if (text.length === 0 || text.length > MAX_WORKSPACE_TEXT || hasUnsafeText(text)) return null;
  return { workspace: null, workspaceText: text };
}
const MAX_WORKSPACE_TEXT = 200;
const INVALID_WORKSPACE =
  "--workspace takes the workspace's slug, shown on its Settings page and by \"metergraph context\", or its name.";

function parseKeyTarget(values, fail) {
  let origin = null;
  if (values["--url"] !== undefined) {
    origin = parseOrigin(values["--url"]);
    if (origin === null) return fail("invalid_url", INVALID_URL);
  }
  const named = workspaceOption(values["--workspace"]);
  if (named === null) return fail("invalid_workspace", INVALID_WORKSPACE);
  const agentTokenFile = values["--agent-token-file"] ?? null;
  if (agentTokenFile !== null && (agentTokenFile === "" || agentTokenFile.includes("\0"))) {
    return fail("invalid_agent_token_file", "--agent-token-file must name a private absolute file.");
  }
  return {
    ok: true,
    origin,
    ...named,
    agentTokenFile,
  };
}

// tools list [--name TOOL] | call TOOL [--args JSON | --args-file PATH] [--yes].
// The credential options are the read commands'. Arguments are checked for
// shape only; the service validates them against the tool's schema.
function parseTools(action, toolName, values, flags, json, fail) {
  if (action === null) {
    return fail("missing_subcommand", 'tools requires a subcommand: list or call. Run "metergraph help tools" for usage.');
  }
  const allowed = action === "list" ? ["--name"] : ["--args", "--args-file"];
  for (const name of Object.keys(values)) {
    if (!READ_BASE.includes(name) && !READ_KEY.includes(name) && !allowed.includes(name)) {
      return fail("unknown_argument", `tools ${action} does not take ${name}. Run "metergraph help tools" for usage.`);
    }
  }
  if (action === "list" && flags.has("--yes")) {
    return fail("unknown_argument", 'tools list does not take --yes. Run "metergraph help tools" for usage.');
  }
  const name = action === "list" ? values["--name"] ?? null : toolName;
  if (action === "call" && name === null) {
    return fail("missing_tool", 'tools call needs a tool name, such as metergraph_list_classified_workloads. Run "metergraph tools list" to see them.');
  }
  if (name !== null && !TOOL_NAME.test(name)) {
    return fail("invalid_tool", "A tool name is metergraph_ followed by lower case letters, digits and underscores.");
  }
  if (values["--args"] !== undefined && values["--args-file"] !== undefined) {
    return fail("conflicting_options", "Give --args or --args-file, not both.");
  }
  if (values["--args"] !== undefined && Buffer.byteLength(values["--args"]) > TOOL_ARGS_MAX_BYTES) {
    return fail("args_too_large", "--args is larger than 1 MiB. Use --args-file.");
  }
  if (values["--args-file"] !== undefined && (values["--args-file"] === "" || values["--args-file"].includes("\0"))) {
    return fail("invalid_args_file", "--args-file must name a file.");
  }
  const paths = parsePaths(values, fail);
  if (!paths.ok) return paths;
  const rawTimeout = values["--timeout-ms"];
  const timeoutMs = rawTimeout === undefined
    ? READ_DEFAULT_TIMEOUT_MS
    : parseTimeout(rawTimeout, READ_MIN_TIMEOUT_MS, READ_MAX_TIMEOUT_MS);
  if (timeoutMs === null) {
    return fail("invalid_timeout", `--timeout-ms must be a whole number from ${READ_MIN_TIMEOUT_MS} to ${READ_MAX_TIMEOUT_MS}.`);
  }
  const target = parseKeyTarget(values, fail);
  if (!target.ok) return target;
  delete target.ok;
  return {
    ok: true, command: "tools", action, ...target, project: paths.project, configDir: paths.configDir, timeoutMs, json,
    tool: { name, args: values["--args"] ?? null, argsFile: values["--args-file"] ?? null, yes: flags.has("--yes") },
  };
}

// experiments list | estimate | start | get. estimate and start take the same
// request, so an agent starts exactly what it priced: the workload, 1 to 3
// --treatment PROVIDER/MODEL[,label=..][,temperature=..][,max_tokens=..]
// [,reasoning_effort=..], and optionally --last-n, --sample-model and up to ten
// --track JSON paths. The service validates every request in full; these
// checks only refuse what it would refuse before anything is sent.
function parseExperiments(action, values, json, fail) {
  if (action === null) {
    return fail(
      "missing_subcommand",
      'experiments requires a subcommand: list, estimate, start or get. Run "metergraph help experiments" for usage.',
    );
  }
  for (const name of Object.keys(values)) {
    if (!READ_BASE.includes(name) && !READ_KEY.includes(name) && !EXPERIMENT_OPTIONS[action].has(name)) {
      return fail("unknown_argument", `experiments ${action} does not take ${name}. Run "metergraph help experiments" for usage.`);
    }
  }
  const paths = parsePaths(values, fail);
  if (!paths.ok) return paths;
  const rawTimeout = values["--timeout-ms"];
  const timeoutMs = rawTimeout === undefined
    ? READ_DEFAULT_TIMEOUT_MS
    : parseTimeout(rawTimeout, READ_MIN_TIMEOUT_MS, READ_MAX_TIMEOUT_MS);
  if (timeoutMs === null) {
    return fail("invalid_timeout", `--timeout-ms must be a whole number from ${READ_MIN_TIMEOUT_MS} to ${READ_MAX_TIMEOUT_MS}.`);
  }
  const target = parseKeyTarget(values, fail);
  if (!target.ok) return target;
  delete target.ok;
  const parsed = {
    ok: true, command: "experiments", action, ...target, project: paths.project, configDir: paths.configDir,
    timeoutMs, json, experiment: { id: null, workloadId: null, limit: null, request: null },
  };
  const workload = values["--workload"];
  if (workload !== undefined && !experimentText(workload, EXPERIMENT_TEXT_LIMITS.workload)) {
    return fail("invalid_workload", `--workload must be 1 to ${EXPERIMENT_TEXT_LIMITS.workload} characters without control characters.`);
  }
  if (action === "get") {
    const id = values["--id"];
    if (id === undefined || !UUID.test(id)) return fail("invalid_experiment_id", "--id must be an experiment ID in UUID form.");
    parsed.experiment.id = id.toLowerCase();
    return parsed;
  }
  if (action === "list") {
    const limit = values["--limit"] === undefined
      ? EXPERIMENT_LIST_DEFAULT_LIMIT
      : parseBounded(values["--limit"], 1, EXPERIMENT_LIST_MAX_LIMIT);
    if (limit === null) return fail("invalid_limit", `--limit must be a whole number from 1 to ${EXPERIMENT_LIST_MAX_LIMIT}.`);
    // The exact query list sends, so an over-long one fails here and not after sign in.
    const query = new URLSearchParams({ ...(workload === undefined ? {} : { workload_id: workload }), limit: String(limit) });
    if (query.toString().length > MAX_QUERY_LENGTH) {
      return fail("query_too_long", "--workload is too long to send in one request once encoded.");
    }
    parsed.experiment.workloadId = workload ?? null;
    parsed.experiment.limit = limit;
    return parsed;
  }
  if (workload === undefined) return fail("missing_workload", "--workload is required: the workload (route) whose calls to replay.");
  const specs = values["--treatment"] ?? [];
  if (specs.length < 1 || specs.length > EXPERIMENT_MAX_TREATMENTS) {
    return fail("invalid_treatments", `Give 1 to ${EXPERIMENT_MAX_TREATMENTS} --treatment values.`);
  }
  const treatments = [];
  for (const spec of specs) {
    const treatment = parseTreatment(spec);
    if (treatment === null) {
      return fail(
        "invalid_treatment",
        "--treatment must be PROVIDER/MODEL, optionally followed by ,label=NAME ,temperature=0..2 " +
          `,max_tokens=1..${EXPERIMENT_MAX_TOKENS} or ,reasoning_effort=${EXPERIMENT_REASONING_EFFORTS.join("|")}.`,
      );
    }
    treatments.push(treatment);
  }
  const labels = treatments.map((treatment) => treatment.label).filter((label) => label !== undefined);
  if (new Set(labels.map((label) => label.toLowerCase())).size !== labels.length ||
      labels.some((label) => label.toLowerCase() === "control")) {
    return fail("invalid_treatments", 'Treatment labels must be unique and cannot be "control".');
  }
  const sample = { last_n: EXPERIMENT_LAST_N.default };
  if (values["--last-n"] !== undefined) {
    sample.last_n = parseBounded(values["--last-n"], EXPERIMENT_LAST_N.min, EXPERIMENT_LAST_N.max);
    if (sample.last_n === null) {
      return fail("invalid_last_n", `--last-n must be a whole number from ${EXPERIMENT_LAST_N.min} to ${EXPERIMENT_LAST_N.max}.`);
    }
  }
  if (values["--sample-model"] !== undefined) {
    if (!experimentText(values["--sample-model"], EXPERIMENT_TEXT_LIMITS.model)) {
      return fail("invalid_sample_model", `--sample-model must be 1 to ${EXPERIMENT_TEXT_LIMITS.model} characters without control characters.`);
    }
    sample.model = values["--sample-model"];
  }
  const tracked = values["--track"] ?? [];
  if (tracked.length > EXPERIMENT_MAX_TRACKED_FIELDS ||
      tracked.some((field) => !experimentText(field, EXPERIMENT_TEXT_LIMITS.path) || !field.startsWith("$"))) {
    return fail("invalid_tracked_fields", `Give at most ${EXPERIMENT_MAX_TRACKED_FIELDS} --track JSON paths, each starting with $.`);
  }
  parsed.experiment.request = { workload_id: workload, sample, treatments, tracked_fields: [...new Set(tracked)] };
  for (const [option, field] of [["--request-key", "request_key"], ["--consent-id", "consent_id"]]) {
    if (values[option] !== undefined) {
      if (!UUID.test(values[option])) return fail("invalid_consent_identifier", `${option} must be a UUID.`);
      parsed.experiment.request[field] = values[option].toLowerCase();
    }
  }
  if (parsed.experiment.request.consent_id && !parsed.experiment.request.request_key) {
    return fail("missing_request_key", "--consent-id requires the original --request-key.");
  }
  return parsed;
}

function experimentText(value, max) {
  return typeof value === "string" && value.trim() === value && value.length > 0 && value.length <= max && !hasUnsafeText(value);
}

const TREATMENT_KEYS = new Set(["label", "temperature", "max_tokens", "reasoning_effort"]);

// PROVIDER/MODEL[,key=value...] as a treatment, or null. The model may itself
// contain "/" (a gateway ID such as anthropic/claude-haiku-4.5).
function parseTreatment(spec) {
  const [head, ...options] = spec.split(",");
  const slash = head.indexOf("/");
  if (slash <= 0) return null;
  const provider = head.slice(0, slash);
  const model = head.slice(slash + 1);
  if (!experimentText(provider, EXPERIMENT_TEXT_LIMITS.provider) || !experimentText(model, EXPERIMENT_TEXT_LIMITS.model)) {
    return null;
  }
  const treatment = { provider, model };
  const settings = {};
  for (const option of options) {
    const equals = option.indexOf("=");
    const key = option.slice(0, equals);
    const value = option.slice(equals + 1);
    if (equals <= 0 || !TREATMENT_KEYS.has(key) || Object.hasOwn(settings, key) || (key === "label" && treatment.label !== undefined)) {
      return null;
    }
    if (key === "label") {
      if (!experimentText(value, EXPERIMENT_TEXT_LIMITS.label)) return null;
      treatment.label = value;
    } else if (key === "temperature") {
      if (!/^(?:[0-1](?:\.[0-9]{1,3})?|2(?:\.0{1,3})?)$/.test(value)) return null;
      settings.temperature = Number(value);
    } else if (key === "max_tokens") {
      const tokens = /^[0-9]{1,5}$/.test(value) ? Number(value) : 0;
      if (tokens < 1 || tokens > EXPERIMENT_MAX_TOKENS) return null;
      settings.max_tokens = tokens;
    } else {
      if (!EXPERIMENT_REASONING_EFFORTS.includes(value)) return null;
      settings.reasoning_effort = value;
    }
  }
  if (Object.keys(settings).length > 0) treatment.settings = settings;
  return treatment;
}

function parseVerify(values, flags, json, fail) {
  const paths = parsePaths(values, fail);
  if (!paths.ok) return paths;
  const traceId = values["--trace-id"] ?? null;
  const requestId = values["--request-id"] ?? null;
  if ((traceId === null) === (requestId === null) ||
      !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/.test(traceId ?? requestId)) {
    return fail("invalid_trace_identity", "Provide exactly one --trace-id or --request-id (1 to 200 safe characters).");
  }
  const since = values["--since"];
  const until = values["--until"];
  const validTime = (value) => typeof value === "string" && value.length <= 40 &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) && Number.isFinite(Date.parse(value));
  if (!validTime(since) || !validTime(until) || Date.parse(since) > Date.parse(until) || Date.parse(until) > Date.now()) {
    return fail("invalid_invocation_window", "--since and --until must bound a past invocation using ISO 8601 timestamps.");
  }
  const source = values["--source"] ?? "unspecified";
  if (!["application", "synthetic", "demo", "import", "unspecified"].includes(source)) {
    return fail("invalid_source", "--source must be application, synthetic, demo, import or unspecified.");
  }
  const days = values["--days"] === undefined ? undefined : parseBounded(values["--days"], 1, 90);
  if (days === null) return fail("invalid_days", "--days must be a whole number from 1 to 90.");
  const timeoutMs = values["--timeout-ms"] === undefined ? 30000 : parseTimeout(values["--timeout-ms"], 100, 60000);
  if (timeoutMs === null) return fail("invalid_timeout", "--timeout-ms must be a whole number from 100 to 60000.");
  const pollIntervalMs = values["--poll-ms"] === undefined ? 1000 : parseTimeout(values["--poll-ms"], 100, 10000);
  if (pollIntervalMs === null) return fail("invalid_poll_interval", "--poll-ms must be a whole number from 100 to 10000.");
  const maxAttempts = values["--max-attempts"] === undefined ? 30 : parseBounded(values["--max-attempts"], 1, 60);
  if (maxAttempts === null) return fail("invalid_max_attempts", "--max-attempts must be a whole number from 1 to 60.");
  return { ok: true, command: "verify", project: paths.project, configDir: paths.configDir,
    traceId, requestId, since, until, source, days, timeoutMs, pollIntervalMs, maxAttempts,
    open: flags.has("--open"), noBrowser: flags.has("--no-browser"), json };
}

// The client is required, so a script states which client loads the skill.
// The runtime defaults to local, the runtime setup installs the skill for;
// pass --runtime cloud for a cloud checkout. Values for clients and runtimes
// that cannot use project skill files are accepted here and handed off later.
function parseSkill(action, values, json, fail) {
  if (action === null) {
    return fail(
      "missing_subcommand",
      'skill requires a subcommand: install or update. Run "metergraph help skill" for usage.',
    );
  }
  const client = values["--client"];
  if (client === undefined) {
    return fail("missing_client", "--client is required. Use codex, claude or cursor.");
  }
  if (!Object.hasOwn(SKILL_CLIENTS, client) && !Object.hasOwn(HANDOFF_SKILL_CLIENTS, client)) {
    return fail("invalid_client", "--client must be codex, claude or cursor.");
  }
  const runtime = values["--runtime"] ?? "local";
  if (!SKILL_RUNTIMES.includes(runtime) && !HANDOFF_SKILL_RUNTIMES.includes(runtime)) {
    return fail("invalid_runtime", "--runtime must be local or cloud.");
  }
  const project = values["--project"];
  if (project !== undefined && (project === "" || project.includes("\0"))) {
    return fail("invalid_project", "--project must name an existing directory.");
  }
  return { ok: true, command: "skill", action, client, runtime, project: project ?? null, json };
}

// skills install and update take the same options as skill. list is read
// only and takes just --project.
function parseSkills(action, values, json, fail) {
  if (action === null) {
    return fail(
      "missing_subcommand",
      'skills requires a subcommand: install, update or list. Run "metergraph help skills" for usage.',
    );
  }
  if (action === "list") {
    if (values["--client"] !== undefined || values["--runtime"] !== undefined) {
      return fail("unexpected_option", "skills list takes only --project. It reports every client.");
    }
    const project = values["--project"];
    if (project !== undefined && (project === "" || project.includes("\0"))) {
      return fail("invalid_project", "--project must name an existing directory.");
    }
    return { ok: true, command: "skills", action, client: null, runtime: null, project: project ?? null, json };
  }
  const parsed = parseSkill(action, values, json, fail);
  return parsed.ok ? { ...parsed, command: "skills" } : parsed;
}

const INVALID_URL =
  "--url must be a bare https origin such as https://metergraph.example.com, " +
  "or an http origin on localhost, 127.0.0.1 or [::1]. " +
  "Credentials, paths, queries and fragments are not accepted.";

function parseUrlOption(values) {
  const raw = values["--url"];
  return raw === undefined ? DEFAULT_ORIGIN : parseOrigin(raw);
}

// The runtime is required so a script states where the browser is. Cloud
// runtimes are accepted here and handed off later, before any request.
function parseLogin(values, flags, json, fail) {
  const runtime = values["--runtime"];
  if (runtime === undefined) return fail("missing_runtime", "--runtime is required. Use local.");
  if (!LOGIN_RUNTIMES.includes(runtime) && !HANDOFF_LOGIN_RUNTIMES.includes(runtime)) {
    return fail("invalid_runtime", "--runtime must be local, cloud or cloud-no-shell.");
  }
  const origin = parseUrlOption(values);
  if (origin === null) return fail("invalid_url", INVALID_URL);
  const named = workspaceOption(values["--workspace"]);
  if (named === null) return fail("invalid_workspace", INVALID_WORKSPACE);
  const role = values["--role"] ?? "metadata";
  if (!LOGIN_ROLES.includes(role)) return fail("invalid_role", "--role must be metadata or debug.");
  const permissions = LOGIN_PERMISSIONS.filter(([flag]) => flags.has(flag)).map(([, scope]) => scope);
  if (permissions.length > 0 && role !== "debug") {
    return fail(
      "permission_needs_debug",
      "--allow-evaluation-writes, --allow-evaluation-previews and --allow-analysis-starts need --role debug.",
    );
  }
  const paths = parsePaths(values, fail);
  if (!paths.ok) return paths;
  const rawTimeout = values["--timeout-ms"];
  const timeoutMs =
    rawTimeout === undefined
      ? LOGIN_DEFAULT_TIMEOUT_MS
      : parseTimeout(rawTimeout, LOGIN_MIN_TIMEOUT_MS, LOGIN_MAX_TIMEOUT_MS);
  if (timeoutMs === null) {
    return fail(
      "invalid_timeout",
      `--timeout-ms must be a whole number from ${LOGIN_MIN_TIMEOUT_MS} to ${LOGIN_MAX_TIMEOUT_MS}.`,
    );
  }
  return {
    ok: true,
    command: "login",
    runtime,
    origin,
    ...named,
    role,
    permissions,
    project: paths.project,
    configDir: paths.configDir,
    timeoutMs,
    signup: flags.has("--signup"),
    noBrowser: flags.has("--no-browser"),
    reconnect: flags.has("--reconnect"),
    json,
  };
}

function parseSetup(values, flags, json, fail) {
  const runtime = values["--runtime"];
  if (runtime === undefined) return fail("missing_runtime", "--runtime is required. Use local.");
  if (!LOGIN_RUNTIMES.includes(runtime) && !HANDOFF_LOGIN_RUNTIMES.includes(runtime)) {
    return fail("invalid_runtime", "--runtime must be local, cloud or cloud-no-shell.");
  }
  const paths = parsePaths(values, fail);
  if (!paths.ok) return paths;
  const origin = parseUrlOption(values);
  if (origin === null) return fail("invalid_url", INVALID_URL);
  const deployment = values["--deployment"] ?? "managed";
  if (!["managed", "customer-local", "byoc", "oss"].includes(deployment)) {
    return fail("invalid_deployment", "--deployment must be managed, customer-local, byoc or oss.");
  }
  if (deployment === "managed" && (flags.has("--confirm-prerequisites") || values["--agent-token-file"] !== undefined)) {
    return fail("managed_route_conflict", "Operator prerequisites and agent token files are only for non-hosted deployments.");
  }
  if (deployment !== "managed" && values["--url"] === undefined) {
    return fail("non_hosted_origin_required", "Non-hosted setup requires an explicit --url for the installed service.");
  }
  const rawWorkspace = values["--workspace"];
  if (rawWorkspace !== undefined && !UUID.test(rawWorkspace)) {
    return fail("invalid_workspace", "--workspace must be a workspace ID in UUID form.");
  }
  if (deployment !== "managed" && rawWorkspace === undefined) {
    return fail("non_hosted_workspace_required", "Non-hosted setup requires an explicit --workspace UUID.");
  }
  const agentTokenFile = values["--agent-token-file"] ?? null;
  if (agentTokenFile !== null && (agentTokenFile === "" || agentTokenFile.includes("\0"))) {
    return fail("invalid_agent_token_file", "--agent-token-file must name a private absolute file.");
  }
  const client = values["--client"] ?? null;
  if (client === null && !flags.has("--skip-skill")) {
    return fail("client_required", "Choose --client codex, claude or cursor, or explicitly use --skip-skill.");
  }
  if (client !== null && !Object.hasOwn(SKILL_CLIENTS, client)) {
    return fail("invalid_client", "--client must be codex, claude or cursor.");
  }
  if (client !== null && flags.has("--skip-skill")) {
    return fail("client_conflict", "Use either --client or --skip-skill, not both.");
  }
  const envFile = values["--env-file"] ?? ".env";
  if (envFile === "" || envFile.includes("\0")) return fail("invalid_env_file", "--env-file must name a project-relative env file.");
  const rawRepository = values["--repository"];
  const repository = rawRepository === undefined ? null : parseRepository(rawRepository);
  if (rawRepository !== undefined && repository === null) {
    return fail("invalid_repository", "--repository must be owner/name, for example example-org/example-app.");
  }
  if (repository !== null && flags.has("--no-repository")) {
    return fail("repository_conflict", "Use either --repository or --no-repository, not both.");
  }
  const rawTimeout = values["--timeout-ms"];
  const timeoutMs = rawTimeout === undefined ? LOGIN_DEFAULT_TIMEOUT_MS :
    parseTimeout(rawTimeout, LOGIN_MIN_TIMEOUT_MS, LOGIN_MAX_TIMEOUT_MS);
  if (timeoutMs === null) return fail("invalid_timeout", `--timeout-ms must be a whole number from ${LOGIN_MIN_TIMEOUT_MS} to ${LOGIN_MAX_TIMEOUT_MS}.`);
  return { ok: true, command: "setup", runtime, origin, originExplicit: values["--url"] !== undefined,
    deployment, deploymentExplicit: values["--deployment"] !== undefined,
    confirmPrerequisites: flags.has("--confirm-prerequisites"), agentTokenFile,
    workspace: rawWorkspace === undefined ? null : rawWorkspace.toLowerCase(),
    project: paths.project, configDir: paths.configDir, envFile, client, skipSkill: flags.has("--skip-skill"),
    timeoutMs, noBrowser: flags.has("--no-browser"), repair: flags.has("--repair"),
    signup: flags.has("--signup"), reconnect: flags.has("--reconnect"),
    repository, skipRepository: flags.has("--no-repository"), json };
}

// Read commands take the project and config directory, one total timeout and,
// where the endpoint supports them, bounded days, limit and trace filters.
// Out of range values fail here; nothing is clamped.
function parseRead(command, values, flags, json, fail) {
  const paths = parsePaths(values, fail);
  if (!paths.ok) return paths;
  const rawTimeout = values["--timeout-ms"];
  const timeoutMs =
    rawTimeout === undefined
      ? READ_DEFAULT_TIMEOUT_MS
      : parseTimeout(rawTimeout, READ_MIN_TIMEOUT_MS, READ_MAX_TIMEOUT_MS);
  if (timeoutMs === null) {
    return fail(
      "invalid_timeout",
      `--timeout-ms must be a whole number from ${READ_MIN_TIMEOUT_MS} to ${READ_MAX_TIMEOUT_MS}.`,
    );
  }
  const takesDays = command === "usage" || command === "traces";
  const takesLimit = takesDays || command === "routes";
  let days = null;
  if (takesDays) {
    days = values["--days"] === undefined ? READ_DEFAULT_DAYS : parseBounded(values["--days"], 1, READ_MAX_DAYS);
    if (days === null) return fail("invalid_days", `--days must be a whole number from 1 to ${READ_MAX_DAYS}.`);
  }
  let limit = null;
  if (takesLimit) {
    const fallback = command === "traces" ? TRACES_DEFAULT_LIMIT : READ_DEFAULT_LIMIT;
    limit = values["--limit"] === undefined ? fallback : parseBounded(values["--limit"], 1, READ_MAX_LIMIT);
    if (limit === null) return fail("invalid_limit", `--limit must be a whole number from 1 to ${READ_MAX_LIMIT}.`);
  }
  // Where to read and with which key: the same for every read, grouped usage
  // included.
  const target = parseKeyTarget(values, fail);
  if (!target.ok) return target;
  delete target.ok;
  if (command === "usage" && (USAGE_GROUPED.some((name) => values[name] !== undefined) || flags.has("--today"))) {
    return parseGroupedUsage(values, flags, json, fail, { paths, timeoutMs, limit, target });
  }
  const route = values["--route"] ?? null;
  if (route !== null && !isSafeFilter(route)) {
    return fail("invalid_route", "--route must be 1 to 256 characters without control characters.");
  }
  const status = values["--status"] ?? null;
  if (status !== null && status !== "success" && status !== "error") {
    return fail("invalid_status", "--status must be success or error.");
  }
  const cursor = values["--cursor"] ?? null;
  if (cursor !== null && !isCursor(cursor)) {
    return fail(
      "invalid_cursor",
      "--cursor must be the next_cursor value from an earlier traces result, at most 512 printable characters.",
    );
  }
  const metadata = parseMetadata(values, fail);
  if (!metadata.ok) return metadata;
  const parsed = {
    ok: true,
    command,
    ...target,
    project: paths.project,
    configDir: paths.configDir,
    timeoutMs,
    days,
    limit,
    route,
    status,
    cursor,
    metadata: metadata.filters,
    groupByMetadata: null,
    json,
  };
  // Measure the exact query the command will send (URLSearchParams encoding,
  // every parameter), so an over-long one fails here and not after sign in.
  const query = readQuery(parsed);
  if (query !== null && query.toString().length > MAX_QUERY_LENGTH) {
    return fail(
      "query_too_long",
      "The filters are too long to send in one request. Use fewer or shorter metadata values, or a shorter route or cursor.",
    );
  }
  return parsed;
}

// Grouped usage: server-side groups by provider, model, route and UTC day,
// with exact filters and a UTC window. The window is either a preset of whole
// UTC days (--days N or --today: the current UTC day so far and the N - 1
// whole UTC days before it) or an explicit --since/--until, never both.
// Ranking other than by cost and the prior-period comparison are computed
// from the returned groups and say when those groups are not all of them.
function parseGroupedUsage(values, flags, json, fail, { paths, timeoutMs, limit, target }) {
  // A "metadata.<key>" entry takes the rest of the value as the key, so a key
  // may contain commas and dots; it must come last. --group-by-metadata KEY
  // is the same dimension, appended last.
  let groupBy = values["--group-by"] === undefined && values["--group-by-metadata"] !== undefined
    ? []
    : [...USAGE_DEFAULT_GROUP_BY];
  if (values["--group-by"] !== undefined) {
    const raw = values["--group-by"];
    const at = raw.startsWith(METADATA_PREFIX) ? 0 : raw.indexOf(`,${METADATA_PREFIX}`);
    const plain = at === -1 ? raw : raw.slice(0, Math.max(0, at));
    const metadataPart = at === -1 ? null : raw.slice(at === 0 ? 0 : at + 1);
    const parts = plain === "" ? [] : plain.split(",").map((part) => part.trim());
    if (
      (parts.length === 0 && metadataPart === null) ||
      !parts.every((part) => USAGE_DIMENSIONS.includes(part)) ||
      new Set(parts).size !== parts.length
    ) {
      return fail(
        "invalid_group_by",
        `--group-by must list distinct dimensions from ${USAGE_DIMENSIONS.join(", ")}, comma separated, ` +
          "optionally ending with metadata.KEY.",
      );
    }
    groupBy = metadataPart === null ? parts : [...parts, metadataPart];
  }
  if (values["--group-by-metadata"] !== undefined) {
    if (groupBy.some((dimension) => dimension.startsWith(METADATA_PREFIX))) {
      return fail("too_many_metadata_dimensions", "Group by at most one metadata key.");
    }
    groupBy = [...groupBy, `${METADATA_PREFIX}${values["--group-by-metadata"]}`];
  }
  const metadataDimension = groupBy.find((dimension) => dimension.startsWith(METADATA_PREFIX)) ?? null;
  if (metadataDimension !== null) {
    const problem = metadataKeyProblem(metadataDimension.slice(METADATA_PREFIX.length));
    if (problem !== null) return fail(problem.code, `A metadata grouping key ${problem.message}`);
  }
  const filters = {};
  for (const [option, key] of [["--route", "route"], ["--provider", "provider"], ["--model", "model"], ["--environment", "environment"]]) {
    const list = values[option] ?? [];
    if (list.length > USAGE_MAX_FILTER_VALUES) {
      return fail("too_many_filter_values", `${option} may be given at most ${USAGE_MAX_FILTER_VALUES} times.`);
    }
    if (!list.every((value) => isSafeFilter(value) && value.trim() !== "")) {
      return fail(`invalid_${key}`, `${option} must be 1 to 256 characters without control characters.`);
    }
    filters[key] = list.length === 0 ? null : [...new Set(list)];
  }
  const today = flags.has("--today");
  const rawSince = values["--since"];
  const rawUntil = values["--until"];
  const explicit = rawSince !== undefined || rawUntil !== undefined;
  if ([today, explicit, values["--days"] !== undefined].filter(Boolean).length > 1) {
    return fail("window_conflict", "Use one window: --days N, --today, or --since with an optional --until.");
  }
  let days = null;
  let since = null;
  let until = null;
  if (explicit) {
    if (rawSince === undefined) return fail("invalid_window", "--until needs --since.");
    since = utcInstant(rawSince);
    until = rawUntil === undefined ? null : utcInstant(rawUntil);
    if (since === null || (rawUntil !== undefined && until === null)) {
      return fail(
        "invalid_window",
        "--since and --until must be a UTC date (YYYY-MM-DD, meaning 00:00 UTC) or an ISO 8601 timestamp with Z or an offset.",
      );
    }
    const end = until === null ? Date.now() : Date.parse(until);
    if (Date.parse(since) >= end) return fail("invalid_window", "--since must be before --until (or before now).");
    if (end - Date.parse(since) > READ_MAX_DAYS * DAY_MS) {
      return fail("invalid_window", `The window may span at most ${READ_MAX_DAYS} days.`);
    }
  } else {
    days = today ? 1 : values["--days"] === undefined ? READ_DEFAULT_DAYS : parseBounded(values["--days"], 1, READ_MAX_DAYS);
    if (days === null) return fail("invalid_days", `--days must be a whole number from 1 to ${READ_MAX_DAYS}.`);
  }
  const sort = values["--sort"] ?? (groupBy.length === 1 && groupBy[0] === "day" ? "day" : "cost");
  if (!USAGE_SORTS.includes(sort)) return fail("invalid_sort", `--sort must be one of ${USAGE_SORTS.join(", ")}.`);
  if (sort === "day" && !groupBy.includes("day")) {
    return fail("invalid_sort", "--sort day needs day in --group-by.");
  }
  const compare = values["--compare"] ?? null;
  if (compare !== null && !USAGE_COMPARISONS.includes(compare)) {
    return fail("invalid_compare", `--compare must be ${USAGE_COMPARISONS.join(" or ")}.`);
  }
  if (compare !== null && groupBy.includes("day")) {
    return fail(
      "compare_with_day_grouping",
      "--compare matches groups across two windows, and a UTC day is never in both. " +
        "For a trend, use --group-by day without --compare.",
    );
  }
  const metadata = parseMetadata(values, fail);
  if (!metadata.ok) return metadata;
  const parsed = {
    ok: true,
    command: "usage",
    ...target,
    project: paths.project,
    configDir: paths.configDir,
    timeoutMs,
    days,
    limit,
    route: null,
    status: null,
    cursor: null,
    metadata: metadata.filters,
    groupByMetadata: metadataDimension === null ? null : metadataDimension.slice(METADATA_PREFIX.length),
    grouped: { groupBy, filters, since, until, today, sort, compare },
    json,
  };
  // Measure the exact query the read sends, and for --compare the prior
  // window's query, which carries two timestamps.
  const longest = [readQuery(parsed)];
  if (compare !== null) {
    const stamp = "0000-00-00T00:00:00.000Z";
    longest.push(readQuery(parsed, { ...groupedRequest(parsed), days: null, since: stamp, until: stamp }));
  }
  if (longest.some((query) => query.toString().length > MAX_QUERY_LENGTH)) {
    return fail(
      "query_too_long",
      "The filters are too long to send in one request. Use fewer or shorter --route, --provider, --model, " +
        "--environment or --metadata values.",
    );
  }
  return parsed;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const METADATA_PREFIX = "metadata.";
const UTC_DATE = /^\d{4}-\d{2}-\d{2}$/;
const ZONED_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,6})?)?(?:Z|[+-]\d{2}:\d{2})$/;

// A window bound as a UTC ISO 8601 string, or null. A date alone is 00:00
// UTC; a timestamp must carry Z or an offset, so a local time is never read
// as UTC by accident.
function utcInstant(raw) {
  if (typeof raw !== "string" || raw.length > 40) return null;
  const text = UTC_DATE.test(raw) ? `${raw}T00:00:00Z` : ZONED_TIME.test(raw) ? raw : null;
  if (text === null) return null;
  const parsed = Date.parse(text);
  if (!Number.isFinite(parsed)) return null;
  // Reject calendar values the parser would roll over, such as 2026-02-30 or
  // 2026-09-31T12:00:00Z, rather than read a different instant.
  const [year, month, day] = text.slice(0, 10).split("-").map(Number);
  const calendar = new Date(Date.UTC(year, month - 1, day));
  if (calendar.getUTCFullYear() !== year || calendar.getUTCMonth() !== month - 1 || calendar.getUTCDate() !== day) {
    return null;
  }
  const time = /T(\d{2}):(\d{2})(?::(\d{2}))?/.exec(text);
  if (time && (Number(time[1]) > 23 || Number(time[2]) > 59 || Number(time[3] ?? 0) > 59)) return null;
  const offset = /([+-])(\d{2}):(\d{2})$/.exec(text);
  if (offset && (Number(offset[2]) > 23 || Number(offset[3]) > 59)) return null;
  return new Date(parsed).toISOString();
}

// Exact customer-metadata filters. --metadata KEY=VALUE splits at the first
// "=", so a value may contain "=" and a key may not; --metadata-json takes one
// JSON object for keys with "=" or values that are awkward to quote. Values
// are opaque strings: nothing is trimmed, case folded or split on a prefix.
// Returns filters sorted by key, or null when none were given.
function parseMetadata(values, fail) {
  const pairs = values["--metadata"] ?? [];
  const raw = values["--metadata-json"];
  if (pairs.length > 0 && raw !== undefined) {
    return fail("metadata_conflict", "Use --metadata or --metadata-json, not both.");
  }
  const entries = [];
  if (raw !== undefined) {
    let parsed;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return fail("invalid_metadata", '--metadata-json must be a JSON object such as {"prompt_id":"p-1"}.');
    }
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return fail("invalid_metadata", '--metadata-json must be a JSON object such as {"prompt_id":"p-1"}.');
    }
    if (duplicateJsonKey(raw)) {
      return fail("duplicate_metadata_key", "A metadata key may be given only once.");
    }
    entries.push(...Object.entries(parsed));
  } else {
    for (const pair of pairs) {
      const equals = pair.indexOf("=");
      if (equals <= 0) {
        return fail(
          "invalid_metadata",
          "--metadata must be KEY=VALUE with a non-empty key. Use --metadata-json for a key that contains \"=\".",
        );
      }
      entries.push([pair.slice(0, equals), pair.slice(equals + 1)]);
    }
  }
  if (entries.length === 0) return { ok: true, filters: null };
  if (entries.length > MAX_METADATA_FILTERS) {
    return fail("too_many_metadata_filters", `At most ${MAX_METADATA_FILTERS} metadata keys may be given.`);
  }
  const seen = new Set();
  for (const [key, value] of entries) {
    const problem = metadataKeyProblem(key);
    if (problem !== null) return fail(problem.code, `A metadata key ${problem.message}`);
    if (seen.has(key)) return fail("duplicate_metadata_key", "A metadata key may be given only once.");
    seen.add(key);
    if (typeof value !== "string") {
      return fail("invalid_metadata", "Metadata values must be strings; they are matched as exact opaque text.");
    }
    if (value.length > MAX_METADATA_VALUE_LENGTH || value.includes("\0")) {
      return fail(
        "invalid_metadata",
        `A metadata value must be at most ${MAX_METADATA_VALUE_LENGTH} characters without NUL.`,
      );
    }
  }
  const filters = entries
    .map(([key, value]) => ({ key, value }))
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { ok: true, filters };
}

// JSON.parse keeps the last of two equal keys; the service refuses them, so
// the CLI refuses them first instead of silently sending one. Scans the
// already valid JSON text for the top-level object's keys.
function duplicateJsonKey(raw) {
  const keys = new Set();
  let depth = 0;
  for (let index = 0; index < raw.length; index += 1) {
    const char = raw[index];
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    else if (char === '"') {
      let end = index + 1;
      while (raw[end] !== '"') end += raw[end] === "\\" ? 2 : 1;
      const token = raw.slice(index, end + 1);
      let next = end + 1;
      while (/\s/.test(raw[next] ?? "")) next += 1;
      if (depth === 1 && raw[next] === ":") {
        const key = JSON.parse(token);
        if (keys.has(key)) return true;
        keys.add(key);
      }
      index = end;
    }
  }
  return false;
}

// Matches the service's rule: lowercased, everything but letters and digits
// removed, the key must not end in one of these.
const SENSITIVE_KEY_SUFFIXES = Object.freeze([
  "accesskey", "apikey", "auth", "authorization", "bearer", "clientsecret", "cookie",
  "credential", "credentials", "encryptionkey", "jwt", "passwd", "password", "privatekey",
  "secret", "secretkey", "sessionkey", "signingkey", "token",
]);

function metadataKeyProblem(key) {
  // Keys are printed back (filter and grouping lines), so control and
  // formatting characters that could rewrite terminal or log output are
  // refused, as they are for every other printed name.
  if (
    typeof key !== "string" ||
    key.length === 0 ||
    key.length > MAX_METADATA_KEY_LENGTH ||
    hasUnsafeText(key)
  ) {
    return {
      code: "invalid_metadata_key",
      message: `must be 1 to ${MAX_METADATA_KEY_LENGTH} characters without control or formatting characters.`,
    };
  }
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (SENSITIVE_KEY_SUFFIXES.some((suffix) => normalized.endsWith(suffix))) {
    return {
      code: "metadata_key_ineligible",
      message: "looks like a credential name and cannot be used for filtering or grouping.",
    };
  }
  return null;
}

function parseBounded(raw, min, max) {
  if (!/^[0-9]{1,3}$/.test(raw)) return null;
  const value = Number(raw);
  return value < min || value > max ? null : value;
}

function parsePaths(values, fail) {
  const project = values["--project"];
  if (project !== undefined && (project === "" || project.includes("\0"))) {
    return fail("invalid_project", "--project must name an existing directory.");
  }
  const configDir = values["--config-dir"];
  if (configDir !== undefined && (configDir === "" || configDir.includes("\0"))) {
    return fail("invalid_config_dir", "--config-dir must name a directory path.");
  }
  return { ok: true, project: project ?? null, configDir: configDir ?? null };
}

function parseTimeout(raw, min = MIN_TIMEOUT_MS, max = MAX_TIMEOUT_MS) {
  if (!/^[0-9]{1,6}$/.test(raw)) return null;
  const value = Number(raw);
  if (value < min || value > max) return null;
  return value;
}
