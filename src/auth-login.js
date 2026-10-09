import { detectRemoteSession, openBrowser } from "./auth-browser.js";
import { startCallbackListener } from "./auth-callback.js";
import {
  BINDING_PATH,
  bindingFor,
  readBinding,
  removeBinding,
  resolveProject,
  writeBinding,
} from "./auth-binding.js";
import {
  authorizationUrl,
  clientFor,
  discover,
  endpointsFor,
  exchangeCode,
  newPkce,
  revoke,
  verifyContext,
} from "./auth-oauth.js";
import { LOCK_WAIT_MS, sessionFor } from "./auth-session.js";
import {
  PROTECTION,
  Stop,
  deleteCredential,
  newSlot,
  openStore,
  readCredential,
  resolveConfigDir,
  withSlotLock,
  writeCredential,
} from "./auth-store.js";
import { AUTH_HTTP_TIMEOUT_MS, CONNECTION_GUIDE_URL, METADATA_SCOPE } from "./constants.js";
import { runDoctor } from "./doctor.js";
import { deadline, trapSignals } from "./transport.js";

// login and logout. Each returns { outcome, reason, data }; every string in
// data is a fixed token, the validated origin, a supported profile or a
// server-verified workspace UUID. Token values, the authorization code, the
// PKCE verifier, absolute paths and server text never leave this module.
// progress(text) prints human progress lines; it is a no-op with --json.
// options.announce(data), given only with --json --no-browser, receives the
// login data with an open_url next action as soon as the authorization URL
// exists, while the listener keeps waiting. The caller prints it as the one
// JSON line, so an agent can hand the URL to a person; approval-handoff.js
// lets the agent's command exit then while this process keeps waiting.

export async function runLogin(options, progress) {
  const ctx = {
    origin: options.origin,
    runtime: options.runtime,
    profile: null,
    workspaceId: null,
    authenticated: false,
    configured: false,
    status: null,
    previousGrant: null,
  };
  const end = (outcome, reason, next = null) => ({ outcome, reason, data: loginData(ctx, next) });

  // Handoffs come first: no listener, request or file write happens for a
  // session that cannot finish sign in.
  if (options.runtime !== "local") return end("unsupported", "runtime_not_supported", GUIDE);
  const remote = detectRemoteSession();
  if (remote !== null) return end("unsupported", remote, GUIDE);
  const trap = trapSignals();
  try {
    const root = resolveProject(options.project);
    const configDir = resolveConfigDir(options.configDir);
    const existing = readBinding(root);
    const bound = existing?.binding ?? null;
    // Setup pins a deployment model before sign in. A stale binding for a
    // different profile must never be silently reused or reconnected.
    if (options.expectedProfile && bound !== null && !options.reconnect &&
        bound.deployment_profile !== options.expectedProfile) {
      return end("conflict", "deployment_profile_mismatch");
    }
    if (bound !== null && !options.reconnect) {
      if (bound.origin !== options.origin) return end("conflict", "bound_to_other_origin", RECONNECT);
      if (options.workspace !== null && options.workspace !== bound.workspace_id) {
        return end("conflict", "bound_to_other_workspace", RECONNECT);
      }
    }
    const store = openStore(configDir, { create: true });

    // A rerun with a working grant changes nothing and opens no browser.
    if (bound !== null && !options.reconnect) {
      const session = await sessionFor(bound, store, trap.signal);
      if (session.ok) {
        Object.assign(ctx, {
          profile: bound.deployment_profile,
          workspaceId: bound.workspace_id,
          authenticated: true,
          configured: true,
          status: "reused",
        });
        return end("ok", null, CONNECTED);
      }
      if (session.outcome !== "login_required") return end(session.outcome, session.reason);
    }

    const announce = options.announce
      ? (next) => options.announce(loginData({ ...ctx, status: "approval_pending" }, next))
      : null;
    const flow = await authorize(options, ctx, trap.signal, progress, announce);
    if (!flow.ok) return end(flow.outcome, flow.reason, flow.next ?? null);
    const { endpoints, clientId, grant } = flow;

    // The browser chose the workspace. Bind only one that matches what
    // this project is already bound to, unless the user asked to switch.
    if (bound !== null && !options.reconnect && grant.tenant !== bound.workspace_id) {
      await revokeQuietly(endpoints, clientId, grant.refreshToken);
      return end("conflict", "bound_to_other_workspace", RECONNECT);
    }

    const slot = newSlot();
    try {
      writeCredential(store, slot, {
        schema_version: 1,
        origin: ctx.origin,
        issuer: endpoints.issuer,
        resource: endpoints.resource,
        deployment_profile: ctx.profile,
        workspace_id: grant.tenant,
        client_id: clientId,
        scope: METADATA_SCOPE,
        access_token: grant.accessToken,
        refresh_token: grant.refreshToken,
        expires_at: grant.expiresAt,
        refresh_pending: false,
      });
    } catch (error) {
      await revokeQuietly(endpoints, clientId, grant.refreshToken);
      throw error;
    }
    try {
      writeBinding(root, bindingFor({ origin: ctx.origin, workspaceId: grant.tenant, profile: ctx.profile, slot }), existing);
    } catch (error) {
      let cleaned = true;
      try {
        deleteCredential(store, slot);
      } catch {
        cleaned = false;
      }
      await revokeQuietly(endpoints, clientId, grant.refreshToken);
      if (!cleaned) return end("filesystem_error", "binding_partial_write");
      throw error;
    }
    Object.assign(ctx, { authenticated: true, configured: true, status: bound === null ? "signed_in" : "reconnected" });

    // The old grant is no longer referenced. Ask the service to revoke it
    // and remove it locally; neither affects the new binding.
    if (bound !== null && bound.credential_slot !== slot) {
      ctx.previousGrant = await retireSlot(store, bound);
    }
    return end("ok", null, CONNECTED);
  } catch (error) {
    if (error instanceof Stop) return end(error.outcome, error.reason);
    throw error;
  } finally {
    trap.release();
  }
}

