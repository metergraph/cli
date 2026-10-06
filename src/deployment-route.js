import path from "node:path";

import { discover, normalizeUuid, verifyContext } from "./auth-oauth.js";
import { AGENT_CONTRACT_VERSION, CONNECTION_GUIDE_URL, MAX_BODY_BYTES, METADATA_SCOPE } from "./constants.js";
import { CREDENTIAL_MIN_LENGTH, readCredentialFile } from "./deployment-credential.js";
import { checkDeployment } from "./doctor.js";
import { parseJsonObject } from "./http.js";
import { parseOrigin } from "./origin.js";
import { capabilitySummary } from "./read-contract.js";
import { deadline, send } from "./transport.js";

// Internal deployment routing for customer-operated Metergraph deployments.
// planDeploymentRoute is pure: it checks enumerated inputs and reports which
// prerequisites stand between the caller and a Metadata-only agent
// connection. verifyDeploymentRoute then proves the route afresh against the
// service. Neither installs, provisions, registers or writes anything, and
// results hold only fixed tokens, the normalized origin and workspace id, and
// statuses: no raw input, response text or credential.
//
// Every result is { ok, outcome, reason, plan, verification, receipt }, and
// every outcome is one of the CLI's EXIT_CODES outcomes. A result produced
// after the credential file was read also carries a non-enumerable
// knownCredentials array, so a caller that prints it can apply the same
// known-credential suppression as other commands. It is never serialized.

const PREREQUISITES = Object.freeze({
  // A customer machine running the released commercial bundle.
  "customer-local": Object.freeze([
    "released_signed_bundle",
    "registry_invitation",
    "bundle_started_verified",
    "local_admin_configured",
    "metadata_agent_credential",
  ]),
  // A deployment an operator provisions in the customer's own cloud.
  byoc: Object.freeze([
    "operator_provisioning",
    "private_network_reachability",
    "identity_membership_configured",
    "metadata_agent_credential",
  ]),
  // The self-hosted open source server. It has no hosted sign up, keys page
  // or registry. Installing a server distribution, the server serving
  // deployment discovery and advertising the Metadata scope, ingestion tokens
  // (MG_TOKENS) and agent read tokens (MG_AGENT_TOKENS) are each separate
  // operator steps. A server without deployment discovery and exact Metadata
  // support requires an operator upgrade or configuration handoff.
  oss: Object.freeze([
    "server_distribution_installed",
    "deployment_discovery_supported",
    "metadata_scope_supported",
    "ingestion_tokens_configured",
    "agent_read_tokens_configured",
    "metadata_agent_credential",
  ]),
});

// Prerequisites only the server operator can meet, by upgrading or
// configuring the server. They get an operator handoff.
const OPERATOR_PREREQUISITES = Object.freeze(["deployment_discovery_supported", "metadata_scope_supported"]);

// Each model expects exactly one profile. oss is never treated as local or
// any other profile.
const PROFILES = Object.freeze({ "customer-local": "local", byoc: "byoc-core", oss: "oss" });

// Only a shell on the customer's own machine can reach a local deployment and
// read its private credential file. Hosted agent runtimes and remote shells
// get a handoff; nothing is tunnelled, forwarded or relaxed for them.
const RUNTIMES = Object.freeze(["local"]);
const HANDOFF_RUNTIMES = Object.freeze(["cloud", "cloud-no-shell", "remote-ssh"]);
const STATUSES = Object.freeze(["ready", "required", "unknown"]);

// The only next action kinds a result can carry.
const ACTION_KINDS = Object.freeze([
  "verify_route",
  "complete_prerequisite",
  "oss_operator_handoff",
  "run_on_customer_machine",
  "use_https_origin",
  "connection_guide",
  "check_private_network",
  "platform_credential_handoff",
  "fix_credential_file",
  "use_metadata_only_credential",
  "retry",
]);

