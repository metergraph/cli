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
  toJsonLine,
  versionData,
} from "./output.js";
import { runRead } from "./read.js";
import { readMessage, readText } from "./read-output.js";
import { runSkill } from "./skill.js";
import { runSetup } from "./setup.js";
import { containsKnownCredential, preflightNonHostedSetup } from "./setup-deployment.js";
import { VERSION } from "./constants.js";
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

  if (!parsed.ok) {
    const result = envelope({
      command: parsed.command,
      outcome: parsed.outcome,
      reason: parsed.code,
      message: parsed.message,
    });
    if (parsed.json) stdout.write(toJsonLine(result));
    else stderr.write(`Error: ${parsed.message}\n`);
    return result;
  }

  if (parsed.command === "help") {
    const result = envelope({ command: "help", outcome: "ok", data: helpData(parsed.topic) });
    stdout.write(parsed.json ? toJsonLine(result) : helpText(parsed.topic));
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
    const { outcome, reason, data } =
      parsed.command === "login" ? await runLogin(parsed, progress) : await runLogout(parsed);
    const message = authMessage(outcome, reason);
    const result = envelope({
      command: parsed.command,
      outcome,
      reason,
      data,
      message: outcome === "ok" ? null : message,
    });
    stdout.write(parsed.json ? toJsonLine(result) : authText(result, message));
    return result;
  }

  if (parsed.command === "setup") {
    const routed = parsed.deployment === "managed"
      ? { proceed: true, profile: "managed" }
      : await preflightNonHostedSetup(parsed);
    const progress = parsed.json ? () => {} : (line) =>
      stderr.write(containsKnownCredential(line, routed) ? "Setup progress.\n" : `${line}\n`);
    const response = routed.proceed
      ? await runSetup({ ...parsed, expectedProfile: routed.profile ?? null }, progress)
      : routed;
    const { outcome, reason, data } = response;
    let result = envelope({ command: "setup", outcome, reason, data,
      message: outcome === "ok" ? null : "Setup did not complete. Review the reason and retry safely." });
    if (containsKnownCredential(result, routed)) {
      result = envelope({ command: "setup", outcome: "unsupported", reason: "credential_echo" });
    }
    const receipt = result.data?.receipt;
    const summary = receipt ? `Workspace: ${receipt.workspace_id}\nDeployment: ${receipt.deployment_profile} at ${receipt.origin}\nCompleted: ${receipt.completed_steps.join(", ")}\nPending: ${receipt.pending_steps.join(", ")}\n` : "";
    const identity = repositoryLine(result.data?.repository);
    const human = `Metergraph setup: ${result.data?.status ?? "not_ready"}\n${summary}${identity}Application traffic verified: no\n${result.ok ? "Next: instrument your application and verify an exact trace.\n" : `Result: ${result.outcome} (${result.error.reason})\n`}`;
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
    stdout.write(parsed.json ? toJsonLine(result) : readText(result, message));
    return result;
  }

  if (parsed.command === "verify") {
    const { outcome, reason, data } = await runVerify(parsed);
    const message = verifyMessage(outcome, reason);
    const result = envelope({ command: "verify", outcome, reason, data, message: outcome === "ok" ? null : message });
    stdout.write(parsed.json ? toJsonLine(result) : verifyText(result));
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
    stdout.write(parsed.json ? toJsonLine(result) : skillText(result, message));
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
  stdout.write(parsed.json ? toJsonLine(result) : doctorText(result));
  return result;
}

// One line on the repository identity setup found or recorded. The value is
// owner/name only; a remote URL is never shown.
function repositoryLine(repository) {
  if (!repository) return "";
  const where = repository.path ? ` in ${repository.path}` : repository.source === "env_file" ? " in the env file" : "";
  switch (repository.status) {
    case "written": return `Repository: ${repository.repository} (recorded${where}; commit it)\n`;
    case "existing": return repository.repository === null
      ? `Repository: already set${where}\n` : `Repository: ${repository.repository} (already set${where})\n`;
    case "mismatch": return `Repository: ${repository.repository} (already set${where}; differs from ${repository.expected}, left unchanged)\n`;
    case "invalid_config": return `Repository: not recorded (${repository.path} is not a usable config; left unchanged)\n`;
    case "skipped": return "Repository: not recorded (--no-repository)\n";
    case "write_failed": return `Repository: not recorded (could not write ${repository.path})\n`;
    default: return "Repository: not recorded (no owner/name git remote; pass --repository OWNER/NAME)\n";
  }
}
