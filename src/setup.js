import { detectRemoteSession, openBrowser } from "./auth-browser.js";
import { readBinding, resolveProject } from "./auth-binding.js";
import { startCallbackListener } from "./auth-callback.js";
import { runLogin } from "./auth-login.js";
import { newPkce, register, endpointsFor } from "./auth-oauth.js";
import { Stop } from "./auth-store.js";
import { verifiedSession } from "./auth-session.js";
import { AUTH_HTTP_TIMEOUT_MS } from "./constants.js";
import { preflightEnv, currentEnvValues, commitEnv, isAppToken } from "./setup-env.js";
import { newSetupState, readSetupState, setupReceipt, withSetupState, writeSetupState } from "./setup-state.js";
import { runSkill } from "./skill.js";
import { parseJsonObject } from "./http.js";
import { deadline, failureOf, send, trapSignals } from "./transport.js";

export const SETUP_PATHS = Object.freeze({
  metadata: "/v1/cli/setup/metadata",
  authorize: "/v1/cli/setup/authorize",
  redeem: "/v1/cli/setup/redeem",
  credential: "/v1/cli/setup/credential",
});
const SCHEMA = "metergraph.cli-setup/v1";
const PURPOSE = "ingest-bootstrap-v1";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const RECEIPT = /^mgbs_[A-Za-z0-9_-]{32,256}$/;
const KEY = (value) => typeof value === "string" && UUID.test(value);
const fail = (outcome, reason, status = "not_ready", receipt = null) => ({ outcome, reason,
  data: { status, application_traffic_verified: false, receipt } });

