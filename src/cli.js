import { READ_COMMANDS, parseArgs } from "./args.js";
import { runLogin, runLogout } from "./auth-login.js";
import { runDoctor } from "./doctor.js";
import {
  authMessage,
  authText,
  doctorMessage,
  doctorText,
  envelope,
  helpData,
  helpText,
  skillText,
  skillsText,
  toJsonLine,
  versionData,
} from "./output.js";
import { runRead } from "./read.js";
import { readMessage, readText } from "./read-output.js";
import { listSkillPack, runSkill, runSkillPack } from "./skill.js";
import { runSetup } from "./setup.js";
import { containsKnownCredential, preflightNonHostedSetup, prerequisiteGuide, resumeNonHostedRoute } from "./setup-deployment.js";
import { VERSION } from "./constants.js";
import { createStyle, fields, headline, paragraph, render, steps, toneFor } from "./style.js";
import { runVerify } from "./verify.js";
import { verifyMessage, verifyText } from "./verify-output.js";

// Runs one command and resolves with the exit code. With --json, stdout gets
// exactly one JSON line and stderr stays empty. Without it, results go to
// stdout and usage or internal errors go to stderr. Never reads stdin.
export async function main(argv, { stdout, stderr }) {
  const json = argv.includes("--json");
  let result;
  try {
    result = await run(argv, { stdout, stderr });
  } catch {
    result = envelope({
      command: null,
      outcome: "internal_error",
      reason: "unexpected_failure",
      message: "The CLI failed unexpectedly. No details are shown to avoid exposing sensitive input.",
    });
    if (json) stdout.write(toJsonLine(result));
    else stderr.write(`Error: ${result.error.message}\n`);
  }
  return result.exit_code;
}