// Preflight, discovery, the client (offered or newly registered), the browser
// round trip, the code exchange and server-side verification. Nothing is
// written here. A validated grant that is not accepted is sent for revocation
// before returning; that is best effort, and a token response that fails
// validation cannot be revoked.
async function authorize(options, ctx, cancel, progress, announce) {
  const preflight = await runDoctor({ origin: ctx.origin, timeoutMs: AUTH_HTTP_TIMEOUT_MS });
  if (cancel.aborted) return fail("authorization_failed", "cancelled");
  if (preflight.outcome !== "authentication_required") return fail(preflight.outcome, preflight.reason);
  ctx.profile = preflight.report.deployment_profile;
  if (options.expectedProfile && ctx.profile !== options.expectedProfile) {
    return fail("unsupported", "deployment_profile_mismatch");
  }
  if (options.signup && ctx.profile !== "managed") return fail("unsupported", "signup_unsupported");

  let limit = deadline(AUTH_HTTP_TIMEOUT_MS, cancel);
  const discovered = await discover(ctx.origin, limit.signal);
  if (!discovered.ok) return httpFailure(discovered, cancel);
  const { endpoints, requireIss, offeredClientId } = discovered;

  const listener = await startCallbackListener();
  let callback;
  let clientId;
  let verifier;
  try {
    limit = deadline(AUTH_HTTP_TIMEOUT_MS, cancel);
    const client = await clientFor(endpoints, offeredClientId, listener.redirectUri, limit.signal);
    if (!client.ok) return httpFailure(client, cancel);
    clientId = client.clientId;

    const pkce = newPkce();
    verifier = pkce.verifier;
    // Arm the exact state, Host and path check and start the timeout before
    // the URL exists anywhere outside this process. Every return below
    // reaches the finally, whose close() settles this wait and clears its
    // timer.
    const pending = listener.wait({
      state: pkce.state,
      issuer: endpoints.issuer,
      requireIss,
      timeoutMs: options.timeoutMs,
      cancel,
    });
    const url = authorizationUrl(endpoints, {
      clientId,
      redirectUri: listener.redirectUri,
      state: pkce.state,
      challenge: pkce.challenge,
      signup: options.signup,
    });
    const seconds = Math.round(options.timeoutMs / 1000);
    // A wait armed after Ctrl+C has already settled; do not show the URL.
    if (cancel.aborted) return fail("authorization_failed", "cancelled");
    if (options.noBrowser && announce) {
      announce(openUrl(url, seconds, "sign in with Metadata access"));
    } else if (options.noBrowser) {
      progress(
        "Open this URL in a browser on this machine to sign in:\n" +
          `${url}\n` +
          `Waiting up to ${seconds} seconds for the browser. Press Ctrl+C to cancel.`,
      );
    } else {
      if (!(await openBrowser(url))) {
        return fail("authorization_failed", "browser_unavailable", {
          kind: "no_browser",
          message: "Run login again with --no-browser, without --json, and open the URL it prints.",
        });
      }
      progress(`Opened your browser to sign in. Waiting up to ${seconds} seconds. Press Ctrl+C to cancel.`);
    }
    callback = await pending;
  } finally {
    await listener.close();
  }

  if (callback.kind === "denied") return fail("authorization_failed", "access_denied");
  if (callback.kind === "timeout") return fail("authorization_failed", "timeout");
  if (callback.kind === "cancelled") return fail("authorization_failed", "cancelled");
  if (callback.kind !== "code") return fail("authorization_failed", callback.reason);

  limit = deadline(AUTH_HTTP_TIMEOUT_MS, cancel);
  const exchanged = await exchangeCode(
    endpoints,
    { clientId, redirectUri: listener.redirectUri, code: callback.code, verifier },
    limit.signal,
  );
  if (!exchanged.ok) return httpFailure(exchanged, cancel);
  const { grant } = exchanged;

  const rejectGrant = async (outcome, reason) => {
    await revokeQuietly(endpoints, clientId, grant.refreshToken);
    return fail(outcome, reason);
  };
  if (options.workspace !== null && grant.tenant !== options.workspace) {
    return rejectGrant("verification_failed", "workspace_mismatch");
  }
  limit = deadline(AUTH_HTTP_TIMEOUT_MS, cancel);
  const verified = await verifyContext(
    ctx.origin,
    grant.accessToken,
    { profile: ctx.profile, workspaceId: grant.tenant },
    limit.signal,
  );
  if (!verified.ok) {
    if (cancel.aborted) return rejectGrant("authorization_failed", "cancelled");
    return rejectGrant(verified.outcome, verified.reason);
  }
  ctx.workspaceId = grant.tenant;
  return { ok: true, endpoints, clientId, grant };
}

