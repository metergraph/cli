const MESSAGES = Object.freeze({
  invalid_trace_identity: "Provide exactly one exact trace or request ID from your application run.",
  invalid_invocation_window: "Provide the start and end timestamps of that application invocation.",
  invocation_window_outside_bounds: "The invocation is outside the requested Metadata window.",
  verification_timeout: "The exact trace was not verified before the deadline.",
  trace_not_found_within_bounds: "The exact trace is not visible in the bounded window yet.",
  ambiguous_trace_identity: "More than one trace matches this request ID. Supply an exact trace ID.",
  trace_outside_invocation_window: "The trace exists outside the stated invocation window.",
  workspace_context_mismatch: "The trace response does not belong to the signed in workspace.",
  link_workspace_binding_unavailable: "The trace is verified, but this dashboard link cannot select its workspace automatically. Open it manually in the correct workspace.",
  server_link_unavailable: "The trace is verified, but the service did not provide a dashboard link.",
  identity_query_unavailable: "The service cannot query an exact trace identity through Metadata access.",
  capability_unavailable: "Trace Metadata access is unavailable for this workspace.",
  login_required: "Sign in to this project with a Metadata-only grant before verifying a trace.",
  forbidden: "This grant cannot read trace Metadata for the bound workspace.",
});

export function verifyMessage(outcome, reason) {
  return MESSAGES[reason] ?? `Trace verification stopped (${outcome}). No application traffic claim was made.`;
}

export function verifyText(result) {
  const data = result.data;
  const lines = ["Metergraph exact trace verification", `Outcome: ${result.outcome} (exit ${result.exit_code})`];
  if (data) {
    lines.push(`Workspace: ${data.workspace.id}`, `Deployment: ${data.deployment_profile}`,
      `Invocation source: ${data.invocation.source}`, `Attempts: ${data.attempts}`,
      `Processed: ${data.readiness.processed}`, `Metadata available: ${data.readiness.metadata_available}`,
      `Application traffic verified: ${data.application_traffic_verified}`);
    if (data.trace) lines.push(`Trace ID: ${data.trace.trace_id}`);
    if (data.app_url) lines.push(`Dashboard link${data.link_workspace_bound ? " (workspace bound)" : " (select the correct workspace)"}: ${data.app_url}`);
    if (data.browser) lines.push(`Browser: ${data.browser}`);
  }
  if (result.error) lines.push(result.error.message);
  return `${lines.join("\n")}\n`;
}
