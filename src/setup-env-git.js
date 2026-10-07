import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import { Stop } from "./auth-store.js";

// Read-only Git checks for the env file. git runs without a shell, from the
// project directory, with a fixed argument list holding only a validated
// project-relative path. It never receives a value from the env file, never
// writes the index (optional locks are off) and never changes any config.

// Kept from the caller's environment. Every other GIT_* variable is dropped
// so nothing can point git at a different repository, index or work tree.
const KEPT = new Set([
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_CONFIG_NOSYSTEM",
  "GIT_CEILING_DIRECTORIES",
  "GIT_DISCOVERY_ACROSS_FILESYSTEM",
]);

function gitEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    const upper = key.toUpperCase();
    if (!upper.startsWith("GIT_") || KEPT.has(upper)) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

function git(root, args) {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root,
    env: gitEnv(),
    shell: false,
    windowsHide: true,
    timeout: 15000,
    maxBuffer: 1024 * 1024,
    stdio: ["ignore", "pipe", "ignore"],
  });
  return { status: result.error ? null : result.status, missing: result.error?.code === "ENOENT", stdout: result.stdout };
}

// True when root or any directory above it has a .git entry. Used when git
// itself cannot answer, so a repository is never mistaken for none.
function gitAbove(root) {
  for (let dir = root; ; dir = path.dirname(dir)) {
    try {
      fs.lstatSync(path.join(dir, ".git"));
      return true;
    } catch {
      // Keep looking.
    }
    if (path.dirname(dir) === dir) return false;
  }
}

// Returns { repository: false } outside any repository, or
// { repository: true, ignored } after checking that rel is not tracked.
export function inspectGit(root, rel) {
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.status !== 0) {
    if (!gitAbove(root)) return { repository: false };
    throw new Stop("conflict", inside.missing ? "git_unavailable" : "git_check_failed");
  }
  if (inside.stdout.toString("utf8").trim() !== "true") throw new Stop("conflict", "git_check_failed");
  return { repository: true, ...pathState(root, rel) };
}

// A tracked env file is refused outright: untracking or resetting it is the
// person's decision, never this CLI's. Ignore rules are checked with
// --no-index, so a tracked file cannot hide behind a matching rule.
export function pathState(root, rel) {
  const tracked = git(root, ["--literal-pathspecs", "ls-files", "-z", "--cached", "--", rel]);
  if (tracked.status !== 0) throw new Stop("conflict", "git_check_failed");
  if (tracked.stdout.length > 0) throw new Stop("conflict", "env_tracked");
  const ignored = git(root, ["check-ignore", "-q", "--no-index", "--", rel]);
  if (ignored.status !== 0 && ignored.status !== 1) throw new Stop("conflict", "git_check_failed");
  return { ignored: ignored.status === 0 };
}

// The anchored, literal .gitignore rule for rel. Characters with a meaning
// in ignore patterns are escaped. Paths are validated before they get here,
// so they hold no backslash, wildcard, control character or trailing space.
export function ignoreRule(rel) {
  return `/${rel.replace(/[[\]!#]/g, "\\$&")}`;
}

// True when content has rule as a line and no negation follows it.
export function hasRule(content, rule) {
  const lines = content.toString("utf8").split(/\r?\n/);
  const at = lines.lastIndexOf(rule);
  return at >= 0 && !lines.slice(at + 1).some((line) => line.trimStart().startsWith("!"));
}

export function appendRule(content, rule) {
  const text = content.toString("utf8");
  const eol = text.includes("\r\n") && !/(^|[^\r])\n/.test(text) ? "\r\n" : "\n";
  const lead = content.length > 0 && !text.endsWith("\n") ? eol : "";
  return Buffer.concat([content, Buffer.from(`${lead}${rule}${eol}`, "utf8")]);
}
