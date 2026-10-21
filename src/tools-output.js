import { jsonText } from "./output.js";
import { readMessage } from "./read-output.js";
import { PLAIN, fields, headline, paragraph, render, steps, toneFor } from "./style.js";

// Fixed text for tools results. A tool's result and error are the service's
// own JSON, printed with jsonText so no control or bidirectional character
// reaches the terminal; tool titles are printed with them removed.

const MESSAGES = {
  tool_unavailable:
    "This credential cannot use that tool here: the name is unknown, the tool needs more access, or this " +
    "deployment does not offer it. Nothing was called.",
  confirmation_required:
    "This tool writes, starts work or calls a model provider, so it runs only with --yes, once the person has " +
    "approved this exact call. Nothing was sent.",
  tool_error: "The service refused the call; the tool error below says why.",
  tool_rejected: "The service rejected the call's arguments; the tool error below says why.",
  tool_call_unconfirmed:
    "The call reached the service, but its answer was not confirmed, so it may have taken effect. Check before " +
    "calling it again.",
  tool_response_invalid: "The service's answer to the tool request does not match the MCP protocol.",
  tools_unavailable: "This service does not list Agent Access tools.",
  args_invalid: "The arguments are not one JSON object. Nothing was sent.",
  args_too_large: "The arguments are larger than 1 MiB. Nothing was sent.",
  args_file_unreadable: "The --args-file file could not be read as a regular file. Nothing was sent.",
};

export function toolsMessage(outcome, reason) {
  return MESSAGES[reason] ?? readMessage(outcome, reason);
}

const CONTROL = /[\u0000-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g;
const plain = (value) => (typeof value === "string" ? value.replace(CONTROL, "") : "");

function kindOf(tool) {
  if (tool.read_only && !tool.open_world) return "read";
  return tool.open_world ? "calls out, needs --yes" : "writes, needs --yes";
}

export function toolsText(result, message, style = PLAIN, action) {
  const data = result.data;
  const title = action === "list" ? "Agent Access tools" : `Tool ${data.result?.tool ?? ""}`.trim();
  const lines = [headline(style, result.ok ? "info" : toneFor(result.outcome), result.ok ? title : `${title} did not run`, result.outcome), ""];
  lines.push(...fields(style, [["Origin", data.origin], ["Credential", data.credential === "agent_key" ? "coding-agent key" : "saved sign in"]]), "");
  if (result.ok && action === "list") {
    const tools = data.result.tools;
    const width = Math.max(4, ...tools.map((tool) => tool.name.length));
    for (const tool of tools) {
      lines.push(`  ${tool.name.padEnd(width)}  ${style.dim(kindOf(tool))}`);
      if (tool.title) lines.push(`  ${"".padEnd(width)}  ${plain(tool.title)}`);
    }
    if (tools.length === 0) lines.push("  No tools are offered to this credential.");
    lines.push("", ...steps(style, [["", "Call one with metergraph tools call NAME --args '{...}'. Add --json for its input schema."]]));
    return render(lines);
  }
  if (result.ok) {
    lines.push(...jsonText(data.result.result, 2).split("\n").map((line) => `  ${line}`));
    return render(lines);
  }
  lines.push(...paragraph(style, message));
  if (data.tool_error) {
    lines.push("", ...jsonText(data.tool_error, 2).split("\n").map((line) => `  ${line}`));
  }
  if (data.next_action?.message) {
    lines.push("", ...steps(style, [["", data.next_action.message], ["Run", data.next_action.command ?? null]]));
  }
  return render(lines);
}
