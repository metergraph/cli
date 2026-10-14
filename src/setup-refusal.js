import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

// What the --json --no-browser background waiter is doing with an approval
// it received, so the agent's rerun can report it instead of asking the
// person for another approval. The waiter is the only writer: a foreground
// run reports a refusal directly and never records one.
//
//   redeeming  the waiter holds an approval and is redeeming it (possibly
//              waiting out a short Retry-After). A rerun waits for it.
//   refused    the service refused the redemption: the rate budget until
//              retry_at, or the workspace's key cap. A rerun reports it.
//
// The record names the setup family, the waiter's process and the approval
// it came from. It holds no credential. It is a separate file, not a field of
// setup.json, so an older CLI that validates setup.json strictly keeps
// reading the project. Any read problem is treated as no record.
//
// The file lives in the project, so its content is untrusted: a record can
// only delay setup for as long as this CLI would ever write it for. A
// redeeming record expiring, or a refusal retrying, further out than that is
// ignored and removed, so a crafted or committed record cannot block setup.
const FILE = "setup-refusal.json";
const MAX_BYTES = 1024;
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEYS = "approval_id,expires_at,family_id,pid,reason,retry_at,schema_version,state";
export const REFUSAL_REASONS = Object.freeze(["setup_rate_limited", "setup_key_limit"]);
// A redeeming record outlives no waiter: redemption plus two Retry-After
// waits takes well under this. A rate refusal is reported for at most this.
const MAX_RECORD_MS = 10 * 60 * 1000;
const MAX_RATE_WAIT_MS = 5 * 60 * 1000;

const fileFor = (root) => path.join(root, ".metergraph", FILE);
const isTime = (value) => typeof value === "string" && Number.isFinite(Date.parse(value));

function valid(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).sort().join() !== KEYS || value.schema_version !== 2 ||
      !UUID.test(value.family_id) || !UUID.test(value.approval_id) ||
      !Number.isInteger(value.pid) || value.pid < 1 || !isTime(value.expires_at)) return false;
  if (value.state === "redeeming") return value.reason === null && value.retry_at === null;
  if (value.state === "refused") {
    return REFUSAL_REASONS.includes(value.reason) &&
      (value.reason === "setup_key_limit" ? value.retry_at === null : isTime(value.retry_at));
  }
  return false;
}

function read(root) {
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

// Best effort: a record that cannot be written only means a rerun asks for a
// new approval, as it did before records existed.
function write(root, value) {
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

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === "EPERM";
  }
}

// The waiter's handle on one approval it received. Every method is best
// effort and only ever touches this approval's own record.
export function waiterRecord(root, familyId, now = Date.now) {
  const approvalId = randomUUID();
  const base = () => ({ schema_version: 2, family_id: familyId, approval_id: approvalId, pid: process.pid,
    expires_at: new Date(now() + MAX_RECORD_MS).toISOString() });
  return {
    // Early, as soon as an approval arrives: never replaces another waiter
    // that is still alive. With force, once this waiter has won the setup
    // state for its redemption, it takes the record over.
    redeeming: ({ force = false } = {}) => {
      const current = read(root);
      if (!force && current?.state === "redeeming" && current.approval_id !== approvalId &&
          current.pid !== process.pid && alive(current.pid) && Date.parse(current.expires_at) > now()) return false;
      return write(root, { ...base(), state: "redeeming", reason: null, retry_at: null });
    },
    refused: (reason, retryAfterSeconds = null) => write(root, { ...base(), state: "refused", reason,
      retry_at: reason === "setup_rate_limited"
        ? new Date(now() + Math.min((retryAfterSeconds ?? 60) * 1000, MAX_RATE_WAIT_MS)).toISOString()
        : null }),
    // Any other outcome: drop a redeeming record this waiter left behind.
    settle: () => {
      const record = read(root);
      if (record?.approval_id === approvalId && record.state === "redeeming") clearSetupRefusal(root);
    },
  };
}

// What a run should report before asking for an approval, or null to
// proceed. familyId and delivered describe the saved setup state; a refusal
// for another family, or for one already delivered, no longer applies.
export function pendingRefusal(root, { familyId, delivered }, now = Date.now()) {
  const record = read(root);
  if (record === null) return null;
  const expires = Date.parse(record.expires_at);
  const retry = record.retry_at === null ? null : Date.parse(record.retry_at);
  if (expires <= now || expires > now + MAX_RECORD_MS || (retry !== null && retry > now + MAX_RATE_WAIT_MS)) {
    clearSetupRefusal(root);
    return null;
  }
  // A delivered family has nothing pending, whatever the record says.
  if (delivered) {
    clearSetupRefusal(root);
    return null;
  }
  if (record.state === "redeeming") {
    if (record.pid === process.pid || !alive(record.pid)) {
      clearSetupRefusal(root);
      return null;
    }
    // A live waiter matters only for the saved family, or before any state
    // is saved (a combined sign in writes it after the approval). A record
    // for another family does not block this setup.
    if (familyId !== null && record.family_id !== familyId) return null;
    return { reason: "setup_in_progress", retryAfter: 5 };
  }
  if (record.family_id !== familyId) {
    clearSetupRefusal(root);
    return null;
  }
  if (record.reason === "setup_rate_limited") {
    const remaining = Math.ceil((Date.parse(record.retry_at) - now) / 1000);
    if (remaining > 0) return { reason: record.reason, retryAfter: remaining };
    clearSetupRefusal(root);
    return null;
  }
  clearSetupRefusal(root);
  return { reason: record.reason, retryAfter: null };
}
