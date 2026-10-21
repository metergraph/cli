import fs from "node:fs";

import { AUTH_PATHS } from "./constants.js";
import { parseJsonObject } from "./http.js";
import { failureOf, send } from "./transport.js";

// tools list | call: any Agent Access tool the credential may use, through
// the service's MCP endpoint (POST /v1/agent/mcp), as an MCP client calls it.
// runRead (read.js) establishes and verifies the session first, exactly as
// for the read commands, so the same saved sign in or coding-agent key works
// here and the service decides which tools that credential sees.
//
// list sends tools/list. call sends tools/list, to learn whether the tool is
// offered to this credential and whether it writes or calls out, then one
// tools/call. A tool the service does not mark read-only, or marks as calling
// out (to a model provider, say), is called only with --yes, which an agent
// passes once the person has approved that exact call. Arguments come from
// --args or --args-file, never stdin. The result is printed as the service
// returned it, as JSON, after the caller checks it for known credentials.

export const TOOL_NAME = /^metergraph_[a-z0-9_]{1,100}$/;
// The service caps a tool result at 5 MiB; the envelope adds a little.
const TOOLS_MAX_BYTES = 6 * 1024 * 1024;
export const TOOL_ARGS_MAX_BYTES = 1024 * 1024;
const MAX_TOOLS = 500;

const stop = (outcome, reason, report = null) => ({ ok: false, outcome, reason, report });

// Resolves with { ok: true, value } or { ok: false, outcome, reason, report }.
export async function toolsRead(session, options, signal) {
  const listed = await listTools(session, signal);
  if (!listed.ok) return listed;
  const request = options.tool;
  if (options.action === "list") {
    if (request.name === null) return { ok: true, value: { tools: listed.tools } };
    const one = listed.tools.find((tool) => tool.name === request.name);
    return one ? { ok: true, value: { tools: [one] } } : stop("capability_unavailable", "tool_unavailable");
  }

  const tool = listed.tools.find((entry) => entry.name === request.name);
  if (!tool) return stop("capability_unavailable", "tool_unavailable");
  const args = readArguments(request);
  if (!args.ok) return args;
  if (tool.needs_confirmation && !request.yes) return stop("action_required", "confirmation_required");

  const id = 2;
  const response = await rpc(session, { jsonrpc: "2.0", id, method: "tools/call", params: { name: tool.name, arguments: args.value } }, signal);
  // A write or a provider call that may have reached the service is never
  // reported as a plain failure: it may have taken effect.
  if (tool.needs_confirmation && response.kind === "error" && response.sent) {
    return stop("unconfirmed", "tool_call_unconfirmed");
  }
  const answer = rpcAnswer(response, id);
  if (!answer.ok) {
    if (tool.needs_confirmation && answer.reason === "tool_response_invalid") return stop("unconfirmed", "tool_call_unconfirmed");
    return answer;
  }
  if (answer.error !== undefined) {
    return stop("refused", "tool_rejected", { tool_error: { code: "invalid_params", message: text(answer.error.message) } });
  }
  const result = answer.result;
  if (!isObject(result) || typeof result.isError !== "boolean") {
    return tool.needs_confirmation ? stop("unconfirmed", "tool_call_unconfirmed") : stop("verification_failed", "tool_response_invalid");
  }
  const document = isObject(result.structuredContent) ? result.structuredContent : null;
  if (result.isError) {
    const error = isObject(document?.error) ? document.error : {};
    return stop("refused", "tool_error", {
      tool_error: { code: typeof error.code === "string" ? error.code : "tool_error", message: text(error.message) },
    });
  }
  return {
    ok: true,
    value: { tool: tool.name, read_only: tool.read_only, open_world: tool.open_world, result: document },
  };
}

async function listTools(session, signal) {
  const id = 1;
  const answer = rpcAnswer(await rpc(session, { jsonrpc: "2.0", id, method: "tools/list" }, signal), id);
  if (!answer.ok) return answer;
  if (answer.error !== undefined) return stop("unsupported", "tools_unavailable");
  const listed = answer.result?.tools;
  if (!Array.isArray(listed) || listed.length > MAX_TOOLS) return stop("verification_failed", "tool_response_invalid");
  const tools = [];
  for (const entry of listed) {
    if (!isObject(entry) || typeof entry.name !== "string" || !TOOL_NAME.test(entry.name)) {
      return stop("verification_failed", "tool_response_invalid");
    }
    const hints = isObject(entry.annotations) ? entry.annotations : {};
    // Without annotations (an older service), a tool counts as one that
    // writes and calls out, so it is never called without --yes.
    const readOnly = hints.readOnlyHint === true;
    const openWorld = hints.openWorldHint !== false;
    tools.push({
      name: entry.name,
      title: text(entry.title),
      description: text(entry.description),
      input_schema: isObject(entry.inputSchema) ? entry.inputSchema : null,
      read_only: readOnly,
      open_world: openWorld,
      needs_confirmation: !readOnly || openWorld,
    });
  }
  tools.sort((a, b) => a.name.localeCompare(b.name));
  return { ok: true, tools };
}

