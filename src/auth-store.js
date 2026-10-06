import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { systemRoot } from "./auth-browser.js";
import { AUTH_PATHS, METADATA_SCOPE, SUPPORTED_PROFILES } from "./constants.js";
import { parseOrigin } from "./origin.js";

// Per-user credential storage for the delegated Metadata OAuth grant. Only
// this module reads or writes token values. Layout, below the config
// directory chosen by --config-dir, METERGRAPH_CONFIG_DIR or the default:
//   credentials/<slot>.json   one grant, written atomically
//   credentials/<slot>.lock   held while a grant is refreshed or removed
// On POSIX systems the directories must be owner-only (0700) and owned by the
// current user, and files are created 0600 and checked the same way. On
// Windows, file modes do not protect anything, so the grant is encrypted with
// DPAPI for the current user before it is written. Existing paths with unsafe
// permissions are refused, never silently changed. Symbolic links are never
// followed below the config directory.

export class Stop extends Error {
  constructor(outcome, reason) {
    super(reason);
    this.outcome = outcome;
    this.reason = reason;
  }
}

const IS_WINDOWS = process.platform === "win32";
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const MAX_FILE_BYTES = 64 * 1024;
const SLOT = /^[0-9a-f]{32}$/;
const RECORD_KEYS = [
  "access_token",
  "client_id",
  "deployment_profile",
  "expires_at",
  "issuer",
  "origin",
  "refresh_pending",
  "refresh_token",
  "resource",
  "schema_version",
  "scope",
  "workspace_id",
].join();

export const PROTECTION = IS_WINDOWS ? "dpapi" : "owner_only_file";

// The config directory, as an absolute path. The default is derived from the
// operating system's home directory for this user. Other tools' variables
// such as CODEX_HOME are never used.
export function resolveConfigDir(flag, env = process.env) {
  if (flag !== null && flag !== undefined) return path.resolve(flag);
  const fromEnv = env.METERGRAPH_CONFIG_DIR;
  if (typeof fromEnv === "string" && fromEnv !== "") {
    if (!path.isAbsolute(fromEnv) || fromEnv.includes("\0")) throw new Stop("invalid_input", "invalid_config_dir");
    return path.resolve(fromEnv);
  }
  const home = os.homedir();
  if (typeof home !== "string" || !path.isAbsolute(home)) {
    throw new Stop("filesystem_error", "credential_store_unavailable");
  }
  return IS_WINDOWS ? path.join(home, "AppData", "Roaming", "Metergraph") : path.join(home, ".config", "metergraph");
}

// Returns { dir, credentials } after checking both directories, creating
// missing ones with owner-only permissions when create is true. Returns null
// when the store does not exist and create is false.
export function openStore(dir, { create }) {
  try {
    checkParent(dir);
    let stat = lstatOrNull(dir);
    if (stat === null) {
      if (!create) return null;
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      stat = fs.lstatSync(dir);
    }
    checkPrivate(stat, "directory");
    const credentials = path.join(dir, "credentials");
    let inner = lstatOrNull(credentials);
    if (inner === null) {
      if (!create) return null;
      fs.mkdirSync(credentials, { mode: 0o700 });
      inner = fs.lstatSync(credentials);
    }
    checkPrivate(inner, "directory");
    return { dir, credentials };
  } catch (error) {
    if (error instanceof Stop) throw error;
    throw new Stop("filesystem_error", "credential_store_unavailable");
  }
}

export function newSlot() {
  return randomBytes(16).toString("hex");
}

export function isSlot(value) {
  return typeof value === "string" && SLOT.test(value);
}

// Returns the stored record, or null when the slot has no file. A file that
// cannot be decoded is reported as unreadable, never guessed at.
export function readCredential(store, slot) {
  const file = slotPath(store, slot, "json");
  let content;
  try {
    content = readPrivateFile(file);
  } catch (error) {
    if (error instanceof Stop) throw error;
    throw new Stop("filesystem_error", "credential_store_unavailable");
  }
  if (content === null) return null;
  const record = decode(content);
  if (record === null) throw new Stop("login_required", "credential_unreadable");
  return record;
}

