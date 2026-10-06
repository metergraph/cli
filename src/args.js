import {
  DEFAULT_ORIGIN,
  DEFAULT_TIMEOUT_MS,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
} from "./constants.js";
import { parseOrigin } from "./origin.js";

const COMMANDS = new Set(["doctor", "help"]);

// Parses argv into one of:
//   { ok: true, command: "help", topic, json }
//   { ok: true, command: "version", json }
//   { ok: true, command: "doctor", origin, timeoutMs, json }
//   { ok: false, command, json, code, message }
// Error messages are fixed strings. They never contain an argument value,
// because a mistyped argument can be a credential.
export function parseArgs(argv) {
  const json = argv.includes("--json");

  if (argv.includes("--help") || argv.includes("-h")) {
    const topic = argv.includes("doctor") ? "doctor" : null;
    return { ok: true, command: "help", topic, json };
  }

  let command = null;
  let topic = null;
  let version = false;
  let rawUrl;
  let rawTimeout;

  const fail = (code, message) => ({
    ok: false,
    command: command ?? (version ? "version" : null),
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
    if (command === "help" && topic === null && arg === "doctor") {
      topic = arg;
      continue;
    }

    if (command === "doctor") {
      const equals = arg.indexOf("=");
      const name = equals === -1 ? arg : arg.slice(0, equals);
      if (name === "--url" || name === "--timeout-ms") {
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
        if (name === "--url") {
          if (rawUrl !== undefined) {
            return fail("duplicate_option", "--url may be given only once.");
          }
          rawUrl = value;
        } else {
          if (rawTimeout !== undefined) {
            return fail("duplicate_option", "--timeout-ms may be given only once.");
          }
          rawTimeout = value;
        }
        continue;
      }
    }

    if (command === null && !version && !arg.startsWith("-")) {
      return fail(
        "unknown_command",
        `Unknown command at argument ${position}. Run "metergraph --help" for usage.`,
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

  const origin = rawUrl === undefined ? DEFAULT_ORIGIN : parseOrigin(rawUrl);
  if (origin === null) {
    return fail(
      "invalid_url",
      "--url must be a bare https origin such as https://metergraph.example.com, " +
        "or an http origin on localhost, 127.0.0.1 or [::1]. " +
        "Credentials, paths, queries and fragments are not accepted.",
    );
  }

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

function parseTimeout(raw) {
  if (!/^[0-9]{1,6}$/.test(raw)) return null;
  const value = Number(raw);
  if (value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) return null;
  return value;
}
