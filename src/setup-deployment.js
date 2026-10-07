import { runDoctor } from "./doctor.js";
import { planDeploymentRoute, verifyDeploymentRoute } from "./deployment-route.js";
import { AUTH_HTTP_TIMEOUT_MS } from "./constants.js";

// Setup routing uses the same deployment model and Metadata credential checks
// as the standalone routing contract. Operator prerequisites are assertions,
// not evidence of a released bundle or provisioning. The CLI still verifies
// the live origin/profile and (when supplied) a separate Metadata credential.
const PREREQUISITES = Object.freeze({
  "customer-local": Object.freeze([
    "released_signed_bundle", "registry_invitation", "bundle_started_verified",
    "local_admin_configured", "metadata_agent_credential",
  ]),
  byoc: Object.freeze([
    "operator_provisioning", "private_network_reachability",
    "identity_membership_configured", "metadata_agent_credential",
  ]),
  oss: Object.freeze([
    "server_distribution_installed", "deployment_discovery_supported",
    "metadata_scope_supported", "ingestion_tokens_configured",
    "agent_read_tokens_configured", "metadata_agent_credential",
  ]),
});

const EXPECTED_PROFILE = Object.freeze({ "customer-local": "local", byoc: "byoc-core", oss: "oss" });

const handoff = (outcome, reason, nextAction = null, details = {}) => ({
  proceed: false,
  outcome,
  reason,
  data: {
    status: "operator_handoff",
    application_traffic_verified: false,
    deployment_profile: details.profile ?? null,
    origin: details.origin ?? null,
    workspace_id: details.workspaceId ?? null,
    prerequisites: details.prerequisites ?? "not_confirmed",
    pending_prerequisites: details.pendingPrerequisites ?? [],
    metadata_access: details.metadataAccess ?? "not_checked",
    ingest_credential: "not_checked",
    next_action: nextAction,
  },
});

// The static agent token can be any printable string of at least 16 bytes.
// Even a fixed status such as "operator_handoff" might equal that token. Keep
// the verifier's non-enumerable knownCredentials on every later result and
// drop all contextual fields if a coincidental value would echo it.
function guardKnownCredentials(value, verified) {
  const known = verified.knownCredentials;
  if (!known) return value;
  const safe = known.some((token) => holdsKnown(value, token))
    ? { proceed: false, outcome: "unsupported", reason: "credential_echo", data: null }
    : value;
  Object.defineProperty(safe, "knownCredentials", { value: known, enumerable: false });
  return safe;
}

export function containsKnownCredential(value, routed) {
  return routed?.knownCredentials?.some((token) => holdsKnown(value, token)) ?? false;
}

function holdsKnown(value, token) {
  if (typeof value === "string") return value.includes(token);
  if (value === null || typeof value !== "object") return false;
  return Object.entries(value).some(([key, entry]) => holdsKnown(key, token) || holdsKnown(entry, token));
}

export function planNonHostedSetup(options) {
  if (!Object.hasOwn(PREREQUISITES, options.deployment)) {
    return handoff("invalid_input", "deployment_invalid");
  }
  if (options.signup) return handoff("unsupported", "signup_hosted_only");
  if (!options.originExplicit) return handoff("invalid_input", "non_hosted_origin_required");
  if (options.workspace === null) return handoff("invalid_input", "non_hosted_workspace_required");

  const prerequisites = Object.fromEntries(PREREQUISITES[options.deployment].map((name) => [
    name, options.confirmPrerequisites ? "ready" : "unknown",
  ]));
  const planned = planDeploymentRoute({
    model: options.deployment,
    runtime: options.runtime,
    origin: options.origin,
    workspaceId: options.workspace,
    prerequisites,
  });
  if (!planned.ok) {
    return handoff(planned.outcome, planned.reason, planned.plan?.next_action ?? null, {
      profile: EXPECTED_PROFILE[options.deployment], origin: planned.plan?.origin,
      workspaceId: planned.plan?.workspace_id,
      pendingPrerequisites: planned.plan?.prerequisites.filter((item) => item.status !== "ready").map((item) => item.name),
    });
  }
  return { proceed: true, plan: planned.plan, prerequisites };
}

