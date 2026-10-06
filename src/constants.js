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
// It is the next action wherever the CLI itself cannot help, such as doctor
// results and sign in from a cloud runtime.
export const CONNECTION_GUIDE_URL =
  "https://www.metergraph.dev/docs/guides/agent-access/";

// Deployment profiles recognized by the probe contract. Any other value,
// including a well-formed one, is reported as unsupported and never echoed.
export const SUPPORTED_PROFILES = Object.freeze([
  "local",
  "managed",
  "byoc-core",
]);

// Clients that load project skills from a native directory, from each
// client's own documentation. Every client has its own directory, so
// installing for one never touches another client's files.
export const SKILL_CLIENTS = Object.freeze({
  codex: Object.freeze({ label: "Codex", dir: ".agents" }),
  claude: Object.freeze({ label: "Claude Code", dir: ".claude" }),
  cursor: Object.freeze({ label: "Cursor", dir: ".cursor" }),
});
export const SKILL_RUNTIMES = Object.freeze(["local", "cloud"]);

// Recognized values that cannot load project skill files. They get a pointer
// to the connection guide instead of a usage error, and nothing is written.
export const HANDOFF_SKILL_CLIENTS = Object.freeze({
  "claude-desktop": "Claude Desktop",
  chatgpt: "ChatGPT",
});
export const HANDOFF_SKILL_RUNTIMES = Object.freeze(["cloud-no-shell"]);

// Sign in needs a browser on the same machine as the CLI, because the browser
// hands the authorization back to a loopback listener. Other runtimes are
// recognized so they get a handoff instead of a usage error.
export const LOGIN_RUNTIMES = Object.freeze(["local"]);
export const HANDOFF_LOGIN_RUNTIMES = Object.freeze(["cloud", "cloud-no-shell"]);

// How long login waits for the browser to finish, and the fixed deadline for
// each group of HTTP requests around it.
export const LOGIN_DEFAULT_TIMEOUT_MS = 300000;
export const LOGIN_MIN_TIMEOUT_MS = 1000;
export const LOGIN_MAX_TIMEOUT_MS = 900000;
export const AUTH_HTTP_TIMEOUT_MS = 15000;

// The only scope this CLI requests. It never asks for agent:read (Debug) or
// agent:replay, and never falls back to them.
export const METADATA_SCOPE = "agent:metadata";

// The service's agent access contract version, as sent in schema_version by
// GET /v1/agent/workspace and GET /v1/agent/capabilities. It is the
// service's own string and is unrelated to SCHEMA_VERSION, the version of
// this CLI's JSON output.
export const AGENT_CONTRACT_VERSION = "metergraph.agent-access/v1";

// Exact paths on the chosen origin. Discovered metadata must name exactly
// these, so a tampered document cannot send the CLI anywhere else.
export const AUTH_PATHS = Object.freeze({
  resource: "/v1/agent/mcp",
  issuer: "/v1/oauth",
  authorization: "/v1/oauth/authorize",
  token: "/v1/oauth/token",
  registration: "/v1/oauth/register",
  revocation: "/v1/oauth/revoke",
  signup: "/v1/auth/signup",
  workspace: "/v1/agent/workspace",
  capabilities: "/v1/agent/capabilities",
});

// One exit code per outcome. Documented in README.md; changing a value is a
// breaking change for scripts. New outcomes are appended.
export const EXIT_CODES = Object.freeze({
  ok: 0,
  internal_error: 1,
  invalid_input: 2,
  authentication_required: 3,
  connection_failed: 4,
  unhealthy: 5,
  unsupported: 6,
  redirect_rejected: 7,
  conflict: 8,
  filesystem_error: 9,
  authorization_failed: 10,
  verification_failed: 11,
  login_required: 12,
  revocation_unconfirmed: 13,
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
    "The service answered with a response, deployment profile or status this CLI does not support, " +
    "or the skill client or runtime cannot use project skill files, " +
    "or sign in cannot run in this environment. Nothing was written.",
  redirect_rejected: "The service answered with a redirect. Redirects are never followed.",
  conflict:
    "The skill target is not owned by this CLI, was modified, is unsafe, is locked or needs an explicit update, " +
    "or the project is bound to a different origin or workspace. Nothing was changed.",
  filesystem_error:
    "Project or credential files could not be read or written. Partial changes were rolled back unless the message says otherwise.",
  authorization_failed:
    "Browser authorization did not finish: it was denied, cancelled, timed out or returned an invalid callback. Nothing was saved.",
  verification_failed:
    "The service issued a grant that does not match the requested origin, workspace, client, resource or Metadata scope. Nothing was saved.",
  login_required:
    "No usable sign in for this project: none was saved, it expired, was revoked, lost access or could not be refreshed safely. Run login again.",
  revocation_unconfirmed:
    "Local credentials were removed, but the service did not confirm that the grant was revoked.",
});
