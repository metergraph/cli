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
const PROFILES = new Set(["managed", "local", "byoc-core"]);
const CLIENTS = new Set(["codex", "claude", "cursor"]);
const PHASES = new Set(["unsubmitted", "redeem_attempted", "delivered"]);
const SKILL = new Set(["pending", "installed", "skipped"]);
const LEGACY_KEYS = "family_id,key_id,origin,phase,schema_version,workspace_id";
const KEYS = "completed_steps,deployment_profile,family_id,key_id,origin,pending_steps,phase,schema_version,selected_client,skill_status,workspace_id";

function steps(value) {
  const completed = ["login"];
  if (value.phase === "delivered") completed.push("credential");
  if (value.skill_status === "installed") completed.push("skill");
  const pending = [];
  if (value.phase !== "delivered") pending.push("credential");
  if (value.skill_status !== "installed") pending.push("skill");
  pending.push("instrument", "verify", "view");
  return { completed, pending };
}

export function withSetupState(value, patch = {}) {
  const next = { ...value, ...patch };
  const { completed, pending } = steps(next);
  next.completed_steps = completed;
  next.pending_steps = pending;
  return next;
}

export function setupReceipt(value) {
  return {
    origin: value.origin,
    workspace_id: value.workspace_id,
    deployment_profile: value.deployment_profile,
    client: value.selected_client,
    completed_steps: [...value.completed_steps],
    pending_steps: [...value.pending_steps],
  };
}

function core(value) {
  return value.schema_version === 1 && UUID.test(value.family_id) &&
    (value.key_id === null || UUID.test(value.key_id)) && PHASES.has(value.phase) &&
    typeof value.origin === "string" && typeof value.workspace_id === "string" && UUID.test(value.workspace_id);
}

function valid(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join() === KEYS && core(value) &&
    PROFILES.has(value.deployment_profile) &&
    (value.selected_client === null || CLIENTS.has(value.selected_client)) && SKILL.has(value.skill_status) &&
    (value.skill_status !== "installed" || value.selected_client !== null) &&
    JSON.stringify(value.completed_steps) === JSON.stringify(steps(value).completed) &&
    JSON.stringify(value.pending_steps) === JSON.stringify(steps(value).pending);
}

function legacy(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join() === LEGACY_KEYS && core(value);
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
    if (!valid(value) && !legacy(value)) throw new Stop("conflict", "setup_state_invalid");
    return { value: legacy(value) ? withSetupState({ ...value, deployment_profile: null,
      selected_client: null, skill_status: "pending" }) : value, content };
  } catch (error) {
    if (error instanceof Stop) throw error;
    throw new Stop("conflict", "setup_state_invalid");
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

export function newSetupState(origin, workspaceId, profile, client) {
  return withSetupState({ schema_version: 1, origin, workspace_id: workspaceId,
    deployment_profile: profile, selected_client: client, skill_status: client === null ? "skipped" : "pending",
    family_id: randomUUID(), key_id: null, phase: "unsubmitted" });
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