export async function runLogout(options) {
  const ctx = { origin: null, workspaceId: null, credentials: "none", binding: "none", revocation: "not_attempted" };
  const end = (outcome, reason) => ({ outcome, reason, data: logoutData(ctx) });
  const trap = trapSignals();
  try {
    const root = resolveProject(options.project);
    const store = openStore(resolveConfigDir(options.configDir), { create: false });
    const existing = readBinding(root);
    if (existing === null) return end("ok", null);
    const bound = existing.binding;
    ctx.origin = bound.origin;
    ctx.workspaceId = bound.workspace_id;
    ctx.binding = "kept";

    if (store !== null) {
      const result = await withSlotLock(
        store,
        bound.credential_slot,
        async () => {
          const record = readOrNull(store, bound.credential_slot);
          // A grant is only ever sent back to the origin it came from.
          if (record !== null && record.origin === bound.origin) {
            const limit = deadline(AUTH_HTTP_TIMEOUT_MS, trap.signal);
            const discovered = await discover(bound.origin, limit.signal);
            ctx.revocation = discovered.ok
              ? await revoke(discovered.endpoints, { clientId: record.client_id, refreshToken: record.refresh_token }, limit.signal)
              : "unconfirmed";
          }
          return deleteCredential(store, bound.credential_slot);
        },
        { waitMs: LOCK_WAIT_MS },
      );
      if (result) ctx.credentials = "removed";
    }
    try {
      removeBinding(root, existing);
    } catch (error) {
      // The grant is already gone; say so instead of the generic write error.
      if (error instanceof Stop && error.outcome === "filesystem_error") {
        return end("filesystem_error", "binding_remove_failed");
      }
      throw error;
    }
    ctx.binding = "removed";
    return ctx.revocation === "unconfirmed" ? end("revocation_unconfirmed", "revocation_unconfirmed") : end("ok", null);
  } catch (error) {
    if (error instanceof Stop) return end(error.outcome, error.reason);
    throw error;
  } finally {
    trap.release();
  }
}

