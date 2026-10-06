import { endpointsFor, refreshGrant, verifyContext } from "./auth-oauth.js";
import { readBinding, resolveProject } from "./auth-binding.js";
import { Stop, openStore, readCredential, resolveConfigDir, withSlotLock, writeCredential } from "./auth-store.js";
import { AUTH_HTTP_TIMEOUT_MS, METADATA_SCOPE } from "./constants.js";
import { deadline } from "./transport.js";

// The verified session that later read commands build on. It never opens a
// browser and never writes the project binding. It returns an access token
// only to the calling code, never for output.

// Access tokens closer than this to expiry are refreshed first.
const REFRESH_MARGIN_MS = 60 * 1000;
// Long enough for another process to finish one refresh request.
export const LOCK_WAIT_MS = AUTH_HTTP_TIMEOUT_MS + 5000;

// Resolves with
//   { ok: true, session: { origin, workspaceId, profile, scopes, accessToken }, documents, knownCredentials }
//   { ok: false, outcome, reason }
// documents holds the workspace and capabilities documents the service
// returned during verification, already checked by verifyContext.
// for the project's binding. Throws nothing for expected failures.
export async function verifiedSession({ project = null, configDir = null, cancel = null } = {}) {
  try {
    const root = resolveProject(project);
    const store = openStore(resolveConfigDir(configDir), { create: false });
    const found = readBinding(root);
    if (found === null) return stop("login_required", "not_signed_in");
    return await sessionFor(found.binding, store, cancel);
  } catch (error) {
    if (error instanceof Stop) return stop(error.outcome, error.reason);
    throw error;
  }
}

// The same, for a binding and store already read by the caller. store may be
// null when the private store does not exist.
export async function sessionFor(binding, store, cancel) {
  if (store === null) return stop("login_required", "credential_missing");
  const slot = binding.credential_slot;
  let record = readCredential(store, slot);
  if (record === null) return stop("login_required", "credential_missing");
  const context = checkIdentity(record, binding);
  if (!context.ok) return context;

  // Every token value this session has seen, including ones a refresh
  // replaced, so a caller can refuse to print a response that echoes one.
  const known = new Set([record.access_token, record.refresh_token]);

  // A pending mark seen here may belong to a refresh another process is
  // running right now, so it is judged only under the lock. A deadline or
  // Ctrl+C stops the wait for another process's lock.
  if (record.refresh_pending || record.expires_at - Date.now() <= REFRESH_MARGIN_MS) {
    let refreshed;
    try {
      refreshed = await withSlotLock(store, slot, () => refreshLocked(store, slot, binding, cancel), {
        waitMs: LOCK_WAIT_MS,
        signal: cancel,
      });
    } catch (error) {
      if (error instanceof Stop && error.reason === "cancelled") return stop(error.outcome, error.reason);
      throw error;
    }
    if (!refreshed.ok) return refreshed;
    record = refreshed.record;
    for (const seen of [refreshed.previous, record]) {
      if (seen) known.add(seen.access_token).add(seen.refresh_token);
    }
  }

  const limit = deadline(AUTH_HTTP_TIMEOUT_MS, cancel);
  const verified = await verifyContext(
    binding.origin,
    record.access_token,
    { profile: binding.deployment_profile, workspaceId: binding.workspace_id },
    limit.signal,
  );
  if (!verified.ok) {
    // The service refused a token that was valid when issued: the grant was
    // revoked, or the user lost access to the workspace. Fail closed.
    if (verified.denied) return stop("login_required", "access_revoked");
    if (cancel?.aborted) return stop("authorization_failed", "cancelled");
    return verified;
  }
  return {
    ok: true,
    session: {
      origin: binding.origin,
      workspaceId: binding.workspace_id,
      profile: binding.deployment_profile,
      scopes: [METADATA_SCOPE],
      accessToken: record.access_token,
    },
    documents: verified.documents,
    // Internal only: for checking output before it is printed. Never part
    // of a result, envelope, log or file.
    knownCredentials: [...known],
  };
}

// The stored grant must be for exactly the bound origin, workspace and
// profile.
function checkIdentity(record, binding) {
  if (
    record.origin !== binding.origin ||
    record.workspace_id !== binding.workspace_id ||
    record.deployment_profile !== binding.deployment_profile
  ) {
    return stop("login_required", "credential_context_mismatch");
  }
  return { ok: true };
}

// Under the lock, a pending mark means a refresh that did not finish: its
// refresh token may have been used, so it is never sent again.
function checkContext(record, binding) {
  const identity = checkIdentity(record, binding);
  if (!identity.ok) return identity;
  if (record.refresh_pending) return stop("login_required", "reconnect_required");
  return { ok: true };
}

// Runs under the slot lock. Reads the record again, because another process
// may have refreshed it while this one waited. Before the refresh token is
// sent, the record is marked refresh_pending on disk. The mark is cleared
// only when the outcome is known: the new grant is saved, or the request was
// never sent. Any other ending (timeout after sending, a lost response, an
// unusable answer, a failed save or a killed process) leaves the mark, so the
// possibly consumed refresh token is never sent again and the user is asked
// to reconnect.
async function refreshLocked(store, slot, binding, cancel) {
  const current = readCredential(store, slot);
  if (current === null) return stop("login_required", "credential_missing");
  const context = checkContext(current, binding);
  if (!context.ok) return context;
  if (current.expires_at - Date.now() > REFRESH_MARGIN_MS) return { ok: true, record: current };

  writeCredential(store, slot, { ...current, refresh_pending: true });
  const endpoints = endpointsFor(binding.origin);
  const limit = deadline(AUTH_HTTP_TIMEOUT_MS, cancel);
  const result = await refreshGrant(
    endpoints,
    { clientId: current.client_id, refreshToken: current.refresh_token },
    limit.signal,
  );
  if (!result.ok) {
    if (!result.ambiguous && result.outcome === "connection_failed") {
      writeCredential(store, slot, current);
      return stop(cancel?.aborted ? "authorization_failed" : "connection_failed", cancel?.aborted ? "cancelled" : result.reason);
    }
    if (!result.ambiguous) return stop("login_required", "grant_rejected");
    return stop("login_required", "refresh_interrupted");
  }
  if (result.grant.tenant !== binding.workspace_id) {
    return stop("login_required", "credential_context_mismatch");
  }
  const next = {
    ...current,
    access_token: result.grant.accessToken,
    refresh_token: result.grant.refreshToken ?? current.refresh_token,
    expires_at: result.grant.expiresAt,
    refresh_pending: false,
  };
  try {
    writeCredential(store, slot, next);
  } catch (error) {
    if (error instanceof Stop) return stop("login_required", "refresh_not_saved");
    throw error;
  }
  return { ok: true, record: next, previous: current };
}

function stop(outcome, reason) {
  return { ok: false, outcome, reason };
}
