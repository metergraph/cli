import { readFileSync } from "node:fs";

const packageJson = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
);

export const PACKAGE_NAME = packageJson.name;
export const VERSION = packageJson.version;

export const SCHEMA_VERSION = 1;
export const DEFAULT_ORIGIN = "https://app.metergraph.dev";

export const DEFAULT_TIMEOUT_MS = 5000;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 30000;
export const MAX_BODY_BYTES = 32 * 1024;

// The public guide a person follows to connect an application to Metergraph.
// The CLI cannot sign in yet, so this is the only next action it offers.
export const CONNECTION_GUIDE_URL =
  "https://www.metergraph.dev/docs/guides/agent-access/";

// Deployment profiles recognized by the probe contract. Any other value,
// including a well-formed one, is reported as unsupported and never echoed.
export const SUPPORTED_PROFILES = Object.freeze([
  "local",
  "managed",
  "byoc-core",
]);

// One exit code per outcome. Documented in README.md; changing a value is a
// breaking change for scripts.
export const EXIT_CODES = Object.freeze({
  ok: 0,
  internal_error: 1,
  invalid_input: 2,
  authentication_required: 3,
  connection_failed: 4,
  unhealthy: 5,
  unsupported: 6,
  redirect_rejected: 7,
});

export const EXIT_CODE_MEANINGS = Object.freeze({
  ok: "Command succeeded. Doctor does not return this in this preview.",
  internal_error: "Unexpected internal failure in the CLI.",
  invalid_input: "Unknown command or argument, or an invalid option value. No request was made.",
  authentication_required:
    "Service is reachable, healthy and supported, and requires authentication. No workspace is connected.",
  connection_failed: "The origin could not be reached, the connection failed, or the probe timed out.",
  unhealthy:
    "The service answered but reported that it is not healthy, or answered with a server error.",
  unsupported:
    "The service answered with a response, deployment profile or status this CLI does not support.",
  redirect_rejected: "The service answered with a redirect. Redirects are never followed.",
});
