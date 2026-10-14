import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// The last ingest-key issuance refusal for this project's setup family, so a
// rerun can report it instead of asking for another approval at once. With
// --json --no-browser the refusal happens in the detached waiter after the
// command has printed its only line, so without this record it would be lost.
//
// It is a separate file, not a field of setup.json, so an older CLI that
// validates setup.json strictly keeps reading the project. It holds no
// credential: the family ID, a fixed reason and, for the rate budget, when
// the refusal stops applying. Any read problem is treated as no record.
const FILE = "setup-refusal.json";
const MAX_BYTES = 512;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const REFUSAL_REASONS = Object.freeze(["setup_rate_limited", "setup_key_limit"]);
// A rate refusal is reported for at most this long; the service's windows
// are one minute.
const MAX_RATE_WAIT_MS = 5 * 60 * 1000;

const fileFor = (root) => path.join(root, ".metergraph", FILE);

function valid(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join() === "family_id,reason,retry_at,schema_version" &&
    value.schema_version === 1 && UUID.test(value.family_id) && REFUSAL_REASONS.includes(value.reason) &&
    (value.retry_at === null || (typeof value.retry_at === "string" && Number.isFinite(Date.parse(value.retry_at))));
}

export function readSetupRefusal(root) {
  const file = fileFor(root);
  let fd;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.nlink !== 1 || stat.size > MAX_BYTES) return null;
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
    const opened = fs.fstatSync(fd);
    if (opened.dev !== stat.dev || opened.ino !== stat.ino || opened.size > MAX_BYTES) return null;
    const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(fs.readFileSync(fd)));
    return valid(value) ? value : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// Best effort: a record that cannot be written only means a rerun asks for
// a new approval, as before.
export function writeSetupRefusal(root, familyId, reason, retryAfterSeconds = null, now = Date.now()) {
  const retryAt = reason === "setup_rate_limited"
    ? new Date(now + Math.min((retryAfterSeconds ?? 60) * 1000, MAX_RATE_WAIT_MS)).toISOString()
    : null;
  const value = { schema_version: 1, family_id: familyId, reason, retry_at: retryAt };
  if (!valid(value)) return false;
  const dir = path.join(root, ".metergraph");
  const temp = path.join(dir, `.refusal.${randomBytes(8).toString("hex")}.tmp`);
  try {
    if (!fs.lstatSync(dir).isDirectory()) return false;
    const fd = fs.openSync(temp, "wx", 0o600);
    try { fs.writeFileSync(fd, `${JSON.stringify(value)}\n`); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temp, fileFor(root));
    return true;
  } catch {
    try { fs.unlinkSync(temp); } catch { /* no temp */ }
    return false;
  }
}

export function clearSetupRefusal(root) {
  try {
    const stat = fs.lstatSync(fileFor(root));
    if (stat.isFile() || stat.isSymbolicLink()) fs.unlinkSync(fileFor(root));
  } catch { /* nothing to clear */ }
}

// What a rerun should report for a recorded refusal of this family, or null
// to proceed. A rate refusal applies until its retry time; a key-limit
// refusal is reported once, so the rerun after the person revokes keys asks
// for a new approval.
export function pendingRefusal(root, familyId, now = Date.now()) {
  const record = readSetupRefusal(root);
  if (record === null || record.family_id !== familyId) return null;
  if (record.reason === "setup_rate_limited") {
    const remaining = Math.ceil((Date.parse(record.retry_at) - now) / 1000);
    if (remaining > 0) return { reason: record.reason, retryAfter: remaining };
    clearSetupRefusal(root);
    return null;
  }
  clearSetupRefusal(root);
  return { reason: record.reason, retryAfter: null };
}
