// Preloaded with --import into the CLI under test, for parity runs against a
// customer-local stack only. Like test/fixtures/browser-agent.js, it replaces
// the operating system browser launcher. Instead of a synthetic browser it
// hands the URL to approve-browser.mjs, which drives a real headless Chromium
// through the stack's own sign-in and consent pages. The CLI has no switch
// for this; without the preload it opens the person's browser as usual.
//
// With METERGRAPH_PARITY_APPROVER_RELAY set to a file, each URL and the
// scenario's requested action (approve, deny or ignore) is appended to that
// file instead, for an assisted person to act on in their own browser.
import childProcess from "node:child_process";
import { appendFileSync } from "node:fs";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";

const realSpawn = childProcess.spawn;
const APPROVER = fileURLToPath(new URL("./approve-browser.mjs", import.meta.url));

function isLauncher(command) {
  return command === "/usr/bin/open" || command === "/usr/bin/xdg-open" ||
    String(command).toLowerCase().endsWith("\\system32\\rundll32.exe");
}

childProcess.spawn = (command, args, options) => {
  if (!isLauncher(command)) return realSpawn(command, args, options);
  const child = new EventEmitter();
  child.unref = () => {};
  const relay = process.env.METERGRAPH_PARITY_APPROVER_RELAY;
  if (relay) {
    const mode = process.env.METERGRAPH_PARITY_APPROVER || "approve";
    const entry = { at: new Date().toISOString(), step: "opened", mode };
    if (process.env.METERGRAPH_PARITY_LOG) appendFileSync(process.env.METERGRAPH_PARITY_LOG, `${JSON.stringify(entry)}\n`);
    appendFileSync(relay, `${JSON.stringify({ ...entry, url: args[args.length - 1] })}\n`, { mode: 0o600 });
    setImmediate(() => child.emit("spawn"));
    return child;
  }
  // The URL travels on stdin, not argv, so it never shows in a process list.
  const approver = realSpawn(process.execPath, [APPROVER], { stdio: ["pipe", "ignore", "inherit"], env: process.env });
  approver.stdin.end(args[args.length - 1]);
  approver.unref();
  setImmediate(() => child.emit("spawn"));
  return child;
};
syncBuiltinESMExports();
