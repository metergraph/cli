import { PLAIN, fields, headline, paragraph, render, steps, toneFor } from "./style.js";

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

export function verifyText(result, style = PLAIN) {
  const data = result.data;
  const title = result.ok ? "Trace verified" : "Trace not verified";
  const lines = [headline(style, toneFor(result.outcome), title, result.outcome), ""];
  if (data) {
    lines.push(...fields(style, [
      ["Workspace", data.workspace.id],
      ["Deployment", data.deployment_profile],
      ["Trace ID", data.trace?.trace_id ?? null],
      ["Invocation source", data.invocation.source],
      ["Attempts", data.attempts],
      ["Processed", data.readiness.processed],
      ["Metadata available", data.readiness.metadata_available],
      ["Application traffic verified", data.application_traffic_verified],
      ["Browser", data.browser ?? null],
    ]), "");
  }
  if (result.error) lines.push(...paragraph(style, result.error.message), "");
  if (data?.app_url) {
    lines.push(...steps(style, [[data.link_workspace_bound ? "Dashboard" : "Dashboard (select the correct workspace)", data.app_url]]));
  }
  return render(lines);
}
