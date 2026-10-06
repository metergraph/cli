import {
  CONNECTION_GUIDE_URL,
  DEFAULT_ORIGIN,
  DEFAULT_TIMEOUT_MS,
  EXIT_CODE_MEANINGS,
  EXIT_CODES,
  MAX_TIMEOUT_MS,
  MIN_TIMEOUT_MS,
  PACKAGE_NAME,
  SCHEMA_VERSION,
  SUPPORTED_PROFILES,
  VERSION,
} from "./constants.js";

// Every JSON result, success or failure, has the same top-level keys:
//   schema_version, command, ok, outcome, exit_code, data, error
// error is null when ok is true, otherwise { code, reason, message } where
// code equals outcome. All strings come from this package, never from input
// or from a server.
export function envelope({ command, outcome, data = null, reason = null, message = null }) {
  const ok = outcome === "ok";
  return {
    schema_version: SCHEMA_VERSION,
    command,
    ok,
    outcome,
    exit_code: EXIT_CODES[outcome],
    data,
    error: ok ? null : { code: outcome, reason, message },
  };
}

export function toJsonLine(result) {
  return `${JSON.stringify(result)}\n`;
}

const DOCTOR_OPTIONS = [
  {
    name: "--url",
    value: "ORIGIN",
    summary: `Origin to probe. Default ${DEFAULT_ORIGIN}.`,
  },
  {
    name: "--timeout-ms",
    value: "N",
    summary: `Total time allowed for the whole probe, ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}. Default ${DEFAULT_TIMEOUT_MS}.`,
  },
  { name: "--json", value: null, summary: "Print one JSON line on stdout." },
];

export function helpData(topic) {
  return {
    topic,
    usage: [
      "metergraph --help [--json]",
      "metergraph --version [--json]",
      "metergraph doctor [--url ORIGIN] [--timeout-ms N] [--json]",
    ],
    commands: [
      {
        name: "doctor",
        summary:
          "Check that a Metergraph service is reachable, healthy and supported. Read only, sends no credentials.",
        options: DOCTOR_OPTIONS,
      },
    ],
    supported_profiles: [...SUPPORTED_PROFILES],
    exit_codes: Object.entries(EXIT_CODES).map(([outcome, code]) => ({
      code,
      outcome,
      meaning: EXIT_CODE_MEANINGS[outcome],
    })),
  };
}

export function helpText(topic) {
  const lines = [];
  if (topic === "doctor") {
    lines.push(
      "Usage: metergraph doctor [--url ORIGIN] [--timeout-ms N] [--json]",
      "",
      "Makes unauthenticated, read-only GET requests to /healthz, /v1/deployment and",
      "/v1/agent/capabilities on one origin. Sends no credentials and follows no redirects.",
      "",
      "Options:",
    );
    for (const option of DOCTOR_OPTIONS) {
      const flag = option.value ? `${option.name} ${option.value}` : option.name;
      lines.push(`  ${flag.padEnd(18)}${option.summary}`);
    }
    lines.push(
      "",
      "ORIGIN must be a bare https origin such as https://metergraph.example.com.",
      "Plain http is accepted only for localhost, 127.0.0.1 and [::1].",
      "",
      "A healthy, supported service that requires sign in exits with code 3.",
      "This preview cannot sign in, so it never reports a connected workspace.",
    );
  } else {
    lines.push(
      `metergraph ${VERSION} (preview)`,
      "",
      "Usage:",
      "  metergraph --help [--json]       Show this help",
      "  metergraph --version [--json]    Show the CLI version",
      "  metergraph doctor [options]      Check a Metergraph service, read only",
      "",
      'Run "metergraph help doctor" for doctor options.',
    );
  }
  lines.push("", "Exit codes:");
  for (const [outcome, code] of Object.entries(EXIT_CODES)) {
    lines.push(`  ${String(code).padEnd(3)}${outcome.padEnd(25)}${EXIT_CODE_MEANINGS[outcome]}`);
  }
  return `${lines.join("\n")}\n`;
}

export function versionData() {
  return { name: PACKAGE_NAME, version: VERSION };
}

const CHECK_LABELS = {
  health: "Health",
  deployment: "Deployment profile",
  capabilities: "Agent capabilities",
};

const REASON_TEXT = {
  timeout: "the probe did not finish within the time limit",
  dns_lookup_failed: "the host name could not be resolved",
  connection_refused: "the connection was refused",
  connection_reset: "the connection was closed unexpectedly",
  host_unreachable: "the host could not be reached",
  invalid_http_response: "the server did not send a valid HTTP response",
  tls_error: "the TLS connection could not be verified",
  network_error: "a network error occurred",
  redirect: "the server answered with a redirect, which is never followed",
  service_unavailable: "the service reported that it is unavailable",
  server_error: "the service answered with a server error",
  reported_unhealthy: "the service reported that it is not healthy",
  unexpected_status: "the service answered with an unexpected status",
  response_too_large: "the response was larger than the allowed limit",
  invalid_response: "the response was not the expected JSON",
  deployment_endpoint_missing:
    "the service does not report a deployment profile; this preview supports only services that do",
  unrecognized_profile: "the service reported a deployment profile this CLI does not support",
  unexpected_auth_challenge: "the service did not ask for a bearer token",
  unexpected_unauthenticated_access: "the service answered without asking for authentication",
  bearer_token_required: "authentication required",
  probe_incomplete: "the probe did not complete",
};

export function doctorMessage(outcome, reason) {
  if (outcome === "authentication_required") {
    return "The service is reachable and supported, and it requires authentication. No workspace is connected.";
  }
  const detail = REASON_TEXT[reason] ?? "the probe failed";
  return `${detail.charAt(0).toUpperCase()}${detail.slice(1)}.`;
}

export function doctorText(result) {
  const report = result.data;
  const lines = ["Metergraph doctor (read only, no credentials sent)", `Origin: ${report.origin}`, ""];
  for (const check of report.checks) {
    let line = `  ${check.result.padEnd(8)}${CHECK_LABELS[check.name]} (${check.path})`;
    if (check.name === "deployment" && report.deployment_profile !== null) {
      line += `: ${report.deployment_profile}`;
    } else if (check.reason !== null) {
      line += `: ${REASON_TEXT[check.reason] ?? check.reason}`;
    }
    lines.push(line);
  }
  lines.push("", `Result: ${result.outcome} (exit ${result.exit_code})`);
  if (result.error !== null) lines.push(result.error.message);
  if (result.outcome === "authentication_required") {
    lines.push(
      "This preview cannot sign in. To connect an application, follow the connection guide:",
      CONNECTION_GUIDE_URL,
    );
  }
  return `${lines.join("\n")}\n`;
}
