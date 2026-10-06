import { openBrowser } from "./auth-browser.js";
import { traceLink } from "./trace-contract.js";
import { normalizeUuid } from "./auth-oauth.js";
import { parseOrigin } from "./origin.js";

// Operates only on an already verified, provenance-bound receipt. JSON and
// no-browser mode return its URL without starting a launcher. "opened" means
// the OS launcher started; it does not assert a browser rendered the page.
export async function openTrace(receipt, options = {}, launch = openBrowser) {
  if (receipt?.readiness?.metadata_available !== true || receipt?.readiness?.processed !== true ||
      !receipt?.workspace?.id || normalizeUuid(receipt.workspace.id) !== receipt.workspace.id ||
      parseOrigin(receipt.origin) !== receipt.origin ||
      receipt?.provenance?.workspace_id !== receipt?.workspace?.id ||
      receipt?.provenance?.deployment_profile !== receipt?.deployment_profile || !receipt?.trace) {
    return { outcome: "verification_failed", reason: "verified_trace_required", data: null };
  }
  const link = traceLink(receipt.app_url, receipt.origin, receipt.trace);
  if (!link.ok) return { outcome: link.outcome, reason: link.reason, data: null };
  if (link.value === null) return { outcome: "unsupported", reason: "server_link_unavailable", data: { ...receipt, browser: "not_requested" } };
  if (receipt.link_workspace_bound !== true || receipt.link_status !== "available") {
    return { outcome: "unsupported", reason: "link_workspace_binding_unavailable", data: { ...receipt, browser: "not_requested" } };
  }
  if (options.json || options.noBrowser || !options.open) return { outcome: "ok", reason: null, data: { ...receipt, browser: "not_requested" } };
  if (options.signal?.aborted) return { outcome: "cancelled", reason: "cancelled", data: receipt };
  const launched = await launchWithinSignal(link.value, launch, options.signal);
  if (options.signal?.aborted) return { outcome: "cancelled", reason: "cancelled", data: receipt };
  return { outcome: "ok", reason: null, data: { ...receipt, browser: launched ? "launcher_started" : "launcher_unavailable" } };
}

async function launchWithinSignal(url, launch, signal) {
  if (!signal) return launch(url);
  let aborted;
  const cancelled = new Promise((resolve) => { aborted = () => resolve(false); signal.addEventListener("abort", aborted, { once: true }); });
  try { return await Promise.race([launch(url), cancelled]); }
  finally { signal.removeEventListener("abort", aborted); }
}
