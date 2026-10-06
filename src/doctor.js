import { CONNECTION_GUIDE_URL, SUPPORTED_PROFILES } from "./constants.js";
import { get, parseJsonObject } from "./http.js";

const CHECKS = Object.freeze([
  { name: "health", path: "/healthz", readBody: true },
  { name: "deployment", path: "/v1/deployment", readBody: true },
  { name: "capabilities", path: "/v1/agent/capabilities", readBody: false },
]);

// Runs the read-only connection probe against an already validated origin.
// Every request shares one deadline of timeoutMs. The result contains only
// fixed tokens, numeric HTTP statuses, the validated origin and a profile from
// SUPPORTED_PROFILES. Nothing from a response body or header is copied.
export async function runDoctor({ origin, timeoutMs }) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await probe(origin, controller.signal);
  } finally {
    clearTimeout(timer);
  }
}

async function probe(origin, signal) {
  const report = {
    origin,
    reachable: null,
    healthy: null,
    deployment_profile: null,
    profile_status: "unknown",
    authentication_required: null,
    authenticated: false,
    workspace: null,
    checks: CHECKS.map(({ name, path }) => ({
      name,
      path,
      result: "skipped",
      http_status: null,
      reason: null,
    })),
    next_action: null,
  };

  for (const [index, check] of CHECKS.entries()) {
    const response = await get(new URL(check.path, origin), {
      signal,
      readBody: check.readBody,
    });
    const entry = report.checks[index];
    const verdict = evaluate(check.name, response, report);
    entry.result = verdict.outcome === null || verdict.pass ? "pass" : "fail";
    entry.http_status = response.status ?? null;
    entry.reason = verdict.reason;
    if (verdict.outcome !== null) {
      return { outcome: verdict.outcome, reason: verdict.reason, report };
    }
  }

  // Unreachable in this preview: the capabilities check always ends the probe.
  return { outcome: "internal_error", reason: "probe_incomplete", report };
}

// The same decision doctor makes for one GET /v1/deployment response, for
// status. Returns { outcome, reason, profile } where outcome is null and
// profile is one of SUPPORTED_PROFILES when the service reported a supported
// profile.
export function checkDeployment(response) {
  const report = { reachable: null, healthy: null, deployment_profile: null, profile_status: "unknown" };
  const { outcome, reason } = evaluate("deployment", response, report);
  return { outcome, reason, profile: report.deployment_profile };
}

// Returns { outcome, reason } where outcome is null when the probe should
// continue to the next check.
function evaluate(name, response, report) {
  if (response.kind === "error") {
    // Headers that arrived before a body failure still prove the server
    // answered over HTTP. They prove nothing about health or authentication.
    if (name === "health") report.reachable = response.status !== null;
    return { outcome: "connection_failed", reason: response.reason };
  }

  report.reachable = true;
  const { status } = response;

  if (status >= 300 && status < 400) {
    return { outcome: "redirect_rejected", reason: "redirect" };
  }
  if (status === 503) {
    report.healthy = false;
    return { outcome: "unhealthy", reason: "service_unavailable" };
  }
  if (status >= 500) {
    report.healthy = false;
    return { outcome: "unhealthy", reason: "server_error" };
  }

  if (name === "health") return evaluateHealth(response, report);
  if (name === "deployment") return evaluateDeployment(response, report);
  return evaluateCapabilities(response, report);
}

function evaluateHealth(response, report) {
  if (response.status !== 200) {
    return { outcome: "unsupported", reason: "unexpected_status" };
  }
  if (response.tooLarge) {
    return { outcome: "unsupported", reason: "response_too_large" };
  }
  const body = parseJsonObject(response);
  if (body === null || typeof body.ok !== "boolean") {
    return { outcome: "unsupported", reason: "invalid_response" };
  }
  if (body.ok !== true) {
    report.healthy = false;
    return { outcome: "unhealthy", reason: "reported_unhealthy" };
  }
  report.healthy = true;
  return { outcome: null, reason: null };
}

function evaluateDeployment(response, report) {
  if (response.status === 404) {
    // Servers without this endpoint, such as a self-hosted open source
    // server, have no profile adapter yet. Never assume they are hosted.
    report.profile_status = "unavailable";
    return { outcome: "unsupported", reason: "deployment_endpoint_missing" };
  }
  if (response.status !== 200) {
    return { outcome: "unsupported", reason: "unexpected_status" };
  }
  if (response.tooLarge) {
    return { outcome: "unsupported", reason: "response_too_large" };
  }
  const body = parseJsonObject(response);
  if (body === null || typeof body.deployment_profile !== "string") {
    return { outcome: "unsupported", reason: "invalid_response" };
  }
  if (!SUPPORTED_PROFILES.includes(body.deployment_profile)) {
    report.profile_status = "unrecognized";
    return { outcome: "unsupported", reason: "unrecognized_profile" };
  }
  report.deployment_profile = body.deployment_profile;
  report.profile_status = "supported";
  return { outcome: null, reason: null };
}

function evaluateCapabilities(response, report) {
  if (response.status === 401) {
    if (!hasBearerChallenge(response.headers["www-authenticate"])) {
      return { outcome: "unsupported", reason: "unexpected_auth_challenge" };
    }
    report.authentication_required = true;
    report.next_action = { kind: "connection_guide", url: CONNECTION_GUIDE_URL };
    // The check passed: the server behaved as expected. The outcome is still
    // not a connection, because this CLI holds no credentials.
    return { outcome: "authentication_required", reason: "bearer_token_required", pass: true };
  }
  if (response.status === 200) {
    report.authentication_required = false;
    return { outcome: "unsupported", reason: "unexpected_unauthenticated_access" };
  }
  return { outcome: "unsupported", reason: "unexpected_status" };
}

// RFC 9110 challenge grammar, applied to one comma-separated list element:
//   auth-scheme [ 1*SP ( token68 / auth-param ) ]  or a further auth-param.
// Only the first form names a scheme, so "Bearer=x" or "Bearer = x" is a
// parameter, never a challenge.
const TOKEN = "[!#$%&'*+.^_`|~0-9A-Za-z-]+";
const QUOTED = '"(?:[^"\\\\]|\\\\.)*"';
const PARAM = `${TOKEN}[ \\t]*=[ \\t]*(?:${TOKEN}|${QUOTED})`;
const TOKEN68 = "[A-Za-z0-9._~+/-]+=*";
const ELEMENT = new RegExp(`^(?:(${TOKEN})(?:[ \\t]+(?:${TOKEN68}|${PARAM}))?|${PARAM})$`);

// True when the header holds a Bearer challenge. Commas inside quoted strings
// (with backslash escapes) do not split elements. Any malformed element,
// including unbalanced quoting, makes the whole header unacceptable.
function hasBearerChallenge(value) {
  if (typeof value !== "string") return false;
  const elements = [];
  let start = 0;
  let quoted = false;
  for (let i = 0; i < value.length; i += 1) {
    const char = value[i];
    if (quoted) {
      if (char === "\\") i += 1;
      else if (char === '"') quoted = false;
    } else if (char === '"') {
      quoted = true;
    } else if (char === ",") {
      elements.push(value.slice(start, i));
      start = i + 1;
    }
  }
  if (quoted) return false;
  elements.push(value.slice(start));

  let bearer = false;
  for (const element of elements) {
    const trimmed = element.trim();
    if (trimmed === "") continue;
    const match = ELEMENT.exec(trimmed);
    if (match === null) return false;
    if (match[1] !== undefined && match[1].toLowerCase() === "bearer") bearer = true;
  }
  return bearer;
}
