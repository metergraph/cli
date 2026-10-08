import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import {
  CONNECTION_GUIDE_URL,
  SKILLS_REPOSITORY_URL,
  SKILL_CLIENTS,
  SKILL_RUNTIMES,
} from "./constants.js";
import { loadBundledPack, loadBundledSkill, revisionFor, sha256Hex } from "./skill-bundle.js";

// Project-scoped skill installer. For each skill it writes exactly two things
// inside the project: the client's SKILL.md and a secret-free ownership
// receipt. "skill" installs the setup skill with the receipt below; "skills"
// installs each skill of the workflow pack with its own receipt in
// .metergraph/skills/. It never
// touches client settings, AGENTS.md, CLAUDE.md or any other file, never
// follows a symbolic link below the resolved project directory and makes no
// network request. All file work is synchronous, so a signal cannot run
// JavaScript between two steps.

const RECEIPT_DIR = ".metergraph";
const RECEIPT_FILE = "skill-installations.json";
const LOCK_FILE = "skill-installations.lock";
const PACK_RECEIPT_DIRS = [RECEIPT_DIR, "skills"];
const CORE_RECEIPT = Object.freeze({ dirs: [RECEIPT_DIR], file: RECEIPT_FILE, lock: LOCK_FILE });
const MAX_RECEIPT_BYTES = 64 * 1024;
const MAX_SKILL_BYTES = 1024 * 1024;
const ENTRY_KEYS = ["client", "path", "revision", "runtimes", "sha256", "skill"];
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;

const MESSAGES = {
  invalid_project: "--project must name an existing directory.",
  client_not_supported:
    "This client cannot load project skill files. Follow the connection guide instead. Nothing was written.",
  runtime_not_supported:
    "This runtime has no shell or project checkout for skill files. Follow the connection guide instead. Nothing was written.",
  not_owned:
    "A skill already exists at the target path and was not installed by this CLI. Nothing was changed.",
  modified:
    "The skill file was changed after this CLI installed it. Nothing was changed. Restore or remove the file, then retry.",
  not_installed:
    'This CLI has not installed the skill for this client in this project. Run "metergraph skill install" first.',
  update_required:
    'An older skill revision installed by this CLI is present. Run "metergraph skill update" to replace it.',
  unsafe_path:
    "A path used by the installer is a symbolic link or is not a regular file or directory. Nothing was changed.",
  receipt_invalid: `The receipt ${RECEIPT_DIR}/${RECEIPT_FILE} is not valid. Nothing was changed.`,
  changed_during_install: "A file changed while the skill was being installed. Changes were rolled back.",
  locked: `Another skill install may be running. If none is, delete ${RECEIPT_DIR}/${LOCK_FILE} and retry.`,
  read_failed: "The project files could not be read. Nothing was changed.",
  write_failed: "The skill could not be written. Changes were rolled back.",
  rollback_failed: `The skill could not be written and the rollback did not finish. Check the skill path and ${RECEIPT_DIR}/${RECEIPT_FILE}.`,
  bundled_skill_invalid:
    "The skill bundled with this CLI failed its integrity check. Reinstall the CLI. Nothing was written.",
};

class Stop extends Error {
  constructor(outcome, reason) {
    super(reason);
    this.outcome = outcome;
    this.reason = reason;
  }
}

// Returns { outcome, reason, message, data }. Every string comes from this
// package. Paths in data are relative to the project.
export function runSkill({ action, client, runtime, project }) {
  const context = { action, client, runtime, target: null, bundle: null, receipt: CORE_RECEIPT };
  if (!Object.hasOwn(SKILL_CLIENTS, client)) {
    return handoff(context, "client_not_supported");
  }
  if (!SKILL_RUNTIMES.includes(runtime)) {
    return handoff(context, "runtime_not_supported");
  }
  try {
    return execute(context, project);
  } catch (error) {
    if (error instanceof Stop) return failure(context, error.outcome, error.reason);
    return failure(context, "filesystem_error", "write_failed");
  }
}

function execute(context, project) {
  context.bundle = loadBundledSkill();
  if (context.bundle === null) throw new Stop("internal_error", "bundled_skill_invalid");
  context.target = targetFor(context.client, context.bundle.name);
  const root = resolveProject(project);
  return success(context, apply(root, context));
}

