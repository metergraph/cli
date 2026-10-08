import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

// Repository identity for the SDKs: `.metergraph/config.json` with
// {"version": 2, "repository": "owner/name"}. The SDKs read
// METERGRAPH_REPOSITORY first, then the nearest config.json walking up from
// the app root. The file holds no secret and is meant to be committed.
//
// Setup records the identity only when none exists. An existing identity is
// never changed; a different value from the git remote or --repository is
// reported as a mismatch for the person to resolve. A git remote URL can
// carry credentials, so only the parsed owner/name ever leaves this module.

export const CONFIG_PATH = ".metergraph/config.json";
const CONFIG_VERSION = 2;
const MAX_CONFIG_BYTES = 16384;
const MAX_WALK_UP = 64;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const NONBLOCK = fs.constants.O_NONBLOCK ?? 0;
// One owner and one name, each a plain path segment. Hosts that nest groups
// (owner/group/name) are not guessed at; pass --repository instead.
const SEGMENT = /^(?!\.{1,2}$)[A-Za-z0-9_.-]{1,100}$/;

export function parseRepository(value) {
  if (typeof value !== "string") return null;
  const parts = value.trim().split("/");
  if (parts.length !== 2 || !parts.every((part) => SEGMENT.test(part))) return null;
  return `${parts[0]}/${parts[1]}`;
}

// owner/name from a git remote URL, or null. Accepts https://host/owner/name,
// ssh://user@host[:port]/owner/name and user@host:owner/name, each with an
// optional .git suffix.
export function repositoryFromRemote(url) {
  if (typeof url !== "string") return null;
  const text = url.trim();
  let pathname = null;
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(text)) {
    try {
      const parsed = new URL(text);
      if (!["https:", "http:", "ssh:", "git:"].includes(parsed.protocol)) return null;
      pathname = decodeURIComponent(parsed.pathname);
    } catch {
      return null;
    }
  } else {
    const scp = /^[^@/\s]+@[^:/\s]+:(.+)$/.exec(text);
    if (scp === null) return null;
    pathname = scp[1];
  }
  const trimmed = pathname.replace(/^\/+/, "").replace(/\/+$/, "").replace(/\.git$/i, "");
  return parseRepository(trimmed);
}

function gitEnv() {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.toUpperCase().startsWith("GIT_") ||
        ["GIT_CONFIG_GLOBAL", "GIT_CONFIG_SYSTEM", "GIT_CONFIG_NOSYSTEM", "GIT_CEILING_DIRECTORIES",
          "GIT_DISCOVERY_ACROSS_FILESYSTEM"].includes(key.toUpperCase())) env[key] = value;
  }
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_OPTIONAL_LOCKS = "0";
  return env;
}

// Read-only: git runs without a shell, from the project, with fixed arguments.
function git(root, args) {
  const result = spawnSync("git", ["-c", "core.fsmonitor=false", ...args], {
    cwd: root, env: gitEnv(), shell: false, windowsHide: true, timeout: 15000,
    maxBuffer: 64 * 1024, stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error?.code === "ENOENT") return { missing: true, out: null };
  if (result.error || result.status !== 0) return { missing: false, out: null };
  return { missing: false, out: result.stdout.toString("utf8").trim() };
}

// The origin remote, or the only remote when there is exactly one. Returns
// { repository, reason } and never the URL itself.
export function inferFromGit(root) {
  const inside = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.missing) return { repository: null, reason: "git_unavailable" };
  if (inside.out !== "true") return { repository: null, reason: "not_a_git_repository" };
  let url = git(root, ["config", "--get", "remote.origin.url"]).out;
  if (url === null) {
    const remotes = (git(root, ["remote"]).out ?? "").split("\n").filter(Boolean);
    if (remotes.length !== 1) return { repository: null, reason: remotes.length ? "remote_ambiguous" : "no_remote" };
    url = git(root, ["config", "--get", `remote.${remotes[0]}.url`]).out;
  }
  const repository = repositoryFromRemote(url);
  return repository ? { repository, reason: null } : { repository: null, reason: "remote_unrecognized" };
}

function readConfig(file) {
  // Check the type before opening: opening a FIFO for reading would block.
  let stat;
  try {
    stat = fs.statSync(file);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return { exists: false };
    return { exists: true, invalid: true };
  }
  if (!stat.isFile()) return { exists: true, invalid: true };
  let fd;
  try {
    // O_NONBLOCK also covers a file swapped for a FIFO after the check.
    fd = fs.openSync(file, fs.constants.O_RDONLY | NONBLOCK);
  } catch {
    return { exists: true, invalid: true };
  }
  try {
    if (!fs.fstatSync(fd).isFile()) return { exists: true, invalid: true };
    const buffer = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const length = fs.readSync(fd, buffer, 0, buffer.length, 0);
    if (length > MAX_CONFIG_BYTES) return { exists: true, invalid: true };
    const doc = JSON.parse(buffer.subarray(0, length).toString("utf8"));
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) return { exists: true, invalid: true };
    return { exists: true, doc };
  } catch {
    return { exists: true, invalid: true };
  } finally {
    fs.closeSync(fd);
  }
}

