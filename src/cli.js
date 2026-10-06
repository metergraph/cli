import { parseArgs } from "./args.js";
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
import { runSkill } from "./skill.js";
import { VERSION } from "./constants.js";

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
      outcome: "invalid_input",
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