// Facts agent verification says nothing about. They are reported as not
// checked on every verification and never inferred from it.
const NOT_CHECKED = Object.freeze(["ingest", "provider", "sdk", "registration", "bundle"]);

// Receipts record how far a previous run got. They are context only: a
// receipt never authorizes anything or skips a check.
//   prerequisites: every prerequisite was reported ready
//   preflight: the service reported the expected deployment profile and
//     advertised the Metadata scope on its fixed OAuth metadata paths
//   verified: the Metadata credential was verified for the workspace
const RECEIPT_VERSION = 1;
const PHASES = Object.freeze(["prerequisites", "preflight", "verified"]);
const RECEIPT_KEYS = Object.freeze([
  "version",
  "model",
  "runtime",
  "origin",
  "workspace_id",
  "deployment_profile",
  "phase",
]);

// Returned instead of any result that would contain the credential. The
// fallback, used when the credential happens to contain the first refusal's
// own text, uses only strings shorter than any credential, including its keys.
const ECHO_REFUSAL = Object.freeze(["verification_failed", "credential_in_metadata_response"]);
const ECHO_FALLBACK = Object.freeze(["unsupported", "credential_echo"]);

const DEPLOYMENT_PATH = "/v1/deployment";
const MIN_TIMEOUT_MS = 100;
const MAX_TIMEOUT_MS = 60000;

function action(kind, prerequisite = null) {
  // Kinds are constants from this module, so this is a programming error.
  if (!ACTION_KINDS.includes(kind)) throw new Error("unknown next action kind");
  return { kind, prerequisite, url: CONNECTION_GUIDE_URL };
}
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const result = (ok, outcome, reason, { plan = null, verification = null, receipt = null } = {}) => ({
  ok,
  outcome,
  reason,
  plan,
  verification,
  receipt,
});
const invalid = (reason) => result(false, "invalid_input", reason);

export function planDeploymentRoute(input) {
  const context = routeContext(input);
  if (!context.ok) return invalid(context.reason);
  const { model, runtime, origin, workspaceId, profile, statuses } = context;

  const plan = {
    model,
    runtime,
    origin,
    workspace_id: workspaceId,
    deployment_profile: profile,
    prerequisites: PREREQUISITES[model].map((name) => ({ name, status: statuses[name] })),
    next_action: null,
    unsupported_reasons: [],
  };

  if (HANDOFF_RUNTIMES.includes(runtime)) plan.unsupported_reasons.push("runtime_not_customer_machine");
  if (model === "byoc" && !origin.startsWith("https:")) plan.unsupported_reasons.push("byoc_requires_https");
  if (plan.unsupported_reasons.length > 0) {
    plan.next_action = action(
      HANDOFF_RUNTIMES.includes(runtime) ? "run_on_customer_machine" : "use_https_origin",
    );
    return result(false, "unsupported", plan.unsupported_reasons[0], { plan });
  }

  const pending = plan.prerequisites.find((entry) => entry.status !== "ready");
  if (pending !== undefined) {
    // A handoff only: the person or operator completes it. Nothing is
    // installed, provisioned or requested on their behalf.
    const kind = OPERATOR_PREREQUISITES.includes(pending.name) ? "oss_operator_handoff" : "complete_prerequisite";
    plan.next_action = action(kind, pending.name);
    const reason = pending.status === "required" ? "prerequisite_required" : "prerequisite_unknown";
    plan.unsupported_reasons.push(reason);
    return result(false, "unsupported", reason, { plan });
  }

  plan.next_action = action("verify_route");
  return result(true, "ok", "prerequisites_ready", { plan, receipt: receiptFor(plan, "prerequisites") });
}

