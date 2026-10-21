import { openBrowser } from "./auth-browser.js";
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
  sameScopes,
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
import { AUTH_HTTP_TIMEOUT_MS, WORKFLOW_PERMISSIONS, loginScope } from "./constants.js";
import { runDoctor } from "./doctor.js";
import { agentKeyAction, classifyEnvironment } from "./environment.js";
import { workspaceLabel, workspacePinned } from "./read-contract.js";
import { deadline, trapSignals } from "./transport.js";

// login and logout. Each returns { outcome, reason, data }; every string in
// data is a fixed token, the validated origin, a supported profile, a
// server-verified workspace UUID, or that workspace's slug and name as the
// service reported them, checked as safe to print and dropped if they contain
// a credential this run holds. Token values, the authorization code, the PKCE
// verifier, absolute paths and other server text never leave this module.
// progress(text) prints human progress lines; it is a no-op with --json.
// options.announce(data), given only with --json --no-browser, receives the
// login data with an open_url next action as soon as the authorization URL
// exists, while the listener keeps waiting. The caller prints it as the one
// JSON line, so an agent can hand the URL to a person; approval-handoff.js
// lets the agent's command exit then while this process keeps waiting.
// options.role is "metadata" (the default) or "debug", and options.permissions
// the workflow permission scopes --allow-* added to Debug, which a workspace
// owner approves on the consent page. options.workspaceText is a workspace named by
// slug or name: sent to a consent page that can match it, and checked against
// the workspace the service reports.
// options.ingestSetup, given only by setup, is { familyId, supported(origin,
// profile, signal) }. When the service supports it, the sign-in consent also
// approves the first ingest key for that family, and an ok result carries the
// unredeemed receipt as result.ingestSetup (never in data).

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
    environment: null,
    role: options.role === "debug" ? "debug" : "metadata",
    scope: loginScope(options.role, options.permissions ?? []),
    workspaceLabel: { slug: null, name: null },
  };
  const end = (outcome, reason, next = null) => ({ outcome, reason, data: loginData(ctx, next) });
  const workspaceText = options.workspaceText ?? null;

  // Handoffs come first: no listener, request or file write happens for a
  // session that cannot finish sign in. The next action tells the agent how
  // a person hands it a Metadata key instead.
  const environment = options.environment ?? classifyEnvironment();
  ctx.environment = environment.kind;
  if (options.runtime !== "local") {
    ctx.environment = "declared_cloud";
    return end("unsupported", "runtime_not_supported", agentKeyAction({ kind: "declared_cloud" }, options.origin));
  }
  if (environment.remote) return end("unsupported", environment.reason, agentKeyAction(environment, options.origin));
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

    // A rerun with a working grant for the same role and permissions changes
    // nothing and opens no browser. Asking for others signs in again, for the
    // same workspace.
    const saved = bound === null ? null : readOrNull(store, bound.credential_slot);
    if (bound !== null && !options.reconnect && saved?.scope === ctx.scope) {
      const session = await sessionFor(bound, store, trap.signal);
      if (session.ok) {
        if (workspaceText !== null && !workspacePinned(session.documents.workspace?.workspace, workspaceText)) {
          return end("conflict", "bound_to_other_workspace", RECONNECT);
        }
        Object.assign(ctx, {
          profile: bound.deployment_profile,
          workspaceId: bound.workspace_id,
          workspaceLabel: labelWithout(workspaceLabel(session.documents.workspace?.workspace), session.knownCredentials),
          authenticated: true,
          configured: true,
          status: "reused",
        });
        return end("ok", null, connected(ctx));
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
        scope: ctx.scope,
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
    return { ...end("ok", null, connected(ctx)), ingestSetup: flow.ingestSetup };
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
  const scopes = ctx.scope.split(" ");
  // The consent page can match a slug or name only where the service says
  // so. Without that, a slug is still checked after sign in, but a name,
  // which may be ambiguous, is refused before the browser opens.
  const workspaceText = options.workspaceText ?? null;
  if (workspaceText !== null && !discovered.workspaceHint && !SLUG.test(workspaceText.toLowerCase())) {
    return fail("unsupported", "workspace_name_unsupported", USE_SLUG);
  }
  const workspaceHint = discovered.workspaceHint ? workspaceText ?? options.workspace ?? null : null;

  // Setup asks this consent to approve the first ingest key too, but only
  // when the service says it can. Otherwise sign in is unchanged and setup
  // asks for its own approval afterwards.
  let setupPkce = null;
  if (options.ingestSetup) {
    limit = deadline(AUTH_HTTP_TIMEOUT_MS, cancel);
    if (await options.ingestSetup.supported(ctx.origin, ctx.profile, limit.signal)) setupPkce = newPkce();
    if (cancel.aborted) return fail("authorization_failed", "cancelled");
  }

  const listener = await startCallbackListener();
  let callback;
  let clientId;
  let verifier;
  try {
    limit = deadline(AUTH_HTTP_TIMEOUT_MS, cancel);
    const client = await clientFor(endpoints, offeredClientId, listener.redirectUri, limit.signal, scopes);
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
      acceptSetupCode: setupPkce !== null,
    });
    const url = authorizationUrl(endpoints, {
      clientId,
      redirectUri: listener.redirectUri,
      state: pkce.state,
      challenge: pkce.challenge,
      signup: options.signup,
      ingestSetup: setupPkce === null ? null : { familyId: options.ingestSetup.familyId, challenge: setupPkce.challenge },
      scopes,
      workspaceHint,
    });
    const access = accessText(ctx) + (ctx.scope.includes(" ") ? ", which a workspace owner approves" : "");
    const purpose = setupPkce === null ? `sign in with ${access}`
      : `sign in with ${access} and approve an ingest-only key for this project`;
    const seconds = Math.round(options.timeoutMs / 1000);
    // A wait armed after Ctrl+C has already settled; do not show the URL.
    if (cancel.aborted) return fail("authorization_failed", "cancelled");
    if (options.noBrowser && announce) {
      announce(openUrl(url, seconds, purpose));
    } else if (options.noBrowser) {
      progress(
        `Open this URL in a browser on this machine to ${purpose}:\n` +
          `${url}\n` +
          `Waiting up to ${seconds} seconds for the browser. Press Ctrl+C to cancel.`,
      );
    } else {
      if (!(await openBrowser(url))) {
        return fail("authorization_failed", "browser_unavailable", {
          kind: "no_browser",
          message: "Run login again with --no-browser, without --json, and open the URL it prints.",
          // A local container's loopback callback is reachable only when its
          // port is forwarded to the person's machine. A Metadata key avoids
          // the callback altogether.
          ...(ctx.environment === "local_container"
            ? { alternative: agentKeyAction({ kind: "local_container", remote: false }, ctx.origin) }
            : {}),
        });
      }
      progress(setupPkce === null
        ? `Opened your browser to sign in. Waiting up to ${seconds} seconds. Press Ctrl+C to cancel.`
        : "Opened your browser to sign in and approve this project's ingest key in one step. " +
          `Waiting up to ${seconds} seconds. Press Ctrl+C to cancel.`);
    }
    callback = await pending;
  } finally {
    await listener.close();
  }

  if (callback.kind === "code" && setupPkce !== null && callback.setupCode) options.ingestSetup.onApproved?.();
  // The consent page refused the workspace the CLI named.
  if (callback.kind === "denied" && callback.hint) return fail("invalid_input", callback.hint, USE_SLUG);
  if (callback.kind === "denied") return fail("authorization_failed", "access_denied");
  if (callback.kind === "timeout") return fail("authorization_failed", "timeout");
  if (callback.kind === "cancelled") return fail("authorization_failed", "cancelled");
  if (callback.kind !== "code") return fail("authorization_failed", callback.reason);

  limit = deadline(AUTH_HTTP_TIMEOUT_MS, cancel);
  const exchanged = await exchangeCode(
    endpoints,
    { clientId, redirectUri: listener.redirectUri, code: callback.code, verifier, scopes },
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
    { profile: ctx.profile, workspaceId: grant.tenant, access: ctx.role === "debug" ? "read" : "metadata" },
    limit.signal,
  );
  if (!verified.ok) {
    if (cancel.aborted) return rejectGrant("authorization_failed", "cancelled");
    return rejectGrant(verified.outcome, verified.reason);
  }
  if (ctx.role === "debug" && !sameScopes(ctx.scope, verified.scopes)) return rejectGrant("verification_failed", "scope_mismatch");
  const workspace = verified.documents.workspace?.workspace;
  if (workspaceText !== null && !workspacePinned(workspace, workspaceText)) {
    return rejectGrant("verification_failed", "workspace_mismatch");
  }
  ctx.workspaceId = grant.tenant;
  ctx.workspaceLabel = labelWithout(workspaceLabel(workspace), [
    grant.accessToken, grant.refreshToken, callback.code, verifier, callback.setupCode, setupPkce?.verifier,
  ]);
  // The receipt is a separate credential: setup redeems it with its own
  // verifier, for the family it named, after binding this sign in. A service
  // that showed only the sign in returns no receipt, and setup falls back to
  // its own approval.
  const ingestSetup = setupPkce !== null && callback.setupCode
    ? { familyId: options.ingestSetup.familyId, code: callback.setupCode, verifier: setupPkce.verifier,
        clientId, redirectUri: listener.redirectUri }
    : null;
  return { ok: true, endpoints, clientId, grant, ingestSetup };
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