async function run(argv, { stdout, stderr }) {
  const parsed = parseArgs(argv);
  const style = createStyle(stdout);

  if (!parsed.ok) {
    const result = envelope({
      command: parsed.command,
      outcome: parsed.outcome,
      reason: parsed.code,
      message: parsed.message,
    });
    if (parsed.json) stdout.write(toJsonLine(result));
    else stderr.write(`${createStyle(stderr).red("Error:")} ${parsed.message}\n`);
    return result;
  }

  if (parsed.command === "help") {
    const result = envelope({ command: "help", outcome: "ok", data: helpData(parsed.topic) });
    stdout.write(parsed.json ? toJsonLine(result) : helpText(parsed.topic, style));
    return result;
  }

  if (parsed.command === "version") {
    const result = envelope({ command: "version", outcome: "ok", data: versionData() });
    stdout.write(parsed.json ? toJsonLine(result) : `${VERSION}\n`);
    return result;
  }

  if (parsed.command === "login" || parsed.command === "logout") {
    // Human progress goes to stderr, never with --json, so stdout carries
    // only the final result.
    const progress = parsed.json ? () => {} : (text) => stderr.write(`${text}\n`);
    const pending = announcer(parsed, stdout, (data) => data);
    const { outcome, reason, data } =
      parsed.command === "login" ? await runLogin({ ...parsed, announce: pending.announce }, progress) : await runLogout(parsed);
    if (pending.result) return pending.result;
    const message = authMessage(outcome, reason);
    const result = envelope({
      command: parsed.command,
      outcome,
      reason,
      data,
      message: outcome === "ok" ? null : message,
    });
    stdout.write(parsed.json ? toJsonLine(result) : authText(result, message, style));
    return result;
  }

  if (parsed.command === "setup") {
    const options = resumeNonHostedRoute(parsed);
    const routed = options.deployment === "managed"
      ? { proceed: true, profile: "managed" }
      : await preflightNonHostedSetup(options);
    const progress = parsed.json ? () => {} : (line) =>
      stderr.write(containsKnownCredential(line, routed) ? "Setup progress.\n" : `${line}\n`);
    // The announced line is checked for known credentials like the final one.
    const pending = announcer(parsed, stdout, (data) => containsKnownCredential(data, routed) ? null : data);
    const response = routed.proceed
      ? await runSetup({ ...options, expectedProfile: routed.profile ?? null, announce: pending.announce }, progress)
      : routed;
    if (pending.result) return pending.result;
    const { outcome, reason, data } = response;
    let result = envelope({ command: "setup", outcome, reason, data,
      message: outcome === "ok" ? null : "Setup did not complete. Review the reason and retry safely." });
    if (containsKnownCredential(result, routed)) {
      result = envelope({ command: "setup", outcome: "unsupported", reason: "credential_echo" });
    }
    const human = setupText(result, style);
    if (containsKnownCredential(human, routed)) {
      result = envelope({ command: "setup", outcome: "unsupported", reason: "credential_echo" });
      stdout.write(parsed.json ? toJsonLine(result) : "Setup stopped.\n");
    } else {
      stdout.write(parsed.json ? toJsonLine(result) : human);
    }
    return result;
  }

  if (READ_COMMANDS.includes(parsed.command)) {
    const { outcome, reason, data } = await runRead(parsed);
    const message = readMessage(outcome, reason);
    const result = envelope({
      command: parsed.command,
      outcome,
      reason,
      data,
      message: outcome === "ok" ? null : message,
    });
    stdout.write(parsed.json ? toJsonLine(result) : readText(result, message, style));
    return result;
  }

  if (parsed.command === "verify") {
    const { outcome, reason, data } = await runVerify(parsed);
    const message = verifyMessage(outcome, reason);
    const result = envelope({ command: "verify", outcome, reason, data, message: outcome === "ok" ? null : message });
    stdout.write(parsed.json ? toJsonLine(result) : verifyText(result, style));
    return result;
  }

  if (parsed.command === "skill") {
    const { outcome, reason, message, data } = runSkill(parsed);
    const result = envelope({
      command: `skill ${parsed.action}`,
      outcome,
      reason,
      data,
      message: outcome === "ok" ? null : message,
    });
    stdout.write(parsed.json ? toJsonLine(result) : skillText(result, message, style));
    return result;
  }

  if (parsed.command === "skills") {
    const { outcome, reason, message, data } =
      parsed.action === "list" ? listSkillPack(parsed) : runSkillPack(parsed);
    const result = envelope({
      command: `skills ${parsed.action}`,
      outcome,
      reason,
      data,
      message: outcome === "ok" ? null : message,
    });
    stdout.write(parsed.json ? toJsonLine(result) : skillsText(result, message, style));
    return result;
  }

  const { outcome, reason, report } = await runDoctor({
    origin: parsed.origin,
    timeoutMs: parsed.timeoutMs,
  });
  const result = envelope({
    command: "doctor",
    outcome,
    reason,
    data: report,
    message: doctorMessage(outcome, reason),
  });
  stdout.write(parsed.json ? toJsonLine(result) : doctorText(result, style));
  return result;
}

// With --json --no-browser, login and setup print their one JSON line as
// soon as a person must open an approval URL, then keep waiting for the
// callback; bin/metergraph.js has already moved this process to the
// background (approval-handoff.js). Whatever the run does afterwards, that
// line is its result; the agent reruns the command to continue. screen(data) returns
// the data to print, or null to print a credential_echo refusal instead.
function announcer(parsed, stdout, screen) {
  const pending = { announce: null, result: null };
  if (!parsed.json || !parsed.noBrowser) return pending;
  pending.announce = (data) => {
    if (pending.result) return;
    const safe = screen(data);
    pending.result = safe === null
      ? envelope({ command: parsed.command, outcome: "unsupported", reason: "credential_echo" })
      : envelope({ command: parsed.command, outcome: "action_required", reason: "browser_approval_required",
        data: safe, message: authMessage("action_required", "browser_approval_required") });
    stdout.write(toJsonLine(pending.result));
  };
  return pending;
}

const SETUP_TITLES = {
  ready_for_instrumentation: "Setup complete, ready to instrument",
  operator_handoff: "Setup is waiting on the operator",
};