// The nearest config.json walking up from root, as the SDKs search.
function nearestConfig(root) {
  let dir = root;
  for (let i = 0; i < MAX_WALK_UP; i += 1) {
    const file = path.join(dir, CONFIG_PATH);
    const found = readConfig(file);
    if (found.exists) return { ...found, rel: path.relative(root, file).split(path.sep).join("/") };
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

// Writes a temporary file, then links it into place: link never replaces an
// existing entry, so a config that appeared meanwhile is kept, and a failed
// write never leaves a partial config.json behind.
function writeNewConfig(root, repository) {
  const dir = path.join(root, ".metergraph");
  try {
    if (!fs.lstatSync(dir).isDirectory()) throw new Error("unsafe_path");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    fs.mkdirSync(dir, { mode: 0o755 });
  }
  const dest = path.join(dir, "config.json");
  const temp = path.join(dir, `.config.json.${process.pid}.${Date.now()}.tmp`);
  const content = `${JSON.stringify({ version: CONFIG_VERSION, repository }, null, 2)}\n`;
  try {
    const fd = fs.openSync(temp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | NOFOLLOW, 0o644);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    fs.linkSync(temp, dest);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* already gone */ }
  }
}

const same = (a, b) => a.toLowerCase() === b.toLowerCase();

// METERGRAPH_REPOSITORY from the project env file, read only, so an identity
// the person already set there is respected. Setup has validated envFile as
// project-relative before this runs. Returns null when unset or unreadable.
export function envRepository(root, envFile) {
  let text;
  try {
    const file = path.join(root, envFile);
    if (fs.lstatSync(file).size > 1024 * 1024) return null;
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  let value = null;
  for (const line of text.split(/\r?\n/)) {
    const match = /^\s*(?:export\s+)?METERGRAPH_REPOSITORY\s*=\s*(.*?)\s*$/.exec(line);
    if (match === null) continue;
    let raw = match[1];
    const quoted = /^(["'])(.*?)\1(?:\s+#.*)?$/.exec(raw);
    raw = quoted ? quoted[2] : raw.replace(/\s+#.*$/, "");
    value = raw.trim() || null;
  }
  return value;
}

// Ensures the project has a repository identity and returns the setup result
// field. requested is a validated --repository value or null; envValue is
// METERGRAPH_REPOSITORY from the project env file, or null.
export function ensureRepositoryIdentity(root, { requested = null, skip = false, envValue = null, retried = false } = {}) {
  if (skip) return { status: "skipped", repository: null, source: null, path: null, reason: null };
  const inferred = requested === null ? inferFromGit(root) : { repository: requested, reason: null };
  const expected = inferred.repository;
  const expectedSource = requested === null ? "git_remote" : "flag";

  // The SDK uses any env value containing "/". Respect it, but report only a
  // parsed owner/name: the env file also holds secrets, so a raw value is
  // never echoed.
  if (typeof envValue === "string" && envValue.includes("/")) {
    const current = parseRepository(envValue);
    if (current === null) {
      return { status: "existing", repository: null, source: "env_file", path: null,
        reason: "env_value_unrecognized" };
    }
    const mismatch = expected !== null && !same(current, expected);
    return { status: mismatch ? "mismatch" : "existing", repository: current, source: "env_file",
      path: null, reason: mismatch ? `${expectedSource}_differs` : null, ...(mismatch ? { expected } : {}) };
  }

  const found = nearestConfig(root);
  if (found !== null) {
    const raw = found.invalid ? null : found.doc.repository;
    const usable = !found.invalid && (found.doc.version === undefined || found.doc.version === CONFIG_VERSION) &&
      typeof raw === "string" && raw.includes("/");
    if (!usable) {
      // Never rewrite an existing config; the person fixes it.
      return { status: "invalid_config", repository: null, source: "config", path: found.rel,
        reason: "config_unusable", ...(expected !== null ? { expected } : {}) };
    }
    // The SDK accepts any value containing "/"; report it only as owner/name.
    const current = parseRepository(raw);
    if (current === null) {
      return { status: "existing", repository: null, source: "config", path: found.rel,
        reason: "config_value_unrecognized" };
    }
    const mismatch = expected !== null && !same(current, expected);
    return { status: mismatch ? "mismatch" : "existing", repository: current, source: "config", path: found.rel,
      reason: mismatch ? `${expectedSource}_differs` : null, ...(mismatch ? { expected } : {}) };
  }

  if (expected === null) {
    return { status: "not_inferred", repository: null, source: null, path: null, reason: inferred.reason };
  }
  try {
    writeNewConfig(root, expected);
  } catch (error) {
    // Another setup created it first: report what is there now.
    if (error.code === "EEXIST" && !retried) return ensureRepositoryIdentity(root, { requested, envValue, retried: true });
    return { status: "write_failed", repository: null, source: expectedSource, path: CONFIG_PATH,
      reason: "config_not_written", expected };
  }
  return { status: "written", repository: expected, source: expectedSource, path: CONFIG_PATH, reason: null };
}
