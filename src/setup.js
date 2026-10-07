import { detectRemoteSession, openBrowser } from "./auth-browser.js";
import { resolveProject } from "./auth-binding.js";
import { startCallbackListener } from "./auth-callback.js";
import { newPkce, register, endpointsFor } from "./auth-oauth.js";
import { Stop } from "./auth-store.js";
import { verifiedSession } from "./auth-session.js";
import { AUTH_HTTP_TIMEOUT_MS } from "./constants.js";
import { preflightEnv, currentEnvValues, commitEnv, isAppToken } from "./setup-env.js";
import { newSetupState, readSetupState, writeSetupState } from "./setup-state.js";
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
const fail = (outcome, reason, status = "not_ready") => ({ outcome, reason, data: { status, application_traffic_verified: false } });

// This command never receives an ingest key from argv, stdin, an environment
// variable or a Metadata OAuth grant. Only the purpose-bound redemption
// response can supply it. Every returned string is fixed and non-secret.
export async function runSetup(options, progress = () => {}) {
  if (options.runtime !== "local" || detectRemoteSession() !== null) return fail("unsupported", "run_on_local_machine");
  if (options.json && options.noBrowser) return fail("unsupported", "no_browser_requires_terminal");
  const trap = trapSignals();
  try {
    const root = resolveProject(options.project);
    const signedIn = await verifiedSession({ project: root, configDir: options.configDir, cancel: trap.signal });
    if (!signedIn.ok) return fail(signedIn.outcome, signedIn.reason);
    const { origin, workspaceId, profile } = signedIn.session;
    const plan = preflightEnv({ project: root, envFile: options.envFile, signal: trap.signal });
    const existing = currentEnvValues(plan);
    let previous = readSetupState(root);
    if (previous && (previous.value.origin !== origin || previous.value.workspace_id !== workspaceId)) {
      return fail("conflict", "setup_binding_changed");
    }
    if (!previous && existing.token !== null) return fail("conflict", "existing_ingest_key_unowned");
    if (existing.token !== null && !isAppToken(existing.token)) return fail("conflict", "existing_ingest_key_invalid");

    // A saved token is checked against this family and workspace before
    // being reused. Pending delivery is acknowledged, including after a
    // previous process stopped after the env write.
    if (previous && existing.token !== null) {
      const checked = await checkCredential(origin, existing.token, previous.value, profile, trap.signal);
      if (checked.ok) {
        if (existing.ingestUrl !== `${origin}/v1/ingest`) return fail("conflict", "ingest_url_mismatch");
        if (previous.value.key_id !== null && previous.value.key_id !== checked.keyId) {
          return fail("conflict", "setup_key_changed");
        }
        const ack = await acknowledge(origin, existing.token, previous.value, profile, checked.keyId, trap.signal);
        if (!ack.ok) return fail(ack.outcome, ack.reason, "delivery_pending");
        if (previous.value.phase !== "delivered" || previous.value.key_id === null) {
          writeSetupState(root, { ...previous.value, key_id: checked.keyId, phase: "delivered" }, previous);
        }
        return { outcome: "ok", reason: null, data: { status: "ready_for_instrumentation", application_traffic_verified: false, env: "unchanged" } };
      }
      if (!options.repair && previous.value.phase !== "redeem_attempted") return fail("verification_failed", "saved_key_unverified");
      if (previous.value.key_id === null) return fail("conflict", "repair_key_unknown");
    } else if (options.repair) {
      return fail("conflict", "repair_requires_saved_key");
    }

    const setup = await discoverSetup(origin, profile, trap.signal);
    if (!setup.ok) return fail(setup.outcome, setup.reason);

    if (previous === null) {
      writeSetupState(root, newSetupState(origin, workspaceId), null);
      previous = readSetupState(root);
    }
    const state = previous.value;
    const intent = options.repair ? "repair" : state.phase === "redeem_attempted" || state.phase === "delivered"
      ? "replace_pending" : "create";
    // An acknowledged family is never implicitly replaced. Repair requires
    // the explicit flag and the key ID saved from its original issuance.
    if (intent === "replace_pending" && state.phase === "delivered") return fail("conflict", "repair_required");
    const listener = await startCallbackListener();
    let callback;
    let clientId;
    let pkce;
    try {
      const registered = await register(endpointsFor(origin), listener.redirectUri, deadline(AUTH_HTTP_TIMEOUT_MS, trap.signal).signal);
      if (!registered.ok) return fail(registered.outcome, registered.reason);
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
      if (trap.signal.aborted) return fail("authorization_failed", "cancelled");
      if (options.noBrowser) progress(`Open this URL on this machine to approve ingest-only setup:\n${url.href}`);
      else if (!(await openBrowser(url.href))) return fail("authorization_failed", "browser_unavailable");
      else progress("Opened your browser for ingest-only setup approval.");
      callback = await pending;
    } finally {
      await listener.close();
    }
    if (callback.kind === "denied") return fail("authorization_failed", "access_denied");
    if (callback.kind === "timeout") return fail("authorization_failed", "timeout");
    if (callback.kind === "cancelled") return fail("authorization_failed", "cancelled");
    if (callback.kind !== "code" || !RECEIPT.test(callback.code)) return fail("authorization_failed", "callback_invalid");

    // Persist the ambiguity boundary before a single-use receipt is sent.
    // If the response is lost, a later run asks the browser to replace only
    // this family's pending key; it never replays the receipt.
    previous = readSetupState(root);
    if (previous?.value.family_id !== state.family_id || previous.value.origin !== origin ||
        previous.value.workspace_id !== workspaceId || previous.value.phase !== state.phase) {
      return fail("conflict", "setup_state_changed");
    }
    writeSetupState(root, { ...state, phase: "redeem_attempted" }, previous);
    previous = readSetupState(root);
    const redeemed = await redeem(origin, { code: callback.code, client_id: clientId,
      redirect_uri: listener.redirectUri, code_verifier: pkce.verifier,
      family_id: state.family_id, workspace_id: workspaceId }, profile, trap.signal);
    if (!redeemed.ok) return fail(redeemed.outcome, redeemed.reason, "delivery_pending");
    const written = await commitEnv(plan, { token: redeemed.token, ingestUrl: `${origin}/v1/ingest`, signal: trap.signal });
    const checked = await checkCredential(origin, redeemed.token, state, profile, trap.signal);
    if (!checked.ok || checked.keyId !== redeemed.keyId) return fail("verification_failed", "issued_key_unverified", "delivery_pending");
    const ack = await acknowledge(origin, redeemed.token, state, profile, redeemed.keyId, trap.signal);
    if (!ack.ok) return fail(ack.outcome, ack.reason, "delivery_pending");
    writeSetupState(root, { ...previous.value, key_id: redeemed.keyId, phase: "delivered" }, previous);
    return { outcome: "ok", reason: null, data: {
      status: "ready_for_instrumentation", application_traffic_verified: false,
      env: written.receipt.file,
    } };
  } catch (error) {
    if (error instanceof Stop) return fail(error.outcome, error.reason);
    throw error;
  } finally { trap.release(); }
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
