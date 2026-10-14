import fs from "node:fs";

import { CONNECTION_GUIDE_URL, DEFAULT_ORIGIN } from "./constants.js";

// Where this CLI runs, for the sign in and setup path matrix. Only the
// presence of a variable or file is checked; no value is ever read into
// output.
//
//   local_shell      A terminal on the person's own machine. Browser sign in
//                    and setup work here.
//   local_container  A container on the person's machine (Docker, Podman, a
//                    local dev container) with no remote marker. It is not
//                    treated as remote: browser sign in works when the
//                    container's loopback port is forwarded, and --no-browser
//                    prints the URL to open.
//   ssh_session      A shell reached over SSH. The person's browser is on
//                    another machine.
//   cloud_workspace  A hosted development environment (Codespaces, Gitpod,
//                    Cloud Shell, or a remote dev container). The person's
//                    browser is on another machine.
//   ci               A CI job. No person is present.
//
// Remote markers win over container markers: a cloud workspace usually runs
// in a container, and it is still remote.

const REMOTE_MARKERS = [
  ["ssh_session", ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]],
  ["cloud_workspace", ["CODESPACES", "GITPOD_WORKSPACE_ID", "CLOUD_SHELL"]],
  ["ci", ["CI"]],
];
const CONTAINER_VARIABLES = ["REMOTE_CONTAINERS", "DEVCONTAINER", "container"];
const CONTAINER_FILES = ["/.dockerenv", "/run/.containerenv"];

// The fixed reason each remote kind reports. These are the reasons login and
// setup have always used, so scripts that match them keep working.
const REMOTE_REASONS = Object.freeze({
  ssh_session: "ssh_session",
  cloud_workspace: "cloud_workspace",
  ci: "ci_environment",
});

// The secret name an agent reads its Metadata key from. It matches the name
// the hosted Keys page and the Agent Access MCP setup already use.
export const AGENT_TOKEN_ENV = "METERGRAPH_AGENT_TOKEN";
// The origin an agent key is sent to, when no project binding and no --url
// names one. It matches the MCP setup's variable.
export const AGENT_URL_ENV = "METERGRAPH_URL";

function present(value) {
  return typeof value === "string" && value !== "" && value !== "0" && value.toLowerCase() !== "false";
}

function defaultFileExists(file) {
  try {
    return fs.existsSync(file);
  } catch {
    return false;
  }
}

// Returns { kind, remote, reason } where reason is null for a local kind.
export function classifyEnvironment(env = process.env, { fileExists = defaultFileExists } = {}) {
  for (const [kind, names] of REMOTE_MARKERS) {
    if (names.some((name) => present(env[name]))) return { kind, remote: true, reason: REMOTE_REASONS[kind] };
  }
  const container =
    CONTAINER_VARIABLES.some((name) => present(env[name])) || CONTAINER_FILES.some((file) => fileExists(file));
  return { kind: container ? "local_container" : "local_shell", remote: false, reason: null };
}

// Hosted pages a person opens on their own device. The Keys page creates a
// coding-agent key in the workspace the person is signed in to, which is how
// the person chooses the workspace. Sign up exists only on the hosted service.
export function handoffPages(origin) {
  const hosted = origin === DEFAULT_ORIGIN;
  return {
    sign_up_url: hosted ? `${origin}/v1/auth/signup?return_to=${encodeURIComponent("/#api-keys")}` : null,
    keys_url: `${origin}/#api-keys`,
  };
}

// The structured next action for an agent that cannot finish browser sign in
// where it runs, or has no credential yet. It names what a person does on
// their own device, where the key goes, and the exact commands the agent runs
// afterwards. The key itself never passes through the agent's chat, a command
// line or a file in the project.
export function agentKeyAction(environment, origin) {
  const pages = handoffPages(origin);
  const where = environment.kind === "ci"
    ? `a CI secret exposed to this job as ${AGENT_TOKEN_ENV}`
    : `this environment's secret settings as ${AGENT_TOKEN_ENV}`;
  const steps = [];
  if (pages.sign_up_url !== null) {
    steps.push({ action: "sign_up_or_sign_in", url: pages.sign_up_url });
  } else {
    steps.push({ action: "request_invitation", url: null });
  }
  steps.push({ action: "create_metadata_key", url: pages.keys_url });
  steps.push({ action: "store_secret", name: AGENT_TOKEN_ENV });
  return {
    kind: "use_agent_key",
    environment: environment.kind,
    credential_env: AGENT_TOKEN_ENV,
    person_steps: steps,
    then_run: ["metergraph status --json", "metergraph usage --json"],
    message:
      (environment.remote === false
        ? "If browser sign in cannot finish here, use a Metadata key instead. "
        : "Browser sign in cannot finish here. ") +
      "Ask the person to sign in on their own device, open the Keys page " +
      "in the workspace this agent should read, create a coding-agent key with Metadata access, and save it in " +
      `${where}. Do not ask them to paste the key into chat or a command. Then run the listed commands; ` +
      "they verify the origin, workspace, scope and capabilities before reading.",
    alternative: { kind: "run_on_local_machine", command: "metergraph login --runtime local" },
    url: CONNECTION_GUIDE_URL,
  };
}

// The next action for setup in a remote session. Ingest setup writes the
// application's own key and needs a local browser approval, so it runs on the
// person's machine. Metadata reads can still use an agent key here; that key
// is separate from the ingest key and never replaces it.
export function remoteSetupAction(environment, origin) {
  return {
    kind: "run_on_local_machine",
    environment: environment.kind,
    command: "metergraph setup --runtime local",
    message:
      "Setup approves an ingest key in a browser on the same machine as the CLI, so it cannot finish here. " +
      "Run it on the person's own machine, or follow the connection guide. For Metadata reads from this " +
      "environment, follow metadata_reads.",
    metadata_reads: agentKeyAction(environment, origin),
    url: CONNECTION_GUIDE_URL,
  };
}
