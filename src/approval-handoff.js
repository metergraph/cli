import childProcess from "node:child_process";
import { fileURLToPath } from "node:url";

import { parseArgs } from "./args.js";
import { envelope, toJsonLine } from "./output.js";

// login and setup with --json --no-browser may need a person to approve in a
// browser. The approval returns to a loopback listener, so something must
// keep listening after the agent has the URL. Agent shells usually show a
// command's output only after it exits, so that cannot be this process.
//
// This process runs the same command as a detached waiter and relays the
// waiter's one JSON line. When the line is action_required, it exits with it
// at once and leaves the waiter listening until approval or --timeout-ms; the
// waiter saves what the approval completes and prints nothing more. Any other
// line is the command's result, and this process waits for the waiter to
// finish. The arguments carry no credential, and the waiter's environment is
// this one plus a marker.
const BIN = fileURLToPath(new URL("../bin/metergraph.js", import.meta.url));
const WAITER = "METERGRAPH_APPROVAL_WAITER";

export function handsOff(argv, env = process.env) {
  if (env[WAITER] === "1") return false;
  const parsed = parseArgs(argv);
  return parsed.ok && (parsed.command === "login" || parsed.command === "setup") && parsed.json && parsed.noBrowser;
}

export function handOff(argv, { stdout }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = childProcess.spawn(process.execPath, [...process.execArgv, BIN, ...argv], {
        env: { ...process.env, [WAITER]: "1" },
        stdio: ["ignore", "pipe", "ignore"],
        detached: true,
        windowsHide: true,
      });
    } catch {
      resolve(failed(argv, stdout));
      return;
    }
    let text = "";
    let settled = false;
    // Ctrl+C before the line arrives cancels the waiter, which reports it.
    const forward = (signal) => child.kill(signal);
    const signals = ["SIGINT", "SIGTERM"];
    for (const signal of signals) process.on(signal, forward);
    const finish = (code) => {
      if (settled) return;
      settled = true;
      for (const signal of signals) process.removeListener(signal, forward);
      resolve(code);
    };
    child.once("error", () => finish(failed(argv, stdout)));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      text += chunk;
      const end = text.indexOf("\n");
      if (end === -1) return;
      let line;
      try { line = JSON.parse(text.slice(0, end)); } catch { line = null; }
      if (line?.outcome !== "action_required") return;
      stdout.write(text.slice(0, end + 1));
      child.stdout.destroy();
      child.unref();
      finish(line.exit_code);
    });
    child.once("close", (code) => {
      if (settled) return;
      if (text.endsWith("\n") && text.indexOf("\n") === text.length - 1) {
        stdout.write(text);
        finish(code ?? 1);
      } else {
        finish(failed(argv, stdout));
      }
    });
  });
}

function failed(argv, stdout) {
  const parsed = parseArgs(argv);
  const result = envelope({
    command: parsed.command ?? null,
    outcome: "internal_error",
    reason: "unexpected_failure",
    message: "The CLI failed unexpectedly. No details are shown to avoid exposing sensitive input.",
  });
  stdout.write(toJsonLine(result));
  return result.exit_code;
}
