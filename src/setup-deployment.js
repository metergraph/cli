import { detectRemoteSession } from "./auth-browser.js";
import { runDoctor } from "./doctor.js";
import { action, planDeploymentRoute, verifyDeploymentRoute } from "./deployment-route.js";
import { AUTH_HTTP_TIMEOUT_MS } from "./constants.js";
import { resolveProject } from "./auth-binding.js";
import { readSetupState } from "./setup-state.js";

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

const DEPLOYMENT_FOR_PROFILE = Object.freeze({ local: "customer-local", "byoc-core": "byoc" });

// Fixed guidance for each prerequisite, so a person or agent can act on a
// handoff without the docs. None of it names a credential value, and none of
// it asks for a credential to be passed to this CLI.
const PREREQUISITE_GUIDE = Object.freeze({
  released_signed_bundle: "Download the released customer-local bundle and its signed manifest, and verify the signature before starting it. A bundle built from source is not a release.",
  registry_invitation: "Accept the workspace's registry invitation so the bundle can pull its images. The registry pull credential is only for pulling images: never give it to this CLI or put it in the project env file.",
  bundle_started_verified: "Start the bundle with bin/start and wait until bin/status reports it healthy. Pass its origin as --url and the workspace ID that bin/status shows as --workspace.",
  local_admin_configured: "Sign in to the installation once as its local admin, in a browser on this machine. Setup asks that account to approve sign in and an ingest-only key.",
  operator_provisioning: "The operator must already have provisioned the customer-owned AWS deployment. Setup connects to it and never provisions anything.",
  private_network_reachability: "Run setup from a machine that reaches the deployment's private HTTPS origin, for example over the customer VPN. Setup never opens a tunnel or a public endpoint.",
  identity_membership_configured: "The operator must already have given your identity membership of the workspace through the deployment's configured identity provider.",
  server_distribution_installed: "The open source server must already be installed and running under the operator's management.",
  deployment_discovery_supported: "The open source server must answer GET /v1/deployment with the oss profile. If it does not, ask the operator to upgrade it.",
  metadata_scope_supported: "The open source server must advertise the agent:metadata scope in its OAuth metadata. If it does not, ask the operator to upgrade it.",
  ingestion_tokens_configured: "The operator configures ingestion tokens in MG_TOKENS and gives the application one as METERGRAPH_APP_TOKEN. Setup never issues or writes open source ingest tokens.",
  agent_read_tokens_configured: "The operator configures agent read tokens in MG_AGENT_TOKENS, separately from MG_TOKENS. Never reuse an ingestion token for agent reads.",
});
const METADATA_CREDENTIAL_GUIDE = Object.freeze({
  local: "Setup obtains its own Metadata-only sign in through the browser. --agent-token-file is optional and must hold a Metadata-only agent token.",
  "byoc-core": "Setup obtains its own Metadata-only sign in through the browser. --agent-token-file is optional and must hold a Metadata-only agent token.",
  oss: "Put one MG_AGENT_TOKENS value in a private file (mode 0600) and pass its absolute path as --agent-token-file.",
});
const ACTION_GUIDE = Object.freeze({
  complete_prerequisite: "Complete the named prerequisite, then rerun setup with --confirm-prerequisites.",
  oss_operator_handoff: "Ask the open source server operator to complete this step. This CLI does not create open source credentials or change the server.",
  run_on_customer_machine: "Run setup in a terminal on the machine that reaches the deployment. Setup does not tunnel or forward credentials from a remote or cloud session.",
  use_https_origin: "Pass the deployment's HTTPS origin. A customer-owned AWS deployment is never reached over plain HTTP.",
  connection_guide: "Check that --url is the installation's own origin and that it reports the expected deployment profile.",
  check_private_network: "This machine cannot reach the private origin. Connect to the deployment's network, for example over the customer VPN, and rerun. Do not expose the deployment publicly.",
  platform_credential_handoff: "This platform cannot prove the agent token file is private. Rerun without --agent-token-file, or on macOS or Linux.",
  fix_credential_file: "Make --agent-token-file an absolute path to a regular file you own, with mode 0600, holding one token.",
  use_metadata_only_credential: "The agent token was refused or has more than Metadata access. Use a Metadata-only agent token for this workspace.",
  retry: "Rerun the same command.",
});