// This command never receives an ingest key from argv, stdin, an environment
// variable or a Metadata OAuth grant. Only the purpose-bound redemption
// response can supply it. Every returned string is fixed and non-secret.
export async function runSetup(options, progress = () => {}) {
  if (options.runtime !== "local" || detectRemoteSession() !== null) return fail("unsupported", "run_on_local_machine");
  if (options.json && options.noBrowser) return fail("unsupported", "no_browser_requires_terminal");
  const trap = trapSignals();
  let receipt = null;
  let loginVerified = false;
  let credentialVerified = false;
  const stop = (outcome, reason, status = "not_ready") => {
    let current = receipt;
    if (current !== null && (!loginVerified || !credentialVerified)) {
      const completed = loginVerified ? ["login"] : [];
      current = { ...current, completed_steps: completed,
        pending_steps: [
          ...(!loginVerified ? ["login"] : []), "credential", "skill", "instrument", "verify", "view",
        ] };
    }
    return fail(outcome, reason, status, current);
  };
  try {
    const root = resolveProject(options.project);
    const saved = readSetupState(root);
    if (saved) receipt = setupReceipt(saved.value);
    const bound = readBinding(root)?.binding ?? null;
    const intendedOrigin = options.originExplicit ? options.origin : bound?.origin ?? saved?.value.origin ?? options.origin;
    const intendedWorkspace = options.workspace ?? saved?.value.workspace_id ?? null;
    // A family already tied to a workspace cannot be carried across a
    // reconnect. Refuse before login changes the Metadata binding or the env.
    if (saved && (saved.value.origin !== intendedOrigin || saved.value.workspace_id !== intendedWorkspace ||
        (bound !== null && (bound.origin !== saved.value.origin || bound.workspace_id !== saved.value.workspace_id)))) {
      return stop("conflict", "setup_binding_changed");
    }
    const bindingDiffers = bound !== null && (bound.origin !== intendedOrigin ||
      (intendedWorkspace !== null && bound.workspace_id !== intendedWorkspace));
    if (bindingDiffers && !options.reconnect) return stop("conflict", "bound_to_other_workspace");
    let signedIn = bindingDiffers || options.reconnect ? { ok: false, outcome: "login_required" } :
      await verifiedSession({ project: root, configDir: options.configDir, cancel: trap.signal });
    if (!signedIn.ok && signedIn.outcome === "login_required") {
      const login = await runLogin({ ...options, origin: intendedOrigin, workspace: intendedWorkspace,
        project: root, reconnect: options.reconnect, expectedProfile: options.expectedProfile ?? null }, progress);
      if (login.outcome !== "ok") return stop(login.outcome, login.reason, "login_pending");
      signedIn = await verifiedSession({ project: root, configDir: options.configDir, cancel: trap.signal });
    }
    if (!signedIn.ok) return stop(signedIn.outcome, signedIn.reason, "login_pending");
    const { origin, workspaceId, profile } = signedIn.session;
    if (options.expectedProfile && profile !== options.expectedProfile) {
      return stop("unsupported", "deployment_profile_mismatch", "login_pending");
    }
    if (origin !== intendedOrigin || (intendedWorkspace !== null && workspaceId !== intendedWorkspace)) {
      return stop("verification_failed", "workspace_mismatch", "login_pending");
    }
    loginVerified = true;
    const plan = preflightEnv({ project: root, envFile: options.envFile, signal: trap.signal });
    const existing = currentEnvValues(plan);
    let previous = readSetupState(root);
    if (previous) receipt = setupReceipt(previous.value);
    if (previous && (previous.value.origin !== origin || previous.value.workspace_id !== workspaceId)) {
      return stop("conflict", "setup_binding_changed");
    }
    if (previous && previous.value.deployment_profile !== null && previous.value.deployment_profile !== profile) {
      return stop("conflict", "setup_profile_changed");
    }
    // Upgrade a pre-composition state, or record the current client choice.
    // A changed client leaves the existing key untouched and marks the new
    // client's skill pending until its own installer confirms ownership.
    if (previous && (previous.value.deployment_profile === null ||
        previous.value.selected_client !== options.client ||
        (options.client === null && previous.value.skill_status !== "skipped"))) {
      const next = withSetupState(previous.value, { deployment_profile: profile,
        selected_client: options.client, skill_status: options.client === null ? "skipped" : "pending" });
      writeSetupState(root, next, previous);
      previous = readSetupState(root);
      receipt = setupReceipt(previous.value);
    }
    if (!previous && existing.token !== null) return stop("conflict", "existing_ingest_key_unowned");
    if (existing.token !== null && !isAppToken(existing.token)) return stop("conflict", "existing_ingest_key_invalid");

    // A saved token is checked against this family and workspace before
    // being reused. Pending delivery is acknowledged, including after a
    // previous process stopped after the env write.
    if (previous && existing.token !== null) {
      const checked = await checkCredential(origin, existing.token, previous.value, profile, trap.signal);
      if (checked.ok) {
        if (existing.ingestUrl !== `${origin}/v1/ingest`) return stop("conflict", "ingest_url_mismatch");
        if (previous.value.key_id !== null && previous.value.key_id !== checked.keyId) {
          return stop("conflict", "setup_key_changed");
        }
        const ack = await acknowledge(origin, existing.token, previous.value, profile, checked.keyId, trap.signal);
        if (!ack.ok) return stop(ack.outcome, ack.reason, "delivery_pending");
        credentialVerified = true;
        if (previous.value.phase !== "delivered" || previous.value.key_id === null) {
          writeSetupState(root, withSetupState(previous.value, { key_id: checked.keyId, phase: "delivered" }), previous);
        }
        return finishSkill(root, options, "unchanged");
      }
      if (!options.repair && previous.value.phase !== "redeem_attempted") return stop("verification_failed", "saved_key_unverified");
      if (options.repair && previous.value.key_id === null) return stop("conflict", "repair_key_unknown");
    } else if (options.repair && (previous === null || previous.value.key_id === null)) {
      return stop("conflict", "repair_requires_saved_key");
    }

    const setup = await discoverSetup(origin, profile, trap.signal);
    if (!setup.ok) return stop(setup.outcome, setup.reason);

    if (previous === null) {
      writeSetupState(root, newSetupState(origin, workspaceId, profile, options.client), null);
      previous = readSetupState(root);
      receipt = setupReceipt(previous.value);
    }
    const state = previous.value;
    const intent = options.repair ? "repair" : state.phase === "redeem_attempted" || state.phase === "delivered"
      ? "replace_pending" : "create";
    // An acknowledged family is never implicitly replaced. Repair requires
    // the explicit flag and the key ID saved from its original issuance.
    if (intent === "replace_pending" && state.phase === "delivered") return stop("conflict", "repair_required");
    const listener = await startCallbackListener();
    let callback;
    let clientId;
    let pkce;
    try {
      const registered = await register(endpointsFor(origin), listener.redirectUri, deadline(AUTH_HTTP_TIMEOUT_MS, trap.signal).signal);
      if (!registered.ok) return stop(registered.outcome, registered.reason);
      clientId = registered.clientId;
      pkce = newPkce();
      const pending = listener.wait({ state: pkce.state, issuer: `${origin}/v1/oauth`, requireIss: false,
        timeoutMs: options.timeoutMs, cancel: trap.signal });
      const url = new URL(`${origin}${SETUP_PATHS.authorize}`);
      const params = {
        client_id: clientId, redirect_uri: listener.redirectUri, state: pkce.state,
        code_challenge: pkce.challenge, code_challenge_method: "S256",
        workspace_id: workspaceId, family_id: state.family_id, intent,
      };
      if (intent === "repair") params.expected_key_id = state.key_id;
      url.search = new URLSearchParams(params).toString();
      if (trap.signal.aborted) return stop("authorization_failed", "cancelled");
      if (options.noBrowser) progress(`Open this URL on this machine to approve ingest-only setup:\n${url.href}`);
      else if (!(await openBrowser(url.href))) return stop("authorization_failed", "browser_unavailable");
      else progress("Opened your browser for ingest-only setup approval.");
      callback = await pending;
    } finally {
      await listener.close();
    }
    if (callback.kind === "denied") return stop("authorization_failed", "access_denied");
    if (callback.kind === "timeout") return stop("authorization_failed", "timeout");
    if (callback.kind === "cancelled") return stop("authorization_failed", "cancelled");
    if (callback.kind !== "code" || !RECEIPT.test(callback.code)) return stop("authorization_failed", "callback_invalid");

    // Persist the ambiguity boundary before a single-use receipt is sent.
    // If the response is lost, a later run asks the browser to replace only
    // this family's pending key; it never replays the receipt.
    previous = readSetupState(root);
    if (previous === null || JSON.stringify(previous.value) !== JSON.stringify(state)) {
      return stop("conflict", "setup_state_changed");
    }
    writeSetupState(root, withSetupState(previous.value, { phase: "redeem_attempted" }), previous);
    previous = readSetupState(root);
    const redeemed = await redeem(origin, { code: callback.code, client_id: clientId,
      redirect_uri: listener.redirectUri, code_verifier: pkce.verifier,
      family_id: state.family_id, workspace_id: workspaceId }, profile, trap.signal);
    if (!redeemed.ok) return stop(redeemed.outcome, redeemed.reason, "delivery_pending");
    const written = await commitEnv(plan, { token: redeemed.token, ingestUrl: `${origin}/v1/ingest`, signal: trap.signal });
    const checked = await checkCredential(origin, redeemed.token, state, profile, trap.signal);
    if (!checked.ok || checked.keyId !== redeemed.keyId) return stop("verification_failed", "issued_key_unverified", "delivery_pending");
    const ack = await acknowledge(origin, redeemed.token, state, profile, redeemed.keyId, trap.signal);
    if (!ack.ok) return stop(ack.outcome, ack.reason, "delivery_pending");
    credentialVerified = true;
    writeSetupState(root, withSetupState(previous.value, { key_id: redeemed.keyId, phase: "delivered" }), previous);
    return finishSkill(root, options, written.receipt.file);
  } catch (error) {
    if (error instanceof Stop) return stop(error.outcome, error.reason);
    throw error;
  } finally { trap.release(); }
}

