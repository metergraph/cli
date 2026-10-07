import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { Stop } from "./auth-store.js";

// Public, non-credential project state. It is persisted before browser
// approval so a lost redemption response can be recovered by asking the
// owner to approve replacement of the pending family. No token, receipt,
// verifier or callback URL is ever stored here.
const FILE = "setup.json";
const LOCK = "setup.lock";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_BYTES = 4096;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

function valid(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join() === "family_id,key_id,origin,phase,schema_version,workspace_id" &&
    value.schema_version === 1 && UUID.test(value.family_id) &&
    (value.key_id === null || UUID.test(value.key_id)) &&
    ["unsubmitted", "redeem_attempted", "delivered"].includes(value.phase) &&
    typeof value.origin === "string" && typeof value.workspace_id === "string" && UUID.test(value.workspace_id);
}

function fileFor(root) { return path.join(root, ".metergraph", FILE); }

export function readSetupState(root) {
  const file = fileFor(root);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) {
    if (error.code === "ENOENT") return null;
    throw new Stop("filesystem_error", "setup_state_read_failed");
  }
  if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) throw new Stop("conflict", "setup_state_unsafe");
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > MAX_BYTES ||
        opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Stop("conflict", "setup_state_unsafe");
    const content = fs.readFileSync(fd);
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(content));
    if (!valid(value)) throw new Stop("conflict", "setup_state_invalid");
    return { value, content };
  } catch (error) {
    if (error instanceof Stop) throw error;
    throw new Stop("conflict", "setup_state_invalid");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function newSetupState(origin, workspaceId) {
  return { schema_version: 1, origin, workspace_id: workspaceId, family_id: randomUUID(), key_id: null, phase: "unsubmitted" };
}

// Compare-and-swap under a project-local exclusive lock. A concurrent setup
// or a user edit wins; this command never overwrites it.
export function writeSetupState(root, next, previous) {
  if (!valid(next)) throw new Error("invalid setup state");
  const dir = path.join(root, ".metergraph");
  const lock = path.join(dir, LOCK);
  const dest = fileFor(root);
  const temp = path.join(dir, `.setup.${randomBytes(8).toString("hex")}.tmp`);
  let locked = false;
  try {
    const dirStat = fs.lstatSync(dir);
    if (!dirStat.isDirectory()) throw new Stop("conflict", "setup_state_unsafe");
    fs.closeSync(fs.openSync(lock, "wx", 0o600));
    locked = true;
    const now = readSetupState(root);
    if (!(previous === null ? now === null : now !== null && now.content.equals(previous.content))) {
      throw new Stop("conflict", "setup_state_changed");
    }
    const content = Buffer.from(`${JSON.stringify(next, null, 2)}\n`);
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, dest);
  } catch (error) {
    if (error instanceof Stop) throw error;
    if (error.code === "EEXIST") throw new Stop("conflict", "setup_state_locked");
    throw new Stop("filesystem_error", "setup_state_write_failed");
  } finally {
    try { fs.unlinkSync(temp); } catch { /* no temp */ }
    if (locked) { try { fs.unlinkSync(lock); } catch { /* next run refuses */ } }
  }
}