// Proves the route with fresh requests, whatever a previous receipt says:
//   1. GET /v1/deployment on the origin with no credential. A redirect,
//      missing endpoint, unexpected or mismatched profile, or an unreachable
//      or unhealthy service stops here.
//   2. OAuth discovery with no credential, through auth-oauth discover: the
//      protected resource and authorization server metadata must name the
//      fixed resource, issuer and endpoints on this origin, with no redirect,
//      and advertise the Metadata scope. Nothing is registered. There is no
//      weaker fallback.
//   3. Only then reads the Metadata credential from credentialFile.
//   4. GET /v1/agent/workspace and /v1/agent/capabilities with it, through
//      verifyContext, then the full capability summary and a check that no
//      capability that reads content, replays, calls a provider or mutates is
//      available, including ones this CLI does not know.
// One deadline of timeoutMs and the optional cancel signal span every step,
// and are checked after every request and immediately before success. No
// ingest, evaluation, provider or trace request is ever made, and the
// credential is never returned. A broader key fails closed: there is no
// fallback to Debug or Replay access.
export async function verifyDeploymentRoute(input) {
  const planned = planDeploymentRoute(input);
  if (!planned.ok) return planned;
  const { plan } = planned;
  const { credentialFile, timeoutMs = 15000, cancel = null } = input;
  if (!Number.isInteger(timeoutMs) || timeoutMs < MIN_TIMEOUT_MS || timeoutMs > MAX_TIMEOUT_MS) {
    return invalid("timeout_invalid");
  }
  if (cancel !== null && !(cancel instanceof AbortSignal)) return invalid("cancel_invalid");
  if (typeof credentialFile !== "string" || !path.isAbsolute(credentialFile)) {
    return invalid("credential_file_invalid");
  }

  const verification = {
    deployment_discovery: "not_run",
    metadata_discovery: "not_run",
    credential_file: "not_run",
    agent_metadata_access: "not_run",
    contract: null,
    access_scope: null,
    content_included: null,
    capabilities: null,
    not_checked: [...NOT_CHECKED],
    next_action: null,
  };
  let phase = "prerequisites";
  // The step in progress, marked interrupted if the run stops during it.
  let step = "deployment_discovery";
  let token = null;
  const { signal, timedOut } = deadline(timeoutMs, cancel);
  const stop = (outcome, reason, kind = "connection_guide") => {
    verification.next_action = action(kind);
    plan.next_action = verification.next_action;
    if (outcome === "unsupported") plan.unsupported_reasons.push(reason);
    const stopped = result(false, outcome, reason, { plan, verification, receipt: receiptFor(plan, phase) });
    return token === null ? stopped : withoutCredential(stopped, token);
  };
  const fail = (outcome, reason, kind) => {
    verification[step] = "failed";
    return stop(outcome, reason, kind);
  };
  const interrupted = () => {
    verification[step] = "interrupted";
    if (timedOut()) return stop("connection_failed", "timeout");
    return stop("cancelled", "cancelled", "retry");
  };
  // Handoff for a discovery step the service does not support.
  const unsupportedKind = (outcome) => {
    if (plan.model === "oss" && outcome === "unsupported") return "oss_operator_handoff";
    if (plan.model === "byoc" && outcome === "connection_failed") return "check_private_network";
    return "connection_guide";
  };

  if (signal.aborted) return interrupted();
  const response = await send(plan.origin, DEPLOYMENT_PATH, { signal, maxBytes: MAX_BODY_BYTES });
  if (signal.aborted) return interrupted();
  const discovered = discoveredProfile(response, plan.model);
  if (discovered.outcome !== null) {
    return fail(discovered.outcome, discovered.reason, unsupportedKind(discovered.outcome));
  }
  if (discovered.profile !== plan.deployment_profile) {
    return fail("unsupported", "deployment_profile_mismatch", unsupportedKind("unsupported"));
  }
  verification.deployment_discovery = "passed";

  step = "metadata_discovery";
  const oauth = await discover(plan.origin, signal);
  if (signal.aborted) return interrupted();
  if (!oauth.ok) return fail(oauth.outcome, oauth.reason, unsupportedKind(oauth.outcome));
  verification.metadata_discovery = "passed";
  phase = "preflight";

  step = "credential_file";
  const credential = readCredentialFile(credentialFile);
  if (!credential.ok) {
    return fail(
      credential.outcome,
      credential.reason,
      credential.outcome === "unsupported" ? "platform_credential_handoff" : "fix_credential_file",
    );
  }
  // From here on every result passes through the known-credential guard.
  token = credential.token;
  verification.credential_file = "passed";
  if (signal.aborted) return interrupted();

  step = "agent_metadata_access";
  const ctx = { profile: plan.deployment_profile, workspaceId: plan.workspace_id };
  const verified = await verifyContext(plan.origin, token, ctx, signal);
  if (signal.aborted) return interrupted();
  if (!verified.ok) return fail(verified.outcome, verified.reason, "use_metadata_only_credential");
  const summary = capabilitySummary(verified.documents.capabilities, ctx, new Set());
  const refusal = summary.ok ? capabilityRefusal(summary.value, verified.documents.capabilities.agent) : summary;
  if (refusal !== null) return fail(refusal.outcome, refusal.reason, "use_metadata_only_credential");

  // Nothing is reported as verified after a cancellation or the deadline.
  if (signal.aborted) return interrupted();
  verification.agent_metadata_access = "passed";
  // checkWorkspace already required exactly these values.
  verification.contract = AGENT_CONTRACT_VERSION;
  verification.access_scope = METADATA_SCOPE;
  verification.content_included = false;
  verification.capabilities = { workspace_context: true, capability_discovery: true };
  phase = "verified";
  const verifiedResult = result(true, "ok", "metadata_access_verified", {
    plan,
    verification,
    receipt: receiptFor(plan, phase),
  });
  return withoutCredential(verifiedResult, token);
}