function finishSkill(root, options, envStatus) {
  let previous = readSetupState(root);
  if (previous === null || previous.value.phase !== "delivered") return fail("conflict", "setup_state_changed");
  if (previous.value.selected_client !== options.client) {
    return fail("conflict", "setup_state_changed", "credential_ready_skill_pending", setupReceipt(previous.value));
  }
  if (options.skipSkill) {
    if (previous.value.skill_status !== "skipped") {
      writeSetupState(root, withSetupState(previous.value, { selected_client: null, skill_status: "skipped" }), previous);
      previous = readSetupState(root);
    }
    return { outcome: "ok", reason: null, data: { status: "ready_for_instrumentation",
      application_traffic_verified: false, env: envStatus, skill: "skipped", receipt: setupReceipt(previous.value) } };
  }
  let skill = runSkill({ action: "install", client: options.client, runtime: "local", project: root });
  if (skill.reason === "update_required") {
    skill = runSkill({ action: "update", client: options.client, runtime: "local", project: root });
  }
  // Another process may have chosen a different client while installation
  // ran. Re-read before changing the receipt, and let the CAS protect writes.
  previous = readSetupState(root);
  if (previous === null || previous.value.phase !== "delivered" ||
      previous.value.selected_client !== options.client) {
    return fail("conflict", "setup_state_changed", "credential_ready_skill_pending",
      previous === null ? null : setupReceipt(previous.value));
  }
  if (skill.outcome !== "ok") {
    if (previous.value.skill_status === "installed") {
      writeSetupState(root, withSetupState(previous.value, { skill_status: "pending" }), previous);
      previous = readSetupState(root);
    }
    return fail(skill.outcome, skill.reason, "credential_ready_skill_pending", setupReceipt(previous.value));
  }
  if (previous.value.skill_status !== "installed") {
    writeSetupState(root, withSetupState(previous.value, { skill_status: "installed" }), previous);
    previous = readSetupState(root);
  }
  return { outcome: "ok", reason: null, data: { status: "ready_for_instrumentation",
    application_traffic_verified: false, env: envStatus, skill: skill.data.status,
    receipt: setupReceipt(previous.value) } };
}