const RECONNECT = {
  kind: "reconnect",
  message: "Run login again with --reconnect to switch this project, or run logout first.",
};
const USE_SLUG = {
  kind: "use_workspace_slug",
  message:
    "Run login again with --workspace and the workspace's slug, which its Settings page and " +
    "\"metergraph context\" show.",
};
const SLUG = /^[a-z0-9][a-z0-9-]{1,62}$/;

// A workspace label is service text. If it holds a credential this run knows,
// it is not printed; sign in itself is unaffected.
function labelWithout(label, secrets) {
  const values = [label.slug, label.name].filter((value) => value !== null);
  const echoes = secrets.some((secret) => typeof secret === "string" && secret.length > 0 &&
    values.some((value) => value.includes(secret)));
  return echoes ? { slug: null, name: null } : label;
}

// The role and permissions a sign in asks for, by the Keys page's labels.
function accessText(ctx) {
  if (ctx.role !== "debug") return "the Metadata role";
  const labels = WORKFLOW_PERMISSIONS.filter(({ scope }) => ctx.scope.split(" ").includes(scope)).map(({ label }) => label);
  if (labels.length === 0) return "the Debug role";
  const list = labels.length === 1 ? labels[0] : `${labels.slice(0, -1).join(", ")} and ${labels.at(-1)}`;
  return `the Debug role with ${list}`;
}

function connected(ctx) {
  return {
    kind: "connected",
    message: `This project is signed in with ${accessText(ctx)}. Run "metergraph logout" to sign out.`,
  };
}

function loginData(ctx, next) {
  return {
    origin: ctx.origin,
    runtime: ctx.runtime,
    environment: ctx.environment,
    deployment_profile: ctx.profile,
    workspace: ctx.workspaceId === null ? null : { id: ctx.workspaceId, ...ctx.workspaceLabel },
    access: {
      role: ctx.role,
      permissions: Object.fromEntries(WORKFLOW_PERMISSIONS.map(({ field, scope }) => [field, ctx.scope.split(" ").includes(scope)])),
    },
    scopes: ctx.authenticated ? ctx.scope.split(" ").sort() : [],
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
