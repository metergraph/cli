import childProcess from "node:child_process";
import path from "node:path";

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

// Variables whose presence means the browser a person uses is not on this
// machine, or no person is present. Only presence is checked; values are
// never read into output.
const REMOTE_MARKERS = [
  ["ssh_session", ["SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY"]],
  ["cloud_workspace", ["CODESPACES", "GITPOD_WORKSPACE_ID", "CLOUD_SHELL"]],
  ["ci_environment", ["CI"]],
];

// Returns null for an ordinary local session, or a fixed reason token.
export function detectRemoteSession(env = process.env) {
  for (const [reason, names] of REMOTE_MARKERS) {
    for (const name of names) {
      const value = env[name];
      if (typeof value === "string" && value !== "" && value !== "0" && value.toLowerCase() !== "false") {
        return reason;
      }
    }
  }
  return null;
}