async function discoverSetup(origin, profile, cancel) {
  const response = await send(origin, SETUP_PATHS.metadata, { signal: deadline(AUTH_HTTP_TIMEOUT_MS, cancel).signal, maxBytes: 32768 });
  const failed = failureOf(response);
  if (failed) return { ok: false, ...failed };
  if (response.status !== 200) return { ok: false, outcome: "unsupported", reason: "setup_discovery_unavailable" };
  const doc = parseJsonObject(response);
  if (doc?.schema_version !== SCHEMA || doc.supported !== true || doc.unsupported_reason !== null ||
    doc.resource !== `${origin}/v1/cli/setup` || doc.purpose !== PURPOSE ||
    doc.deployment_profile !== profile || doc.credential_scope !== "ingest" ||
    doc.authorization_endpoint !== `${origin}${SETUP_PATHS.authorize}` ||
    doc.redemption_endpoint !== `${origin}${SETUP_PATHS.redeem}` ||
    doc.credential_endpoint !== `${origin}${SETUP_PATHS.credential}` ||
    doc.registration_endpoint !== `${origin}/v1/oauth/register` ||
    !Array.isArray(doc.profiles_supported) || !doc.profiles_supported.includes(profile) ||
    !Array.isArray(doc.intents_supported) || !["create", "replace_pending", "repair"].every((x) => doc.intents_supported.includes(x)) ||
    !Array.isArray(doc.code_challenge_methods_supported) || !doc.code_challenge_methods_supported.includes("S256")) {
    return { ok: false, outcome: "unsupported", reason: "setup_contract_mismatch" };
  }
  return { ok: true };
}

async function redeem(origin, form, profile, cancel) {
  const response = await send(origin, SETUP_PATHS.redeem, { method: "POST", form,
    signal: deadline(AUTH_HTTP_TIMEOUT_MS, cancel).signal, maxBytes: 32768 });
  const failed = failureOf(response);
  if (failed) return { ok: false, ...failed };
  if (response.status !== 200) return { ok: false, outcome: "authorization_failed", reason: "setup_redeem_rejected" };
  const body = parseJsonObject(response);
  if (body?.schema_version !== SCHEMA || body.token_type !== "ingest" || body.scope !== "ingest" ||
      body.delivery_state !== "pending" || body.workspace_id !== form.workspace_id ||
      body.family_id !== form.family_id || !KEY(body.key_id) || !isAppToken(body.ingest_token) ||
      body.deployment?.origin !== origin || body.deployment?.profile !== profile) {
    return { ok: false, outcome: "verification_failed", reason: "setup_response_invalid" };
  }
  return { ok: true, token: body.ingest_token, keyId: body.key_id };
}

async function checkCredential(origin, token, state, profile, cancel) {
  const response = await send(origin, SETUP_PATHS.credential, { bearer: token,
    query: new URLSearchParams({ family_id: state.family_id }),
    signal: deadline(AUTH_HTTP_TIMEOUT_MS, cancel).signal, maxBytes: 32768 });
  const failed = failureOf(response);
  if (failed) return { ok: false, ...failed };
  if (response.status !== 200) return { ok: false, outcome: "verification_failed", reason: "credential_rejected" };
  const doc = parseJsonObject(response);
  if (doc?.schema_version !== SCHEMA || doc.provenance?.origin !== origin ||
      doc.provenance?.deployment_profile !== profile || doc.provenance?.purpose !== PURPOSE ||
      doc.workspace_id !== state.workspace_id || doc.family_id !== state.family_id || !KEY(doc.key_id) ||
      !["pending", "acknowledged"].includes(doc.delivery_state) ||
      !Array.isArray(doc.scopes) || doc.scopes.length !== 1 || doc.scopes[0] !== "ingest") {
    return { ok: false, outcome: "verification_failed", reason: "credential_context_mismatch" };
  }
  return { ok: true, keyId: doc.key_id, deliveryState: doc.delivery_state };
}

async function acknowledge(origin, token, state, profile, keyId, cancel) {
  const response = await send(origin, SETUP_PATHS.credential, { method: "POST", bearer: token,
    form: { family_id: state.family_id }, signal: deadline(AUTH_HTTP_TIMEOUT_MS, cancel).signal, maxBytes: 32768 });
  const failed = failureOf(response);
  if (failed) return { ok: false, ...failed };
  if (response.status !== 200) return { ok: false, outcome: "verification_failed", reason: "acknowledgement_rejected" };
  const doc = parseJsonObject(response);
  if (doc?.schema_version !== SCHEMA || doc.provenance?.origin !== origin ||
      doc.provenance?.deployment_profile !== profile || doc.provenance?.purpose !== PURPOSE ||
      doc.workspace_id !== state.workspace_id || doc.family_id !== state.family_id ||
      doc.key_id !== keyId || doc.delivery_state !== "acknowledged" ||
      !Array.isArray(doc.scopes) || doc.scopes.length !== 1 || doc.scopes[0] !== "ingest") {
    return { ok: false, outcome: "verification_failed", reason: "acknowledgement_invalid" };
  }
  return { ok: true };
}