// Atomically replaces the slot file with record.
export function writeCredential(store, slot, record) {
  if (!validRecord(record)) throw new Error("credential record is not valid");
  try {
    const content = encode(record);
    writePrivateFile(store.credentials, `${slot}.json`, content);
  } catch (error) {
    if (error instanceof Stop) throw error;
    throw new Stop("filesystem_error", "credential_write_failed");
  }
}

// Removes the slot file. Returns true when a file was removed. A symbolic
// link or other non-regular entry in its place is refused, not removed.
export function deleteCredential(store, slot) {
  const file = slotPath(store, slot, "json");
  try {
    const stat = lstatOrNull(file);
    if (stat === null) return false;
    if (!stat.isFile()) throw new Stop("conflict", "credential_path_unsafe");
    fs.unlinkSync(file);
    return true;
  } catch (error) {
    if (error instanceof Stop) throw error;
    throw new Stop("filesystem_error", "credential_write_failed");
  }
}

// Runs work while holding the slot's exclusive lock file. Waits up to waitMs
// for another process to finish, then stops with a conflict. A lock left by
// a killed process stays until it is deleted, because taking over a lock
// that may still be held could let two refreshes use one refresh token.
// An optional signal (a deadline or Ctrl+C) stops the wait, and stops before
// work starts, with authorization_failed/cancelled. A lock this call never
// took is never touched.
export async function withSlotLock(store, slot, work, { waitMs, signal = null }) {
  const lock = slotPath(store, slot, "lock");
  const until = Date.now() + waitMs;
  const cancelled = () => new Stop("authorization_failed", "cancelled");
  for (;;) {
    if (signal?.aborted) throw cancelled();
    try {
      const fd = fs.openSync(lock, "wx", 0o600);
      fs.closeSync(fd);
      break;
    } catch (error) {
      if (error.code !== "EEXIST") throw new Stop("filesystem_error", "credential_store_unavailable");
      if (Date.now() >= until) throw new Stop("conflict", "credential_locked");
      await pause(50, signal);
    }
  }
  try {
    if (signal?.aborted) throw cancelled();
    return await work();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // Reported by the next run as a held lock.
    }
  }
}

// Resolves after ms, or as soon as signal aborts.
function pause(ms, signal) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function validRecord(record) {
  if (record === null || typeof record !== "object" || Array.isArray(record)) return false;
  if (Object.keys(record).sort().join() !== RECORD_KEYS) return false;
  const origin = parseOrigin(record.origin);
  return (
    record.schema_version === 1 &&
    origin === record.origin &&
    record.issuer === `${origin}${AUTH_PATHS.issuer}` &&
    record.resource === `${origin}${AUTH_PATHS.resource}` &&
    SUPPORTED_PROFILES.includes(record.deployment_profile) &&
    typeof record.workspace_id === "string" &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(record.workspace_id) &&
    record.scope === METADATA_SCOPE &&
    printable(record.client_id, 256) &&
    printable(record.access_token, 8192) &&
    printable(record.refresh_token, 4096) &&
    Number.isSafeInteger(record.expires_at) &&
    typeof record.refresh_pending === "boolean"
  );
}

function printable(value, max) {
  return typeof value === "string" && value.length > 0 && value.length <= max && /^[\x21-\x7e]+$/.test(value);
}

function slotPath(store, slot, extension) {
  if (!isSlot(slot)) throw new Error("invalid credential slot");
  return path.join(store.credentials, `${slot}.${extension}`);
}

// File format: { schema_version, protection, credential } where credential
// is the record itself for owner_only_file, and base64 DPAPI output for dpapi.
function encode(record) {
  const plain = JSON.stringify(record);
  const credential = IS_WINDOWS ? dpapi("protect", Buffer.from(plain, "utf8")).toString("base64") : record;
  return Buffer.from(`${JSON.stringify({ schema_version: 1, protection: PROTECTION, credential })}\n`);
}

function decode(content) {
  let wrapper;
  try {
    wrapper = JSON.parse(content.toString("utf8"));
  } catch {
    return null;
  }
  if (wrapper === null || typeof wrapper !== "object" || wrapper.schema_version !== 1) return null;
  if (wrapper.protection !== PROTECTION) return null;
  let record = wrapper.credential;
  if (IS_WINDOWS) {
    if (typeof record !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(record)) return null;
    try {
      record = JSON.parse(dpapi("unprotect", Buffer.from(record, "base64")).toString("utf8"));
    } catch (error) {
      if (error instanceof Stop) throw error;
      return null;
    }
  }
  return validRecord(record) ? record : null;
}

