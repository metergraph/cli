import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Stop, isSlot } from "./auth-store.js";
import { SUPPORTED_PROFILES } from "./constants.js";
import { parseOrigin } from "./origin.js";

// The project binding, .metergraph/project.json, names which origin,
// workspace and profile a project is signed in to and which credential slot
// in the user's private store holds the grant. It holds no credential, user
// name or absolute path, so it is safe to commit. Other files in .metergraph,
// such as skill receipts, are never touched.

export const BINDING_PATH = ".metergraph/project.json";
const DIR = ".metergraph";
const FILE = "project.json";
const LOCK = "project.lock";
const MAX_BYTES = 16 * 1024;
const KEYS = ["credential_slot", "deployment_profile", "origin", "schema_version", "workspace_id"].join();
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

export function resolveProject(project) {
  try {
    const real = fs.realpathSync(path.resolve(project ?? process.cwd()));
    if (fs.statSync(real).isDirectory()) return real;
  } catch {
    // Fall through to the fixed error.
  }
  throw new Stop("invalid_input", "invalid_project");
}

// Returns { binding, content } or null when the project is not bound.
export function readBinding(root) {
  try {
    const dir = lstatOrNull(path.join(root, DIR));
    if (dir === null) return null;
    if (!dir.isDirectory()) throw new Stop("conflict", "unsafe_path");
    const content = readRegular(path.join(root, DIR, FILE));
    if (content === null) return null;
    const binding = parse(content);
    if (binding === null) throw new Stop("conflict", "binding_invalid");
    return { binding, content };
  } catch (error) {
    if (error instanceof Stop) throw error;
    throw new Stop("filesystem_error", "read_failed");
  }
}

export function bindingFor({ origin, workspaceId, profile, slot }) {
  return {
    schema_version: 1,
    origin,
    workspace_id: workspaceId,
    deployment_profile: profile,
    credential_slot: slot,
  };
}

// Writes binding in place of previous (the { content } readBinding saw, or
// null). Under the project lock, the file must still be exactly previous, so
// a concurrent change is never overwritten. A failed write leaves the
// previous file and removes a .metergraph directory this call created.
export function writeBinding(root, binding, previous) {
  const content = Buffer.from(`${JSON.stringify(binding, null, 2)}\n`);
  if (parse(content) === null) throw new Error("binding is not valid");
  const dir = path.join(root, DIR);
  let created = false;
  try {
    try {
      fs.mkdirSync(dir);
      created = true;
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
      if (!fs.lstatSync(dir).isDirectory()) throw new Stop("conflict", "unsafe_path");
    }
    withProjectLock(dir, () => {
      expectUnchanged(dir, previous);
      replace(dir, content);
    });
  } catch (error) {
    if (created) {
      try {
        fs.rmdirSync(dir);
      } catch {
        // Not empty. An empty directory is harmless.
      }
    }
    if (error instanceof Stop) throw error;
    throw new Stop("filesystem_error", "binding_write_failed");
  }
}

// Removes the binding if it is still exactly previous.
export function removeBinding(root, previous) {
  const dir = path.join(root, DIR);
  try {
    withProjectLock(dir, () => {
      expectUnchanged(dir, previous);
      fs.unlinkSync(path.join(dir, FILE));
    });
  } catch (error) {
    if (error instanceof Stop) throw error;
    throw new Stop("filesystem_error", "binding_write_failed");
  }
}

function withProjectLock(dir, work) {
  const lock = path.join(dir, LOCK);
  try {
    fs.closeSync(fs.openSync(lock, "wx"));
  } catch (error) {
    if (error.code === "EEXIST") throw new Stop("conflict", "binding_locked");
    throw error;
  }
  try {
    return work();
  } finally {
    try {
      fs.unlinkSync(lock);
    } catch {
      // Reported by the next run as a held lock.
    }
  }
}

function expectUnchanged(dir, previous) {
  const now = readRegular(path.join(dir, FILE));
  const same = previous === null ? now === null : now !== null && now.equals(previous.content);
  if (!same) throw new Stop("conflict", "binding_changed");
}

function replace(dir, content) {
  const dest = path.join(dir, FILE);
  const temp = path.join(dir, `.${FILE}.${randomBytes(6).toString("hex")}.tmp`);
  const fd = fs.openSync(temp, "wx", 0o666);
  try {
    try {
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
}

// Accepts only the exact shape this CLI writes.
function parse(content) {
  let value;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  if (Object.keys(value).sort().join() !== KEYS) return null;
  if (value.schema_version !== 1) return null;
  if (typeof value.origin !== "string" || parseOrigin(value.origin) !== value.origin) return null;
  if (typeof value.workspace_id !== "string" || !UUID.test(value.workspace_id)) return null;
  if (!SUPPORTED_PROFILES.includes(value.deployment_profile)) return null;
  if (!isSlot(value.credential_slot)) return null;
  return value;
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

function readRegular(file) {
  const stat = lstatOrNull(file);
  if (stat === null) return null;
  if (!stat.isFile()) throw new Stop("conflict", "unsafe_path");
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (error.code === "ELOOP") throw new Stop("conflict", "unsafe_path");
    throw error;
  }
  try {
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Stop("conflict", "unsafe_path");
    if (opened.size > MAX_BYTES) throw new Stop("conflict", "binding_invalid");
    return fs.readFileSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}