// Revokes and removes the grant a previous binding pointed to. Returns
// "accepted", "unconfirmed" or "not_attempted". Failures here never undo the
// new binding.
async function retireSlot(store, bound) {
  try {
    return await withSlotLock(
      store,
      bound.credential_slot,
      async () => {
        const record = readOrNull(store, bound.credential_slot);
        let revocation = "not_attempted";
        if (record !== null && record.origin === bound.origin) {
          revocation = await revokeQuietly(endpointsFor(record.origin), record.client_id, record.refresh_token);
        }
        deleteCredential(store, bound.credential_slot);
        return revocation;
      },
      { waitMs: LOCK_WAIT_MS },
    );
  } catch {
    return "unconfirmed";
  }
}

function readOrNull(store, slot) {
  try {
    return readCredential(store, slot);
  } catch (error) {
    if (error instanceof Stop && error.outcome === "login_required") return null;
    throw error;
  }
}

// Revocation with its own deadline, not tied to cancellation, so a grant the
// CLI decided not to keep is still revoked after Ctrl+C.
async function revokeQuietly(endpoints, clientId, refreshToken) {
  const limit = deadline(AUTH_HTTP_TIMEOUT_MS);
  return revoke(endpoints, { clientId, refreshToken }, limit.signal);
}

function httpFailure(result, cancel) {
  if (cancel.aborted) return fail("authorization_failed", "cancelled");
  return fail(result.outcome, result.reason);
}

function fail(outcome, reason, next = null) {
  return { ok: false, outcome, reason, next };
}

// The next action a --json --no-browser run prints while it waits. The URL is
// the authorization request: public client ID, loopback redirect, state and
// PKCE challenge. It carries no token, code or verifier.
export function openUrl(url, seconds, purpose) {
  return {
    kind: "open_url",
    url,
    timeout_seconds: seconds,
    message: `Show this URL to the person now and ask them to open it in a browser on this machine to ` +
      `${purpose}. A background process waits up to ${seconds} seconds for their approval. ` +
      "After they approve, run the same command again to continue.",
  };
}

const GUIDE = { kind: "connection_guide", url: CONNECTION_GUIDE_URL };
const RECONNECT = {
  kind: "reconnect",
  message: "Run login again with --reconnect to switch this project, or run logout first.",
};
const CONNECTED = {
  kind: "connected",
  message: 'This project is signed in with Metadata access. Run "metergraph logout" to sign out.',
};

function loginData(ctx, next) {
  return {
    origin: ctx.origin,
    runtime: ctx.runtime,
    deployment_profile: ctx.profile,
    workspace: ctx.workspaceId === null ? null : { id: ctx.workspaceId },
    scopes: ctx.authenticated ? [METADATA_SCOPE] : [],
    authenticated: ctx.authenticated,
    configured: ctx.configured,
    status: ctx.status,
    binding: ctx.configured ? BINDING_PATH : null,
    credential_protection: ctx.configured ? PROTECTION : null,
    previous_grant_revocation: ctx.previousGrant,
    next_action: next,
  };
}

function logoutData(ctx) {
  return {
    origin: ctx.origin,
    workspace: ctx.workspaceId === null ? null : { id: ctx.workspaceId },
    local_credentials: ctx.credentials,
    binding: ctx.binding,
    revocation: ctx.revocation,
    authenticated: false,
  };
}