// Installs or updates one skill and returns its status, or throws a Stop.
function apply(root, context) {
  const { action, runtime, receipt } = context;

  // Decide from a read-only look first, so a matching rerun writes nothing.
  let state = inspect(root, context);
  let plan = decide(action, runtime, state, context.bundle);
  if (plan.noop) return plan.status;

  return deferSignals(() => {
    const createdMeta = ensureDirs(root, receipt.dirs);
    const lockPath = path.join(root, ...receipt.dirs, receipt.lock);
    let done = false;
    try {
      acquireLock(lockPath);
      try {
        // Look again under the lock in case another run changed anything.
        state = inspect(root, context);
        plan = decide(action, runtime, state, context.bundle);
        if (!plan.noop) commit(root, context, state, plan);
        done = true;
        return plan.status;
      } finally {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          // A lock that cannot be removed is reported by the next run.
        }
      }
    } finally {
      if (!done) removeDirs(createdMeta);
    }
  });
}

function targetFor(client, name) {
  const dirs = [SKILL_CLIENTS[client].dir, "skills", name];
  return { dirs, relative: [...dirs, "SKILL.md"].join("/") };
}

function resolveProject(project) {
  try {
    const real = fs.realpathSync(path.resolve(project ?? process.cwd()));
    if (fs.statSync(real).isDirectory()) return real;
  } catch {
    // Fall through to the fixed error.
  }
  throw new Stop("invalid_input", "invalid_project");
}

// Reads the receipt and the target without writing. Any symbolic link or
// non-regular entry on either path stops the run.
function inspect(root, context) {
  try {
    checkDirs(root, context.receipt.dirs);
    const receiptFile = readRegular(path.join(root, ...context.receipt.dirs, context.receipt.file), MAX_RECEIPT_BYTES);
    let receipt = null;
    if (receiptFile !== null) {
      receipt = receiptFile.content === null ? null : parseReceipt(receiptFile.content, context.bundle.name);
      if (receipt === null) throw new Stop("conflict", "receipt_invalid");
    }
    const skillDirExists = checkDirs(root, context.target.dirs);
    const file = skillDirExists
      ? readRegular(path.join(root, ...context.target.dirs, "SKILL.md"), MAX_SKILL_BYTES)
      : null;
    return {
      receipt,
      receiptFile,
      entry: receipt?.installations.find((entry) => entry.client === context.client) ?? null,
      skillDirExists,
      file,
    };
  } catch (error) {
    if (error instanceof Stop) throw error;
    throw new Stop("filesystem_error", "read_failed");
  }
}

// Returns { status, noop, writeSkill } or throws a conflict. There is no
// force option: an unowned or modified skill is never replaced.
function decide(action, runtime, state, bundle) {
  const { entry, file, skillDirExists } = state;
  if (entry === null) {
    if (file !== null || skillDirExists) throw new Stop("conflict", "not_owned");
    if (action === "update") throw new Stop("conflict", "not_installed");
    return { status: "installed", noop: false, writeSkill: true };
  }
  if (file !== null && (file.content === null || sha256Hex(file.content) !== entry.sha256)) {
    throw new Stop("conflict", "modified");
  }
  const current = entry.revision === bundle.revision;
  if (!current && action === "install") throw new Stop("conflict", "update_required");
  if (file !== null && current) {
    return { status: "reused", noop: entry.runtimes.includes(runtime), writeSkill: false };
  }
  return { status: current ? "installed" : "updated", noop: false, writeSkill: true };
}

// Writes the skill, then the receipt. If the receipt cannot be written the
// skill is restored to its previous state. Ownership is therefore never
// recorded for a skill that was not written. A crash between the two steps
// leaves a skill the receipt does not vouch for, which later runs refuse to
// touch.
function commit(root, context, state, plan) {
  const { bundle, target } = context;
  const skillPath = path.join(root, ...target.dirs, "SKILL.md");
  const receiptPath = path.join(root, ...context.receipt.dirs, context.receipt.file);
  const receipt = nextReceipt(state.receipt, context, target.relative);
  let createdDirs = [];
  let skillWritten = false;
  try {
    if (plan.writeSkill) {
      createdDirs = ensureDirs(root, target.dirs);
      replaceFile(skillPath, bundle.content, state.file);
      skillWritten = true;
    }
    if (state.receiptFile === null || !state.receiptFile.content.equals(receipt)) {
      replaceFile(receiptPath, receipt, state.receiptFile);
    }
  } catch (error) {
    try {
      if (skillWritten) {
        if (state.file === null) fs.unlinkSync(skillPath);
        else replaceFile(skillPath, state.file.content, { content: bundle.content, mode: state.file.mode });
      }
    } catch {
      throw new Stop("filesystem_error", "rollback_failed");
    }
    removeDirs(createdDirs);
    throw error;
  }
}

