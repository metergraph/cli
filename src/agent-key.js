import { verifyContext } from "./auth-oauth.js";
import { DEFAULT_ORIGIN, MAX_BODY_BYTES, METADATA_SCOPE } from "./constants.js";
import { CREDENTIAL_MIN_LENGTH, readCredentialFile } from "./deployment-credential.js";
import { checkDeployment } from "./doctor.js";
import { AGENT_TOKEN_ENV, AGENT_URL_ENV } from "./environment.js";
import { parseOrigin } from "./origin.js";
import { send } from "./transport.js";

// The read commands' second credential: a coding-agent key with Metadata
// access that a person created on the Keys page and handed to the agent's
// environment as a secret. It is for agents where browser sign in cannot
// finish (SSH, cloud workspaces, CI, some containers).
//
// The key comes only from the METERGRAPH_AGENT_TOKEN environment variable or
// from a private file named by --agent-token-file (checked as setup checks
// its agent token file). There is no argv or stdin form. The key is never
// written anywhere, never printed, and sent only as a bearer header to the
// chosen origin, and only after that origin has answered the unauthenticated
// deployment probe as a supported Metergraph service. Before any read, the
// service's own workspace and capabilities documents must show exactly the
// Metadata scope, no content access, the expected deployment profile and,
// when one is pinned, the expected workspace. A broader key fails closed:
// there is no fallback to Debug or Replay access.

const TOKEN = new RegExp(`^[\\x21-\\x7e]{${CREDENTIAL_MIN_LENGTH},8192}$`);

const stop = (outcome, reason) => ({ ok: false, outcome, reason });

// Which key source this run has, or null. An explicit file wins over the
// environment variable.
export function agentKeySource(options, env) {
  if (typeof options.agentTokenFile === "string") return { kind: "file", file: options.agentTokenFile };
  if (typeof env[AGENT_TOKEN_ENV] === "string" && env[AGENT_TOKEN_ENV] !== "") return { kind: "env" };
  return null;
}

// Where the key may be sent and what it must prove, before any request.
// A project binding pins the origin, workspace and profile; --url (or
// METERGRAPH_URL) and --workspace may repeat them but never contradict them.
// Without a binding, --workspace pins the workspace; without that, the
// key's own workspace is used and reported as unpinned.
// originConfirmed is true when this machine holds a saved sign in for the
// binding's origin, which proves the person chose that origin here.
export function keyTarget({ binding, options, env, originConfirmed = false }) {
  let requested = options.origin ?? null;
  let source = requested === null ? null : "flag";
  const rawEnv = env[AGENT_URL_ENV];
  if (requested === null && typeof rawEnv === "string" && rawEnv !== "") {
    requested = parseOrigin(rawEnv);
    if (requested === null) return stop("invalid_input", "metergraph_url_invalid");
    source = "env";
  }
  const pinned = options.workspace ?? null;
  if (binding !== null) {
    if (requested !== null && requested !== binding.origin) return stop("conflict", "bound_to_other_origin");
    // The binding is repository content, so it may come from anyone who can
    // commit. A key is sent to the origin it names only when that is the
    // hosted service, this machine signed in to it, or the person confirmed
    // the same origin with --url or METERGRAPH_URL; otherwise a committed
    // file could direct the key to another server.
    if (requested === null && binding.origin !== DEFAULT_ORIGIN && !originConfirmed) {
      return stop("conflict", "agent_key_origin_unconfirmed");
    }
    if (pinned !== null && pinned !== binding.workspace_id) return stop("conflict", "bound_to_other_workspace");
    return {
      ok: true,
      origin: binding.origin,
      workspaceId: binding.workspace_id,
      profile: binding.deployment_profile,
      originSource: "binding",
    };
  }
  return {
    ok: true,
    origin: requested ?? DEFAULT_ORIGIN,
    workspaceId: pinned,
    profile: null,
    originSource: source ?? "default",
  };
}

// Resolves with the same shape as auth-session's sessionFor:
//   { ok: true, session, documents, knownCredentials }
//   { ok: false, outcome, reason }
// verifiedProfile is the profile the caller already read from GET
// /v1/deployment under the same deadline, or null to read it here.
export async function keySession({ target, source, env, signal, verifiedProfile = null }) {
  // A key already in the environment is checked for shape before any
  // request; a key file is opened only once the origin has proven itself.
  let key = source.kind === "env" ? readAgentKey(source, env) : null;
  if (key !== null && !key.ok) return key;
  let profile = verifiedProfile;
  if (profile === null) {
    const deployment = checkDeployment(
      await send(target.origin, "/v1/deployment", { signal, maxBytes: MAX_BODY_BYTES }),
    );
    if (deployment.outcome !== null) return stop(deployment.outcome, deployment.reason);
    profile = deployment.profile;
  }
  if (target.profile !== null && profile !== target.profile) return stop("verification_failed", "profile_mismatch");

  // Only now, with the origin proven to be a supported Metergraph service,
  // is the key read.
  if (key === null) key = readAgentKey(source, env);
  if (!key.ok) return key;
  const { token } = key;

  const verified = await verifyContext(
    target.origin,
    token,
    { profile, workspaceId: target.workspaceId, anyWorkspace: target.workspaceId === null },
    signal,
  );
  if (!verified.ok) {
    if (signal?.aborted) return stop("authorization_failed", "cancelled");
    // 401: the key is unknown, expired or revoked. 403: the key is valid but
    // lacks Metadata access to this workspace (for example an ingest key).
    if (verified.denied && verified.status === 403) return stop("permission_denied", "agent_key_insufficient_scope");
    if (verified.denied) return stop("login_required", "agent_key_rejected");
    return stop(verified.outcome, verified.reason);
  }
  return {
    ok: true,
    session: {
      origin: target.origin,
      workspaceId: verified.workspaceId,
      profile,
      scopes: [METADATA_SCOPE],
      accessToken: token,
    },
    documents: verified.documents,
    // Internal only, for checking output before it is printed.
    knownCredentials: [token],
  };
}

// { ok: true, token } or { ok: false, outcome, reason } with a fixed reason.
// No path, value or system error text is ever returned.
export function readAgentKey(source, env) {
  if (source.kind === "file") {
    const read = readCredentialFile(source.file);
    if (read.ok) return read;
    // The file's own reasons, renamed so they are never mistaken for the
    // private sign in store's reasons: credential_missing becomes
    // agent_token_file_missing, and so on.
    const reason = read.reason.startsWith("credential_") ? read.reason.slice("credential_".length) : read.reason;
    return stop(read.outcome, read.reason === "platform_credential_handoff" ? read.reason : `agent_token_file_${reason}`);
  }
  let value = env[AGENT_TOKEN_ENV];
  if (typeof value !== "string") return stop("login_required", "agent_token_missing");
  if (value.endsWith("\r\n")) value = value.slice(0, -2);
  else if (value.endsWith("\n")) value = value.slice(0, -1);
  // One token only: whitespace means a label such as "Bearer", a second
  // token or a second line.
  if (!TOKEN.test(value)) return stop("invalid_input", "agent_token_malformed");
  return { ok: true, token: value };
}