// A result that may be printed must not hold the credential anywhere, even
// where it only coincides with the origin, workspace id or a fixed string.
// Such a result is replaced by a minimal refusal with no plan, verification
// or receipt. Either way the credential is attached as non-enumerable
// knownCredentials for the caller's own output suppression.
function withoutCredential(value, token) {
  let safe = value;
  if (holdsKnown(safe, token)) {
    safe = result(false, ...ECHO_REFUSAL);
    if (holdsKnown(safe, token)) safe = result(false, ...ECHO_FALLBACK);
  }
  Object.defineProperty(safe, "knownCredentials", { value: Object.freeze([token]), enumerable: false });
  return safe;
}

// True when any string in value, keys included, contains the credential.
function holdsKnown(value, token) {
  if (typeof value === "string") return value.includes(token);
  if (value === null || typeof value !== "object") return false;
  for (const [key, entry] of Object.entries(value)) {
    if (holdsKnown(key, token) || holdsKnown(entry, token)) return true;
  }
  return false;
}

// The fallback refusal can never hold a credential.
for (const text of [...ECHO_FALLBACK, ...Object.keys(result(false, ...ECHO_FALLBACK))]) {
  if (text.length >= CREDENTIAL_MIN_LENGTH) throw new Error("fallback refusal text could contain a credential");
}

// Checks every input against fixed enumerations. Rejected values are never
// echoed; the reason names only which input was wrong.
function routeContext(input) {
  if (!isObject(input)) return { ok: false, reason: "input_invalid" };
  const { model, runtime, prerequisites = {}, receipt = null } = input;
  if (typeof model !== "string" || !Object.hasOwn(PROFILES, model)) return { ok: false, reason: "model_invalid" };
  if (!RUNTIMES.includes(runtime) && !HANDOFF_RUNTIMES.includes(runtime)) {
    return { ok: false, reason: "runtime_invalid" };
  }
  const origin = parseOrigin(input.origin);
  if (origin === null) return { ok: false, reason: "origin_invalid" };
  const workspaceId = normalizeUuid(input.workspaceId);
  if (workspaceId === null) return { ok: false, reason: "workspace_id_invalid" };

  if (!isObject(prerequisites)) return { ok: false, reason: "prerequisites_invalid" };
  const names = PREREQUISITES[model];
  const statuses = {};
  for (const name of names) statuses[name] = "unknown";
  for (const [name, status] of Object.entries(prerequisites)) {
    if (!names.includes(name) || !STATUSES.includes(status)) return { ok: false, reason: "prerequisites_invalid" };
    statuses[name] = status;
  }

  const context = { ok: true, model, runtime, origin, workspaceId, profile: PROFILES[model], statuses };
  if (receipt !== null) {
    const reason = receiptProblem(receipt, context);
    if (reason !== null) return { ok: false, reason };
  }
  return context;
}

