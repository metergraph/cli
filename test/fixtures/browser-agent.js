// Preloaded with --import in sign in tests only. It replaces the operating
// system browser launcher with a small synthetic browser that follows the
// authorization redirects of the loopback test service and delivers the
// callback, exactly as a person's browser would after consent. The CLI
// itself has no switch for this. METERGRAPH_TEST_BROWSER selects behavior:
//   follow             follow redirects and deliver the callback (default),
//                      starting at once with no artificial delay
//   callback-first     deliver the whole callback before the launcher even
//                      reports that it started, the fastest browser possible
//   unavailable        the launcher fails to start
//   idle               the launcher starts but nothing is ever opened
//   wrong-host-first   first deliver the callback with a different Host
//   forged-first       first deliver a callback with a wrong state
//   duplicate          deliver the real callback twice
// METERGRAPH_TEST_BROWSER_LOG names a file that receives one JSON line with
// the opened URL and the callback statuses, for the test to inspect.
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import fs from "node:fs";
import http from "node:http";
import { syncBuiltinESMExports } from "node:module";

const mode = process.env.METERGRAPH_TEST_BROWSER || "follow";
const logFile = process.env.METERGRAPH_TEST_BROWSER_LOG || null;
const realSpawn = childProcess.spawn;

function isLauncher(command) {
  return (
    command === "/usr/bin/open" ||
    command === "/usr/bin/xdg-open" ||
    String(command).toLowerCase().endsWith("\\system32\\rundll32.exe")
  );
}

childProcess.spawn = (command, args, options) => {
  if (!isLauncher(command)) return realSpawn(command, args, options);
  const child = new EventEmitter();
  child.unref = () => {};
  if (mode === "unavailable") {
    setImmediate(() => child.emit("error", Object.assign(new Error("launcher missing"), { code: "ENOENT" })));
    return child;
  }
  const url = args[args.length - 1];
  record({ url, argCount: args.length });
  if (mode === "idle") {
    setImmediate(() => child.emit("spawn"));
    return child;
  }
  // The browser starts loading the URL synchronously, inside spawn().
  const browsing = browse(url).catch(() => record({ error: true }));
  if (mode === "callback-first") browsing.then(() => child.emit("spawn"));
  else setImmediate(() => child.emit("spawn"));
  return child;
};
syncBuiltinESMExports();

function record(entry) {
  if (logFile !== null) fs.appendFileSync(logFile, `${JSON.stringify(entry)}\n`);
}

function get(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers, agent: false }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode, location: response.headers.location }));
    });
    request.on("error", reject);
  });
}

async function browse(start) {
  let current = new URL(start);
  const statuses = [];
  for (let hop = 0; hop < 5; hop += 1) {
    if (current.hostname === "127.0.0.1" && current.pathname === "/callback") {
      await deliver(current, statuses);
      break;
    }
    const response = await get(current.href);
    if (response.status !== 302 || !response.location) break;
    current = new URL(response.location, current);
  }
  record({ statuses });
}

async function deliver(callback, statuses) {
  if (mode === "wrong-host-first") {
    statuses.push((await get(callback.href, { host: `localhost:${callback.port}` })).status);
  }
  if (mode === "forged-first") {
    const forged = new URL(callback);
    forged.searchParams.set("state", "forged-state-value-that-does-not-match-anything");
    statuses.push((await get(forged.href)).status);
  }
  statuses.push((await get(callback.href)).status);
  if (mode === "duplicate") statuses.push((await get(callback.href).catch(() => ({ status: "closed" }))).status);
}