function setupText(result, style) {
  const data = result.data;
  const status = data?.status ?? "not_ready";
  const title = SETUP_TITLES[status] ?? (result.ok ? `Setup: ${status}` : "Setup did not complete");
  const tone = status === "operator_handoff" ? "warn" : toneFor(result.outcome);
  const lines = [headline(style, tone, title, result.outcome), ""];
  const receipt = data?.receipt;
  const rows = [];
  if (receipt) {
    rows.push(
      ["Workspace", receipt.workspace_id],
      ["Deployment", `${receipt.deployment_profile} at ${receipt.origin}`],
      ["Completed", receipt.completed_steps.join(", ") || "none"],
      ["Pending", receipt.pending_steps.join(", ") || "none"],
    );
  }
  const repository = repositoryValue(data?.repository);
  if (repository !== null) rows.push(["Repository", repository]);
  if (status === "operator_handoff") {
    if (data.origin) rows.push(["Deployment", `${data.deployment_profile} at ${data.origin}`]);
    if (data.workspace_id) rows.push(["Workspace", data.workspace_id]);
  }
  rows.push(["Application traffic verified", "no"]);
  lines.push(...fields(style, rows), "");
  if (!result.ok) lines.push(...paragraph(style, result.error.message), `  ${style.dim(`Reason: ${result.error.reason}`)}`, "");
  lines.push(...handoffLines(data, style));
  lines.push(...remoteLines(data, style));
  if (result.ok) lines.push(...steps(style, [["", "Instrument your application and verify an exact trace."]]));
  return render(lines);
}

// What an operator handoff is waiting for, in fixed text: each unconfirmed
// prerequisite with its guidance, and the next action.
function handoffLines(data, style) {
  if (data?.status !== "operator_handoff" || data.next_action?.kind === "run_on_local_machine") return [];
  const lines = [];
  if (data.pending_prerequisites.length > 0) {
    lines.push("Confirm each prerequisite, then rerun with --confirm-prerequisites:");
    for (const name of data.pending_prerequisites) {
      lines.push(`  ${style.yellow("•")} ${style.bold(name)}`,
        ...paragraph(style, prerequisiteGuide(name, data.deployment_profile) ?? "See the guide.", "    "));
    }
    lines.push("");
  }
  const next = data.next_action;
  const message = next?.message && !(next.kind === "complete_prerequisite" && data.pending_prerequisites.includes(next.prerequisite))
    ? next.message : null;
  lines.push(...steps(style, [["", message], ["Guide", next?.url ?? null]]), "");
  return lines;
}

// A remote session's handoff: where setup runs instead, and how this
// environment can still make Metadata reads with a separate agent key.
function remoteLines(data, style) {
  const next = data?.next_action;
  if (next?.kind !== "run_on_local_machine") return [];
  const keys = next.metadata_reads?.person_steps.find((step) => step.action === "create_metadata_key")?.url ?? null;
  return [...steps(style, [
    ["", next.message],
    ["On the person's own machine", style.bold(next.command)],
    ["Metadata key for reads here", keys],
    ["Then run here", next.metadata_reads ? style.bold(next.metadata_reads.then_run.join(", then ")) : null],
    ["Guide", next.url],
  ]), ""];
}

// The repository identity setup found or recorded. The value is owner/name
// only; a remote URL is never shown.
function repositoryValue(repository) {
  if (!repository) return null;
  const where = repository.path ? ` in ${repository.path}` : repository.source === "env_file" ? " in the env file" : "";
  switch (repository.status) {
    case "written": return `${repository.repository} (recorded${where}; commit it)`;
    case "existing": return repository.repository === null
      ? `already set${where}` : `${repository.repository} (already set${where})`;
    case "mismatch": return `${repository.repository} (already set${where}; differs from ${repository.expected}, left unchanged)`;
    case "invalid_config": return `not recorded (${repository.path} is not a usable config; left unchanged)`;
    case "skipped": return "not recorded (--no-repository)";
    case "write_failed": return `not recorded (could not write ${repository.path})`;
    default: return "not recorded (no owner/name git remote; pass --repository OWNER/NAME)";
  }
}