// A receipt must have exactly the documented keys, so one carrying a
// credential, path or anything else is refused, and must describe this exact
// route. Its phase is not used for anything.
function receiptProblem(receipt, context) {
  if (!isObject(receipt)) return "receipt_invalid";
  const keys = Object.keys(receipt);
  if (keys.length !== RECEIPT_KEYS.length || !RECEIPT_KEYS.every((key) => Object.hasOwn(receipt, key))) {
    return "receipt_invalid";
  }
  if (receipt.version !== RECEIPT_VERSION || !PHASES.includes(receipt.phase)) return "receipt_invalid";
  for (const key of ["model", "runtime", "origin", "workspace_id", "deployment_profile"]) {
    if (typeof receipt[key] !== "string") return "receipt_invalid";
  }
  if (
    receipt.model !== context.model ||
    receipt.runtime !== context.runtime ||
    parseOrigin(receipt.origin) !== context.origin ||
    normalizeUuid(receipt.workspace_id) !== context.workspaceId ||
    receipt.deployment_profile !== context.profile
  ) {
    return "receipt_context_mismatch";
  }
  return null;
}

function receiptFor(plan, phase) {
  return {
    version: RECEIPT_VERSION,
    model: plan.model,
    runtime: plan.runtime,
    origin: plan.origin,
    workspace_id: plan.workspace_id,
    deployment_profile: plan.deployment_profile,
    phase,
  };
}

// The doctor decision for GET /v1/deployment, which knows local and byoc-core,
// plus the oss profile, which only this module accepts. Returns
// { outcome: null, profile } or { outcome, reason }.
function discoveredProfile(response, model) {
  const checked = checkDeployment(response);
  if (checked.outcome === null) return { outcome: null, profile: checked.profile };
  if (checked.reason === "deployment_endpoint_missing" && model === "oss") {
    // This server has no deployment endpoint, and static agent tokens can
    // carry broader scopes than Metadata. There is no
    // fallback discovery, so the operator is handed off and no credential is
    // read or sent.
    return { outcome: "unsupported", reason: "oss_deployment_discovery_unavailable" };
  }
  if (checked.reason === "unrecognized_profile" && parseJsonObject(response)?.deployment_profile === "oss") {
    return { outcome: null, profile: "oss" };
  }
  return { outcome: checked.outcome, reason: checked.reason };
}

// capabilitySummary refuses known capabilities that are not metadata-only and
// available. This also requires the two capabilities verification relies on,
// and refuses any available entry, under any name, that is not plainly
// metadata-only: no content, mutation, external (provider) calls, content or
// replay privacy class, or scope other than Metadata.
function capabilityRefusal(summary, agent) {
  for (const name of ["workspace_context", "capability_discovery"]) {
    if (summary.agent[name]?.available !== true) {
      return { outcome: "verification_failed", reason: "required_capability_unavailable" };
    }
  }
  for (const entry of Object.values(agent)) {
    if (!isObject(entry) || typeof entry.available !== "boolean") {
      return { outcome: "verification_failed", reason: "capabilities_response_invalid" };
    }
    if (!entry.available) continue;
    const metadataOnly =
      entry.content === false &&
      entry.mutates === false &&
      entry.external_calls === false &&
      entry.privacy_class === "metadata" &&
      entry.required_scope === METADATA_SCOPE;
    if (!metadataOnly) return { outcome: "verification_failed", reason: "sensitive_capability_available" };
  }
  return null;
}