export async function preflightNonHostedSetup(options) {
  const planned = planNonHostedSetup(options);
  if (!planned.proceed) return planned;
  const { plan, prerequisites } = planned;
  const timeoutMs = Math.min(options.timeoutMs, AUTH_HTTP_TIMEOUT_MS);
  if (options.deployment === "oss" && !options.agentTokenFile) {
    return handoff("unsupported", "oss_agent_token_file_required", "oss_operator_handoff", {
      profile: plan.deployment_profile, origin: plan.origin, workspaceId: plan.workspace_id,
      prerequisites: "operator_confirmed",
    });
  }

  if (options.deployment === "oss") {
    // The OSS verifier knows the source-only `oss` discovery profile. Doctor
    // intentionally does not accept that profile for hosted login.
    const verified = await verifyDeploymentRoute({
      model: options.deployment, runtime: options.runtime, origin: plan.origin,
      workspaceId: plan.workspace_id, prerequisites,
      credentialFile: options.agentTokenFile, timeoutMs,
    });
    if (!verified.ok) {
      return guardKnownCredentials(handoff(verified.outcome, verified.reason, verified.plan?.next_action ?? null, {
        profile: plan.deployment_profile, origin: plan.origin, workspaceId: plan.workspace_id,
        prerequisites: "operator_confirmed",
      }), verified);
    }
    // The OSS operator provisions MG_TOKENS and MG_AGENT_TOKENS separately.
    // No released OSS server implements the purpose-bound ingest bootstrap,
    // and a Metadata agent token cannot issue a key. Keep this a handoff.
    return guardKnownCredentials(handoff("unsupported", "oss_ingest_operator_handoff", "oss_operator_handoff", {
      profile: plan.deployment_profile, origin: plan.origin, workspaceId: plan.workspace_id,
      prerequisites: "operator_confirmed", metadataAccess: "verified",
    }), verified);
  }

  // Every non-hosted route proves the service profile before any login, local
  // binding, credential read or ingest-key write. runDoctor rejects redirects
  // and unsafe network responses and reports only a fixed profile token.
  const doctor = await runDoctor({ origin: plan.origin, timeoutMs });
  if (doctor.report.deployment_profile !== null && doctor.report.deployment_profile !== plan.deployment_profile) {
    return handoff("unsupported", "deployment_profile_mismatch", "connection_guide", {
      profile: plan.deployment_profile, origin: plan.origin, workspaceId: plan.workspace_id,
      prerequisites: "operator_confirmed",
    });
  }
  if (doctor.outcome !== "authentication_required") {
    return handoff(doctor.outcome, doctor.reason, options.deployment === "oss" ? "oss_operator_handoff" : "connection_guide", {
      profile: plan.deployment_profile, origin: plan.origin, workspaceId: plan.workspace_id,
      prerequisites: "operator_confirmed",
    });
  }

  // A separate agent token file is optional for local/BYOC, where setup will
  // obtain its own Metadata OAuth grant. OSS has no scoped ingest bootstrap
  // contract, so its separate MG_AGENT_TOKENS credential must be checked here.
  if (options.agentTokenFile) {
    const verified = await verifyDeploymentRoute({
      model: options.deployment, runtime: options.runtime, origin: plan.origin,
      workspaceId: plan.workspace_id, prerequisites,
      credentialFile: options.agentTokenFile, timeoutMs,
    });
    if (!verified.ok) {
      return guardKnownCredentials(handoff(verified.outcome, verified.reason, verified.plan?.next_action ?? null, {
        profile: plan.deployment_profile, origin: plan.origin, workspaceId: plan.workspace_id,
        prerequisites: "operator_confirmed",
      }), verified);
    }
    return guardKnownCredentials({
      proceed: true, profile: plan.deployment_profile, origin: plan.origin,
      workspaceId: plan.workspace_id, prerequisites: "operator_confirmed",
      metadataAccess: "verified",
    }, verified);
  }
  return {
    proceed: true,
    profile: plan.deployment_profile,
    origin: plan.origin,
    workspaceId: plan.workspace_id,
    prerequisites: "operator_confirmed",
    metadataAccess: "pending_login",
  };
}