function rpc(session, message, signal) {
  return send(session.origin, AUTH_PATHS.resource, {
    method: "POST", signal, maxBytes: TOOLS_MAX_BYTES, bearer: session.accessToken, json: message,
  });
}

// { ok: true, result } or { ok: true, error } for a JSON-RPC answer to this
// request, or a failure for anything else.
function rpcAnswer(response, id) {
  if (response.kind === "response") {
    if (response.status === 401) return stop("login_required", "access_revoked");
    if (response.status === 403) return stop("permission_denied", "forbidden");
    if (response.status === 429) return stop("rate_limited", "rate_limited");
    if (response.status === 404) return stop("unsupported", "endpoint_unavailable");
    if (response.tooLarge) return stop("unsupported", "response_too_large");
  }
  const fault = failureOf(response);
  if (fault !== null) return { ok: false, ...fault, report: null };
  if (response.status !== 200) return stop("unsupported", "unexpected_status");
  const message = parseJsonObject(response);
  if (message?.jsonrpc !== "2.0" || message.id !== id) return stop("verification_failed", "tool_response_invalid");
  if (isObject(message.error)) return { ok: true, error: message.error };
  return { ok: true, result: message.result };
}

// The call's arguments: a JSON object from --args or the file --args-file
// names, at most TOOL_ARGS_MAX_BYTES. No value from them is ever printed.
function readArguments(request) {
  let raw = request.args;
  if (request.argsFile !== null) {
    try {
      const stats = fs.statSync(request.argsFile);
      if (!stats.isFile()) return stop("invalid_input", "args_file_unreadable");
      if (stats.size > TOOL_ARGS_MAX_BYTES) return stop("invalid_input", "args_too_large");
      raw = fs.readFileSync(request.argsFile, "utf8");
    } catch {
      return stop("invalid_input", "args_file_unreadable");
    }
  }
  if (raw === null) return { ok: true, value: {} };
  if (Buffer.byteLength(raw) > TOOL_ARGS_MAX_BYTES) return stop("invalid_input", "args_too_large");
  let value;
  try {
    value = JSON.parse(raw);
  } catch {
    return stop("invalid_input", "args_invalid");
  }
  return isObject(value) ? { ok: true, value } : stop("invalid_input", "args_invalid");
}

// What an agent does next with a tools result, or undefined for the read
// commands' shared handling (keys, sign in, workspace, rate limits).
export function toolsNextAction(ctx, options) {
  if (options.command !== "tools") return undefined;
  const reason = ctx.reason;
  if (reason === "confirmation_required") {
    return {
      kind: "confirm_tool_call",
      message:
        "This tool writes, starts work or calls a model provider. Ask the person to approve this exact call, " +
        "then run the same command again with --yes. Nothing was sent.",
    };
  }
  if (reason === "tool_unavailable") {
    return {
      kind: "list_tools",
      message:
        "This credential cannot use that tool here: the name is unknown, the tool needs more access (writes and " +
        "starts need the Debug role and a workflow permission) or this deployment does not offer it. List the " +
        "tools this credential can use.",
      command: "metergraph tools list --json",
    };
  }
  if (reason === "tool_error" || reason === "tool_rejected") {
    return {
      kind: "fix_tool_arguments",
      message:
        "The service refused the call; data.tool_error says why. Check the tool's input schema with " +
        "\"metergraph tools list --name TOOL --json\", change the arguments and call it again.",
    };
  }
  if (reason === "tool_call_unconfirmed") {
    return {
      kind: "check_before_retry",
      message:
        "The call reached the service, but its answer was not confirmed, so it may have taken effect. Check its " +
        "effect with a read before calling it again.",
    };
  }
  return undefined;
}

// Service text kept for printing: a string, or null.
function text(value) {
  return typeof value === "string" ? value : null;
}

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