function nextReceipt(receipt, context, relative) {
  const { bundle, client, runtime } = context;
  const previous = receipt?.installations.find((entry) => entry.client === client);
  const runtimes = [...new Set([...(previous?.runtimes ?? []), runtime])].sort();
  const installations = (receipt?.installations ?? []).filter((entry) => entry.client !== client);
  installations.push({
    client,
    path: relative,
    skill: bundle.name,
    revision: bundle.revision,
    sha256: bundle.sha256,
    runtimes,
  });
  installations.sort((a, b) => (a.client < b.client ? -1 : 1));
  return Buffer.from(`${JSON.stringify({ schema_version: 1, installations }, null, 2)}\n`);
}

// Accepts only the exact shape this CLI writes. Each entry is bound to one
// client and that client's fixed path, and its revision must match its hash.
function parseReceipt(content, name) {
  let value;
  try {
    value = JSON.parse(content.toString("utf8"));
  } catch {
    return null;
  }
  if (!isRecord(value, ["installations", "schema_version"])) return null;
  if (value.schema_version !== 1 || !Array.isArray(value.installations)) return null;
  const seen = new Set();
  for (const entry of value.installations) {
    if (!isRecord(entry, ENTRY_KEYS)) return null;
    if (typeof entry.client !== "string" || !Object.hasOwn(SKILL_CLIENTS, entry.client)) return null;
    if (seen.has(entry.client)) return null;
    seen.add(entry.client);
    if (entry.skill !== name || entry.path !== targetFor(entry.client, name).relative) return null;
    if (typeof entry.sha256 !== "string" || !/^[0-9a-f]{64}$/.test(entry.sha256)) return null;
    if (entry.revision !== revisionFor(entry.sha256)) return null;
    const { runtimes } = entry;
    if (!Array.isArray(runtimes) || runtimes.length === 0) return null;
    if (new Set(runtimes).size !== runtimes.length) return null;
    if (!runtimes.every((item) => SKILL_RUNTIMES.includes(item))) return null;
  }
  return value;
}

function isRecord(value, keys) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join() === keys.join()
  );
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Returns true when every directory exists, false at the first missing one.
// Anything else, including a symbolic link to a directory, is unsafe.
function checkDirs(root, dirs) {
  let current = root;
  for (const dir of dirs) {
    current = path.join(current, dir);
    const stat = lstatOrNull(current);
    if (stat === null) return false;
    if (!stat.isDirectory()) throw new Stop("conflict", "unsafe_path");
  }
  return true;
}

// Creates missing directories one level at a time and returns the ones it
// created, deepest last, so a rollback can remove exactly those.
function ensureDirs(root, dirs) {
  const created = [];
  let current = root;
  try {
    for (const dir of dirs) {
      current = path.join(current, dir);
      try {
        fs.mkdirSync(current);
        created.push(current);
      } catch (error) {
        if (error.code !== "EEXIST") throw error;
        if (!fs.lstatSync(current).isDirectory()) throw new Stop("conflict", "unsafe_path");
      }
    }
  } catch (error) {
    removeDirs(created);
    throw error;
  }
  return created;
}

function removeDirs(created) {
  for (const dir of [...created].reverse()) {
    try {
      fs.rmdirSync(dir);
    } catch {
      // Not empty or not removable. An empty directory is harmless.
    }
  }
}

// Returns { content, mode } for a regular file, { content: null, mode } when
// it is larger than maxBytes, or null when it does not exist.
function readRegular(file, maxBytes) {
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
    const mode = opened.mode & 0o777;
    if (opened.size > maxBytes) return { content: null, mode };
    return { content: fs.readFileSync(fd), mode };
  } finally {
    fs.closeSync(fd);
  }
}