export function prerequisiteGuide(name, profile) {
  if (name === "metadata_agent_credential") return METADATA_CREDENTIAL_GUIDE[profile] ?? null;
  return PREREQUISITE_GUIDE[name] ?? null;
}

function guided(nextAction, profile) {
  if (nextAction === null) return null;
  const message = nextAction.kind === "complete_prerequisite" && nextAction.prerequisite !== null
    ? prerequisiteGuide(nextAction.prerequisite, profile) : ACTION_GUIDE[nextAction.kind] ?? null;
  return { ...nextAction, message };
}

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
    next_action: guided(nextAction, details.profile ?? null),
  },
});

// The next action when the service did not answer as a healthy deployment.
// An unreachable customer-local origin usually means the bundle is not
// running; an unreachable BYOC origin is private networking. Neither is
// tunnelled or relaxed.
function unreachedAction(deployment, outcome) {
  if (deployment === "oss") return action("oss_operator_handoff");
  if (outcome !== "connection_failed") return action("connection_guide");
  if (deployment === "byoc") return action("check_private_network");
  return action("complete_prerequisite", "bundle_started_verified");
}

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

export async function preflightNonHostedSetup(options, { env = process.env } = {}) {
  const planned = planNonHostedSetup(options);
  if (!planned.proceed) return planned;
  const { plan, prerequisites } = planned;
  // Setup itself refuses a remote session, but only after this preflight.
  // Refuse here first, so a remote shell sends no request and never reads the
  // separate agent token file.
  if (detectRemoteSession(env) !== null) {
    return handoff("unsupported", "run_on_local_machine", action("run_on_customer_machine"), {
      profile: plan.deployment_profile, origin: plan.origin, workspaceId: plan.workspace_id,
    });
  }
  const timeoutMs = Math.min(options.timeoutMs, AUTH_HTTP_TIMEOUT_MS);
  if (options.deployment === "oss" && !options.agentTokenFile) {
    return handoff("unsupported", "oss_agent_token_file_required", action("oss_operator_handoff"), {
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
    return guardKnownCredentials(handoff("unsupported", "oss_ingest_operator_handoff", action("oss_operator_handoff"), {
      profile: plan.deployment_profile, origin: plan.origin, workspaceId: plan.workspace_id,
      prerequisites: "operator_confirmed", metadataAccess: "verified",
    }), verified);
  }

  // Every non-hosted route proves the service profile before any login, local
  // binding, credential read or ingest-key write. runDoctor rejects redirects
  // and unsafe network responses and reports only a fixed profile token.
  const doctor = await runDoctor({ origin: plan.origin, timeoutMs });
  if (doctor.report.deployment_profile !== null && doctor.report.deployment_profile !== plan.deployment_profile) {
    return handoff("unsupported", "deployment_profile_mismatch", action("connection_guide"), {
      profile: plan.deployment_profile, origin: plan.origin, workspaceId: plan.workspace_id,
      prerequisites: "operator_confirmed",
    });
  }
  if (doctor.outcome !== "authentication_required") {
    return handoff(doctor.outcome, doctor.reason, unreachedAction(options.deployment, doctor.outcome), {
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

// A rerun of non-hosted setup may omit the route it was first given, as a
// hosted rerun does. Only a saved setup state for a customer-local or BYOC
// route is resumed, and only to that same origin and workspace. The earlier
// run's operator confirmation stands for that route; every live check still
// runs again. Anything else is left for setup's own conflict checks.
export function resumeNonHostedRoute(options) {
  let saved;
  try {
    saved = readSetupState(resolveProject(options.project));
  } catch {
    return options;
  }
  const deployment = DEPLOYMENT_FOR_PROFILE[saved?.value.deployment_profile];
  if (deployment === undefined) return options;
  const { origin, workspace_id: workspaceId } = saved.value;
  const sameRoute = (!options.originExplicit || options.origin === origin) &&
    (options.workspace === null || options.workspace === workspaceId);
  if (!sameRoute) return options;
  if (!options.deploymentExplicit) {
    return { ...options, deployment, origin, originExplicit: true, workspace: workspaceId, confirmPrerequisites: true };
  }
  if (options.deployment === deployment && options.originExplicit) return { ...options, confirmPrerequisites: true };
  return options;
}
