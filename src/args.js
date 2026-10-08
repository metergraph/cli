import { parseRepository } from "./repository-identity.js";
import {
  DEFAULT_ORIGIN,
  DEFAULT_TIMEOUT_MS,
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
} from "./constants.js";
import { parseOrigin } from "./origin.js";
import { isCursor, isSafeFilter } from "./read-contract.js";

export const READ_COMMANDS = Object.freeze(["status", "context", "capabilities", "usage", "routes", "traces"]);
const COMMANDS = new Set(["doctor", "help", "skill", "skills", "login", "logout", "setup", "verify", ...READ_COMMANDS]);
const HELP_TOPICS = new Set(["doctor", "skill", "skills", "login", "logout", "setup", "verify", ...READ_COMMANDS]);
const SKILL_ACTIONS = new Set(["install", "update"]);
const SKILLS_ACTIONS = new Set(["install", "update", "list"]);
const READ_BASE = ["--project", "--config-dir", "--timeout-ms"];
const OPTIONS = {
  doctor: new Set(["--url", "--timeout-ms"]),
  skill: new Set(["--client", "--runtime", "--project"]),
  skills: new Set(["--client", "--runtime", "--project"]),
  login: new Set(["--runtime", "--url", "--workspace", "--project", "--config-dir", "--timeout-ms"]),
  setup: new Set(["--runtime", "--url", "--workspace", "--project", "--config-dir", "--env-file", "--client", "--timeout-ms", "--deployment", "--agent-token-file", "--repository"]),
  logout: new Set(["--project", "--config-dir"]),
  status: new Set(READ_BASE),
  context: new Set(READ_BASE),
  capabilities: new Set(READ_BASE),
  usage: new Set([...READ_BASE, "--days", "--limit"]),
  routes: new Set([...READ_BASE, "--limit"]),
  traces: new Set([...READ_BASE, "--days", "--limit", "--route", "--status", "--cursor"]),
  verify: new Set([...READ_BASE, "--trace-id", "--request-id", "--since", "--until", "--source", "--days", "--poll-ms", "--max-attempts"]),
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
    "--environment is not supported: the service's agent access contract has no environment selector, " +
    "so the CLI never sends one. Results cover the bound workspace. No request was made.",
  workload_filter_unsupported:
    "--workload is not supported by this CLI version: it cannot verify from the returned traces that a " +
    "workload filter was applied, so it never sends one. No request was made.",
  time_range_unsupported:
    "--since and --until are not supported. Use --days N (1 to 90) for a window relative to now. No request was made.",
  query_unsupported:
    "Free-form queries are not supported. Use the fixed options of this command. No request was made.",
  content_access_unsupported:
    "Read commands return Metadata only. They never read retained content, debug data or replays. No request was made.",
};
// Options that take no value.
const FLAGS = {
  login: new Set(["--signup", "--no-browser", "--reconnect"]),
  setup: new Set(["--no-browser", "--repair", "--signup", "--reconnect", "--skip-skill", "--confirm-prerequisites", "--no-repository"]),
  verify: new Set(["--open", "--no-browser"]),
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

  if (argv.includes("--help") || argv.includes("-h")) {
    const topic = argv.find((arg) => HELP_TOPICS.has(arg)) ?? null;
    return { ok: true, command: "help", topic, json };
  }

  let command = null;
  let action = null;
  let topic = null;
  let version = false;
  const values = {};
  const flags = new Set();

  const fail = (code, message, outcome = "invalid_input") => ({
    ok: false,
    command: (command === "skill" || command === "skills") && action !== null
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
    if (command === "skill" && action === null && SKILL_ACTIONS.has(arg)) {
      action = arg;
      continue;
    }
    if (command === "skills" && action === null && SKILLS_ACTIONS.has(arg)) {
      action = arg;
      continue;
    }

    if (READ_COMMANDS.includes(command)) {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (Object.hasOwn(REFUSED, name)) {
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
    return fail(
      "unknown_argument",
      `Unrecognized argument at position ${position}. Run "metergraph --help" for usage.`,
    );
  }

  if (version) return { ok: true, command: "version", json };
  if (command === null || command === "help") {
    return { ok: true, command: "help", topic, json };
  }
  if (command === "skill") return parseSkill(action, values, json, fail);
  if (command === "skills") return parseSkills(action, values, json, fail);
  if (command === "login") return parseLogin(values, flags, json, fail);
  if (command === "setup") return parseSetup(values, flags, json, fail);
  if (command === "verify") return parseVerify(values, flags, json, fail);
  if (READ_COMMANDS.includes(command)) return parseRead(command, values, json, fail);
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

// Client and runtime are required, so a script states where the skill is
// used instead of the CLI guessing. Values for clients and runtimes that
// cannot use project skill files are accepted here and handed off later.
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
  const runtime = values["--runtime"];
  if (runtime === undefined) {
    return fail("missing_runtime", "--runtime is required. Use local or cloud.");
  }
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
  const rawWorkspace = values["--workspace"];
  if (rawWorkspace !== undefined && !UUID.test(rawWorkspace)) {
    return fail("invalid_workspace", "--workspace must be a workspace ID in UUID form.");
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
    workspace: rawWorkspace === undefined ? null : rawWorkspace.toLowerCase(),
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
    deployment, confirmPrerequisites: flags.has("--confirm-prerequisites"), agentTokenFile,
    workspace: rawWorkspace === undefined ? null : rawWorkspace.toLowerCase(),
    project: paths.project, configDir: paths.configDir, envFile, client, skipSkill: flags.has("--skip-skill"),
    timeoutMs, noBrowser: flags.has("--no-browser"), repair: flags.has("--repair"),
    signup: flags.has("--signup"), reconnect: flags.has("--reconnect"),
    repository, skipRepository: flags.has("--no-repository"), json };
}

// Read commands take the project and config directory, one total timeout and,
// where the endpoint supports them, bounded days, limit and trace filters.
// Out of range values fail here; nothing is clamped.
function parseRead(command, values, json, fail) {
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
  return {
    ok: true,
    command,
    project: paths.project,
    configDir: paths.configDir,
    timeoutMs,
    days,
    limit,
    route,
    status,
    cursor,
    json,
  };
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