// Writes content to an exclusive temporary file next to dest, then renames
// it into place. previous is what inspect saw at dest ({ content, mode } or
// null). Right before the rename, dest must still be exactly that, so a file
// created or edited by someone else in the meantime is never replaced. An
// existing file keeps its permission bits.
function replaceFile(dest, content, previous) {
  const temp = path.join(
    path.dirname(dest),
    `.${path.basename(dest)}.${randomBytes(6).toString("hex")}.tmp`,
  );
  const fd = fs.openSync(temp, "wx", previous === null ? 0o666 : 0o600);
  try {
    try {
      fs.writeFileSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (previous !== null) fs.chmodSync(temp, previous.mode);
    const now = readRegular(dest, MAX_SKILL_BYTES);
    const unchanged =
      previous === null ? now === null : now !== null && now.content !== null && now.content.equals(previous.content);
    if (!unchanged) throw new Stop("conflict", "changed_during_install");
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

function acquireLock(lockPath) {
  try {
    fs.closeSync(fs.openSync(lockPath, "wx"));
  } catch (error) {
    if (error.code === "EEXIST") throw new Stop("conflict", "locked");
    throw error;
  }
}

// Keeps SIGINT, SIGTERM and SIGHUP from killing the process while files are
// being replaced. The work inside is synchronous, so it always finishes or
// rolls back before the event loop could deliver a signal.
function deferSignals(work) {
  const signals = ["SIGINT", "SIGTERM", "SIGHUP"];
  const ignore = () => {};
  for (const signal of signals) process.on(signal, ignore);
  try {
    return work();
  } finally {
    for (const signal of signals) process.removeListener(signal, ignore);
  }
}

function nextAction({ client, runtime, target }) {
  const label = SKILL_CLIENTS[client].label;
  const message =
    runtime === "local"
      ? `Start or restart ${label} in this project, then confirm that it lists the metergraph skill.`
      : `Make sure the cloud checkout includes ${target.relative} (commit it if you installed it elsewhere), ` +
        `then start a new ${label} cloud session and confirm that it lists the metergraph skill.`;
  return { kind: "reload_client", message };
}

function data(context, { status = null, next = null } = {}) {
  const { bundle } = context;
  return {
    client: context.client,
    runtime: context.runtime,
    path: context.target?.relative ?? null,
    status,
    source: bundle ? { name: bundle.name, revision: bundle.revision, sha256: bundle.sha256 } : null,
    discovery: status === null ? null : "pending",
    authenticated: false,
    next_action: next,
  };
}

function success(context, status) {
  const label = SKILL_CLIENTS[context.client].label;
  const verb = { installed: "installed", updated: "updated", reused: "already installed" }[status];
  return {
    outcome: "ok",
    reason: null,
    message:
      `Skill ${verb}. Discovery is pending until ${label} loads it. ` +
      "This does not sign in, connect a workspace or configure MCP.",
    data: data(context, { status, next: nextAction(context) }),
  };
}

function handoff(context, reason) {
  return {
    outcome: "unsupported",
    reason,
    message: MESSAGES[reason],
    data: data(context, { next: { kind: "connection_guide", url: CONNECTION_GUIDE_URL } }),
  };
}

function failure(context, outcome, reason) {
  return { outcome, reason, message: MESSAGES[reason], data: data(context) };
}

// ---------------------------------------------------------------------------
// The workflow skill pack ("metergraph skills"). Each skill runs through the
// same engine as the setup skill, with its own receipt and lock in
// .metergraph/skills/, so one skill's conflict never blocks or rolls back
// another, and the setup skill's receipt is never touched.

const PACK_HANDOFF_MESSAGE =
  "In Claude Desktop, open Customize → Plugins → Add marketplace and enter metergraph/skills, " +
  "or upload a skill zip from https://github.com/metergraph/skills/releases/latest under Customize → Skills.";

function packReceipt(name) {
  return { dirs: PACK_RECEIPT_DIRS, file: `${name}.json`, lock: `${name}.lock` };
}

function packMessage(name, reason) {
  const receipt = `${PACK_RECEIPT_DIRS.join("/")}/${name}.json`;
  const lock = `${PACK_RECEIPT_DIRS.join("/")}/${name}.lock`;
  if (reason === "receipt_invalid") return `The receipt ${receipt} is not valid. Nothing was changed.`;
  if (reason === "locked") return `Another skill install may be running. If none is, delete ${lock} and retry.`;
  if (reason === "rollback_failed") {
    return `The skill could not be written and the rollback did not finish. Check the skill path and ${receipt}.`;
  }
  return MESSAGES[reason];
}

// Returns { outcome, reason, message, data } like runSkill. data.skills has
// one entry per bundled skill, in name order.
export function runSkillPack({ action, client, runtime, project }) {
  const base = { client, runtime, source: null, skills: [], discovery: null, authenticated: false, next_action: null };
  if (client === "claude-desktop") {
    return {
      outcome: "unsupported",
      reason: "client_not_supported",
      message:
        "Claude Desktop loads Metergraph skills from the plugin marketplace or an uploaded zip, not from project files. Nothing was written.",
      data: { ...base, next_action: { kind: "plugin_marketplace", message: PACK_HANDOFF_MESSAGE, url: SKILLS_REPOSITORY_URL } },
    };
  }
  if (!Object.hasOwn(SKILL_CLIENTS, client)) {
    return { outcome: "unsupported", reason: "client_not_supported", message: MESSAGES.client_not_supported,
      data: { ...base, next_action: { kind: "connection_guide", url: CONNECTION_GUIDE_URL } } };
  }
  if (!SKILL_RUNTIMES.includes(runtime)) {
    return { outcome: "unsupported", reason: "runtime_not_supported", message: MESSAGES.runtime_not_supported,
      data: { ...base, next_action: { kind: "connection_guide", url: CONNECTION_GUIDE_URL } } };
  }
  const pack = loadBundledPack();
  if (pack === null) {
    return { outcome: "internal_error", reason: "bundled_skill_invalid", message: MESSAGES.bundled_skill_invalid, data: base };
  }
  base.source = { repository: pack.repository, commit: pack.commit };
  let root;
  try {
    root = resolveProject(project);
  } catch (error) {
    return { outcome: error.outcome, reason: error.reason, message: MESSAGES[error.reason], data: base };
  }

  let failed = null;
  for (const bundle of pack.skills) {
    const context = {
      action,
      client,
      runtime,
      bundle,
      receipt: packReceipt(bundle.name),
      target: targetFor(client, bundle.name),
    };
    const entry = { name: bundle.name, path: context.target.relative, status: null, revision: bundle.revision, reason: null };
    try {
      try {
        entry.status = apply(root, context);
      } catch (error) {
        // A skill added to the pack since the last install is installed by update.
        if (!(error instanceof Stop) || error.reason !== "not_installed") throw error;
        entry.status = apply(root, { ...context, action: "install" });
      }
    } catch (error) {
      const stop = error instanceof Stop ? error : new Stop("filesystem_error", "write_failed");
      entry.status = "failed";
      entry.reason = stop.reason;
      failed ??= { outcome: stop.outcome, reason: stop.reason, message: packMessage(bundle.name, stop.reason) };
    }
    base.skills.push(entry);
  }

  const label = SKILL_CLIENTS[client].label;
  if (failed !== null) {
    return { ...failed, data: { ...base, discovery: "pending", next_action: null } };
  }
  const message =
    runtime === "local"
      ? `Start or restart ${label} in this project, then confirm that it lists the Metergraph skills.`
      : `Make sure the cloud checkout includes ${SKILL_CLIENTS[client].dir}/skills (commit it if you installed it elsewhere), ` +
        `then start a new ${label} cloud session and confirm that it lists the Metergraph skills.`;
  return {
    outcome: "ok",
    reason: null,
    message:
      `Skills ready. Discovery is pending until ${label} loads them. ` +
      "This does not sign in, connect a workspace or configure MCP.",
    data: { ...base, discovery: "pending", next_action: { kind: "reload_client", message } },
  };
}

// Read-only: what the pack bundles, and its state for every client in the
// project. Never writes, never takes a lock.
export function listSkillPack({ project }) {
  const pack = loadBundledPack();
  const data = { source: null, skills: [], clients: Object.keys(SKILL_CLIENTS) };
  if (pack === null) {
    return { outcome: "internal_error", reason: "bundled_skill_invalid", message: MESSAGES.bundled_skill_invalid, data };
  }
  data.source = { repository: pack.repository, commit: pack.commit };
  let root;
  try {
    root = resolveProject(project);
  } catch (error) {
    return { outcome: error.outcome, reason: error.reason, message: MESSAGES[error.reason], data };
  }
  for (const bundle of pack.skills) {
    const installs = {};
    for (const client of Object.keys(SKILL_CLIENTS)) {
      installs[client] = packState(root, { client, bundle, receipt: packReceipt(bundle.name), target: targetFor(client, bundle.name) });
    }
    data.skills.push({ name: bundle.name, revision: bundle.revision, sha256: bundle.sha256, installs });
  }
  return { outcome: "ok", reason: null, message: null, data };
}

// One of not_installed, installed, outdated, modified, missing, not_owned,
// receipt_invalid or unsafe_path.
function packState(root, context) {
  let state;
  try {
    state = inspect(root, context);
  } catch (error) {
    return error instanceof Stop && error.reason === "receipt_invalid" ? "receipt_invalid" : "unsafe_path";
  }
  const { entry, file, skillDirExists } = state;
  if (entry === null) return file !== null || skillDirExists ? "not_owned" : "not_installed";
  if (file === null) return "missing";
  if (file.content === null || sha256Hex(file.content) !== entry.sha256) return "modified";
  return entry.revision === context.bundle.revision ? "installed" : "outdated";
}
