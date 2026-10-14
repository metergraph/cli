import childProcess from "node:child_process";
import path from "node:path";

import { classifyEnvironment } from "./environment.js";

// Opens a URL with the operating system's own launcher: a fixed executable
// and an argument array, never a shell. The URL is the authorization request
// (public client ID, state and PKCE challenge); no token, code or verifier is
// ever on a command line. Resolves true when the launcher started, false
// when it could not be started. A started launcher does not prove that a
// browser opened, so callers still wait for the callback with a deadline.
export function openBrowser(url) {
  const { command, args } = launcher();
  return new Promise((resolve) => {
    let child;
    try {
      child = childProcess.spawn(command, [...args, url], {
        shell: false,
        detached: true,
        stdio: "ignore",
        windowsHide: true,
      });
    } catch {
      resolve(false);
      return;
    }
    child.once("error", () => resolve(false));
    child.once("spawn", () => {
      child.unref();
      resolve(true);
    });
  });
}

function launcher() {
  if (process.platform === "darwin") return { command: "/usr/bin/open", args: [] };
  if (process.platform === "win32") {
    return {
      command: path.win32.join(systemRoot(), "System32", "rundll32.exe"),
      args: ["url.dll,FileProtocolHandler"],
    };
  }
  return { command: "/usr/bin/xdg-open", args: [] };
}

// The Windows directory, from SystemRoot only when it is a plain absolute
// drive path, otherwise the standard location.
export function systemRoot() {
  const value = process.env.SystemRoot;
  if (typeof value === "string" && /^[A-Za-z]:\\[A-Za-z0-9 ._\\-]*$/.test(value) && !value.includes("..")) {
    return value;
  }
  return "C:\\Windows";
}

// Returns null for an ordinary local session (including a local container),
// or the fixed reason token of a remote or CI session. See environment.js.
export function detectRemoteSession(env = process.env) {
  return classifyEnvironment(env, { fileExists: () => false }).reason;
}
