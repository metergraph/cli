import {
  DEFAULT_ORIGIN,
  DEFAULT_TIMEOUT_MS,
  HANDOFF_SKILL_CLIENTS,
  HANDOFF_SKILL_RUNTIMES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  SKILL_CLIENTS,
  SKILL_RUNTIMES,
} from "./constants.js";
import { parseOrigin } from "./origin.js";

const COMMANDS = new Set(["doctor", "help", "skill"]);
const HELP_TOPICS = new Set(["doctor", "skill"]);
const SKILL_ACTIONS = new Set(["install", "update"]);
const OPTIONS = {
  doctor: new Set(["--url", "--timeout-ms"]),
  skill: new Set(["--client", "--runtime", "--project"]),
};

// Parses argv into one of:
//   { ok: true, command: "help", topic, json }
//   { ok: true, command: "version", json }
//   { ok: true, command: "doctor", origin, timeoutMs, json }
//   { ok: true, command: "skill", action, client, runtime, project, json }
//   { ok: false, command, json, code, message }
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

  const fail = (code, message) => ({
    ok: false,
    command: command === "skill" && action !== null ? `skill ${action}` : command ?? (version ? "version" : null),
    json,
    code,
    message,
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

    if (command === "doctor" || command === "skill") {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
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

  const rawUrl = values["--url"];
  const origin = rawUrl === undefined ? DEFAULT_ORIGIN : parseOrigin(rawUrl);
  if (origin === null) {
    return fail(
      "invalid_url",
      "--url must be a bare https origin such as https://metergraph.example.com, " +
        "or an http origin on localhost, 127.0.0.1 or [::1]. " +
        "Credentials, paths, queries and fragments are not accepted.",
    );
  }

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

function parseTimeout(raw) {
  if (!/^[0-9]{1,6}$/.test(raw)) return null;
  const value = Number(raw);
  if (value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) return null;
  return value;
}