// A fixed Windows PowerShell script, passed as an encoded constant. The data
// travels on stdin and stdout pipes only, never on the command line. The
// optional entropy ties the blob to this purpose; the scope is the current
// user, so another account on the machine cannot decrypt it.
const DPAPI_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  "Add-Type -AssemblyName System.Security",
  "$mode = [Console]::In.ReadLine()",
  "$data = [Convert]::FromBase64String([Console]::In.ReadLine())",
  "$entropy = [Text.Encoding]::UTF8.GetBytes('metergraph-cli-credential-v1')",
  "$scope = [Security.Cryptography.DataProtectionScope]::CurrentUser",
  "if ($mode -eq 'protect') { $out = [Security.Cryptography.ProtectedData]::Protect($data, $entropy, $scope) }",
  "elseif ($mode -eq 'unprotect') { $out = [Security.Cryptography.ProtectedData]::Unprotect($data, $entropy, $scope) }",
  "else { exit 2 }",
  "[Console]::Out.Write([Convert]::ToBase64String($out))",
].join("\n");
const DPAPI_COMMAND = Buffer.from(DPAPI_SCRIPT, "utf16le").toString("base64");

export function dpapi(mode, data) {
  const powershell = path.win32.join(systemRoot(), "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  const result = spawnSync(
    powershell,
    ["-NoLogo", "-NoProfile", "-NonInteractive", "-EncodedCommand", DPAPI_COMMAND],
    {
      input: `${mode}\n${data.toString("base64")}\n`,
      encoding: "utf8",
      shell: false,
      windowsHide: true,
      timeout: 30000,
      maxBuffer: 1024 * 1024,
    },
  );
  const out = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (result.error || result.status !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(out)) {
    throw new Stop("filesystem_error", "credential_protection_failed");
  }
  return Buffer.from(out, "base64");
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// A world-writable parent without the sticky bit would let another user
// replace the config directory itself.
function checkParent(dir) {
  if (IS_WINDOWS) return;
  let stat;
  try {
    stat = fs.statSync(path.dirname(dir));
  } catch {
    return;
  }
  if ((stat.mode & 0o002) !== 0 && (stat.mode & 0o1000) === 0) {
    throw new Stop("conflict", "credential_permissions_unsafe");
  }
}

function checkPrivate(stat, kind) {
  const right = kind === "directory" ? stat.isDirectory() : stat.isFile();
  if (stat.isSymbolicLink() || !right) throw new Stop("conflict", "credential_path_unsafe");
  if (IS_WINDOWS) return;
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Stop("conflict", "credential_path_not_owned");
  }
  if ((stat.mode & 0o077) !== 0) throw new Stop("conflict", "credential_permissions_unsafe");
}

function readPrivateFile(file) {
  const stat = lstatOrNull(file);
  if (stat === null) return null;
  checkPrivate(stat, "file");
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (error.code === "ELOOP") throw new Stop("conflict", "credential_path_unsafe");
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const opened = fs.fstatSync(fd);
    checkPrivate(opened, "file");
    if (opened.size > MAX_FILE_BYTES) throw new Stop("login_required", "credential_unreadable");
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

// Writes an exclusive owner-only temporary file next to the target, flushes
// it and renames it over the target. A rename replaces a link itself rather
// than following it, but an unexpected entry at the target is refused first.
function writePrivateFile(dir, name, content) {
  const dest = path.join(dir, name);
  const existing = lstatOrNull(dest);
  if (existing !== null && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Stop("conflict", "credential_path_unsafe");
  }
  const temp = path.join(dir, `.${name}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(temp, "wx", 0o600);
  try {
    try {
      if (!IS_WINDOWS) fs.fchmodSync(fd, 0o600);
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(temp, dest);
  } catch (error) {
    try {
      fs.unlinkSync(temp);
    } catch {
      // Already renamed or never created.
    }
    throw error;
  }
  syncDir(dir);
}

function syncDir(dir) {
  if (IS_WINDOWS) return;
  try {
    const fd = fs.openSync(dir, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    // Not supported everywhere. The rename itself is still atomic.
  }
}
