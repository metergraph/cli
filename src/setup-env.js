import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";

import { resolveProject } from "./auth-binding.js";
import { Stop } from "./auth-store.js";
import { SKILL_CLIENTS } from "./constants.js";
import { aclStatus, protectFile, restoreAcl, saveAcl } from "./setup-env-acl.js";
import { appendRule, hasRule, ignoreRule, inspectGit, pathState } from "./setup-env-git.js";
import { ENV_NAMES, checkSerialized, isAppToken, parseEnv, parseIngestUrl, serializeEnv } from "./setup-env-parse.js";

export { ENV_NAMES, INGEST_PATHS, isAppToken, parseIngestUrl } from "./setup-env-parse.js";

// Private writer for the two Metergraph variables in a project env file:
// METERGRAPH_APP_TOKEN and METERGRAPH_INGEST_URL. It is an internal module
// for setup. Values come only from the caller (an authorized server
// response), never from arguments, the environment or stdin.
//
//   preflightEnv  resolves and reads the env file and checks Git and file
//                 protection, without writing anything
//   commitEnv     makes the file ignored and private, then upserts the
//                 values, under a project lock, or rolls everything back
//   rollbackEnv   undoes a commit only where the files are still exactly
//                 what the commit left
//
// The plan, receipt and rollback handle hold only public fields: a
// project-relative path, fixed status words and the two known variable
// names. Token values, file content, other variable names, absolute paths and
// raw errors stay inside this module, and every failure is a Stop with a
// fixed outcome and reason. currentEnvValues is the only way to read the
// existing values, for the caller to validate privately.

const IS_WINDOWS = process.platform === "win32";
const NOFOLLOW = fs.constants.O_NOFOLLOW ?? 0;
const EMPTY = Buffer.alloc(0);
export const MAX_ENV_BYTES = 256 * 1024;
export const PROTECTION_KIND = IS_WINDOWS ? "windows_acl" : "posix_mode";
const LOCK = ".metergraph-env.lock";
const DEFAULT_WAIT_MS = 2000;
const MAX_WAIT_MS = 30000;
const DENIED = new Set(["EACCES", "EPERM", "EROFS"]);

const ENV_REASONS = { unsafe: "env_path_unsafe", notOwned: "env_not_owned", tooLarge: "env_too_large" };
const IGNORE_REASONS = { unsafe: "ignore_path_unsafe", notOwned: "ignore_not_owned", tooLarge: "ignore_too_large" };

// Path rules for a project-relative env file. Forward slashes only. Any
// character that is unsafe in a Windows file name, a Git pathspec or an
// ignore pattern is refused rather than escaped, except [ ] ! # which the
// ignore rule escapes.
const BAD_CHARACTER = /[\x00-\x1f\x7f<>:"|?*\\]/;
const DEVICE_NAME = /^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\..*)?$/i;
const ENV_BASENAME = /^\.env(?:\..+)?$|^.+\.env$/i;
const TEMPLATE_BASENAME = /\.(?:example|sample|template|dist|defaults?)$/i;
const PROTECTED_DIRS = new Set([
  ".git",
  ".github",
  ".metergraph",
  ...Object.values(SKILL_CLIENTS).map((client) => client.dir),
]);

const PLANS = new WeakMap();
const HANDLES = new WeakMap();

export const ENV_MESSAGES = Object.freeze({
  invalid_project: "--project must name an existing directory.",
  env_path_invalid:
    "The env file path is not allowed. Use a project-relative path with forward slashes to a file named .env, .env.<name> or <name>.env.",
  env_path_outside_project: "The env file path is outside the project. Nothing was changed.",
  env_dir_missing: "The directory for the env file does not exist. Nothing was changed.",
  env_dir_unsafe: "The directory for the env file can be changed by other users. Nothing was changed.",
  env_path_unsafe:
    "The env file path is a symbolic link, a hard link or not a regular file. Nothing was changed.",
  env_not_owned: "The env file is owned by another user. Nothing was changed.",
  env_too_large: "The env file is larger than this CLI reads. Nothing was changed.",
  env_file_invalid: "The env file is not UTF-8 text. Nothing was changed.",
  env_syntax_ambiguous:
    "The env file has syntax this CLI cannot read without guessing. Edit it by hand. Nothing was changed.",
  env_duplicate_assignment:
    "The env file sets a Metergraph variable more than once. Keep one assignment and retry. Nothing was changed.",
  env_tracked:
    "The env file is tracked by Git. Remove it from the index yourself if that is intended, then retry. Nothing was changed.",
  ignore_path_unsafe: "The project .gitignore is a symbolic link or not a regular file. Nothing was changed.",
  ignore_not_owned: "The project .gitignore is owned by another user. Nothing was changed.",
  ignore_too_large: "The project .gitignore is larger than this CLI reads. Nothing was changed.",
  git_unavailable: "The project is in a Git repository but git could not be run. Nothing was changed.",
  git_check_failed: "Git could not confirm how the env file is ignored or tracked. Nothing was changed.",
  git_ignore_ineffective:
    "Another ignore rule keeps the env file from being ignored by Git. Changes were rolled back.",
  token_invalid: "The application token has an unexpected format. Nothing was written.",
  ingest_url_invalid: "The ingest URL is not a supported Metergraph ingest URL. Nothing was written.",
  env_changed: "The env file changed while setup was running. Changes were rolled back. Retry.",
  ignore_changed: "The project .gitignore changed while setup was running. Changes were rolled back. Retry.",
  env_locked: `Another setup may be running in this project. If none is, delete ${LOCK} and retry.`,
  cancelled: "Setup was cancelled before the env file was changed.",
  protection_failed:
    "The env file could not be made readable only by you. Changes were rolled back.",
  env_read_denied: "The env file or its directory could not be read. Nothing was changed.",
  env_read_failed: "The env file could not be read. Nothing was changed.",
  env_write_denied:
    "The env file could not be written: permission denied or a read-only file system. Changes were rolled back.",
  env_write_failed: "The env file could not be written. Changes were rolled back.",
  rollback_incomplete:
    "The env file could not be written and the rollback did not finish. Check the env file and .gitignore.",
  rollback_conflict:
    "A file changed after setup wrote it, so it was not rolled back. Your edit was kept.",
  invalid_plan: "Internal error: the env plan is not valid or was already used.",
});

// Returns a frozen plan with public fields only. Nothing is written.
export function preflightEnv({ project, envFile = ".env", allowOutsideProject = false, signal = null } = {}) {
  checkCancel(signal);
  let state;
  try {
    const root = resolveProject(project);
    const target = resolveTarget(root, envFile, allowOutsideProject);
    checkDirSafe(target.dir);
    const env = snapshot(target.file, ENV_REASONS);
    const parsed = parseEnv(env?.content ?? EMPTY);
    const protection = protectionState(target.file, env);
    let ignore = null;
    let git = null;
    if (target.location === "project") {
      checkDirSafe(root);
      const file = path.join(root, ".gitignore");
      ignore = { file, before: snapshot(file, IGNORE_REASONS), rule: ignoreRule(target.rel) };
      checkCancel(signal);
      git = inspectGit(root, target.rel);
    }
    state = { root, target, env, parsed, protection, ignore, git, used: false };
  } catch (error) {
    throw fixed(error, "env_read_failed");
  }
  const plan = freeze({
    path: state.target.rel,
    location: state.target.location,
    exists: state.env !== null,
    fields: currentFields(state.parsed),
    protection: { kind: PROTECTION_KIND, status: state.protection },
    git: plannedGit(state),
  });
  PLANS.set(plan, state);
  return plan;
}

// The existing raw values, or null when unset. For private validation by
// the caller only; never print, log or return them.
export function currentEnvValues(plan) {
  const { entries } = stateOf(plan).parsed;
  return {
    token: entries[ENV_NAMES.token]?.value ?? null,
    ingestUrl: entries[ENV_NAMES.ingestUrl]?.value ?? null,
  };
}

// Upserts the values given (either may be omitted) and returns
// { receipt, rollback }. A value equal to the current one leaves its line
// byte for byte. The file is made ignored and private even when no value
// changes. A plan can be committed once.
export async function commitEnv(plan, { token, ingestUrl, signal = null, waitMs = DEFAULT_WAIT_MS } = {}) {
  const state = stateOf(plan);
  const updates = {};
  if (token !== undefined) {
    if (!isAppToken(token)) throw new Stop("invalid_input", "token_invalid");
    updates[ENV_NAMES.token] = token;
  }
  if (ingestUrl !== undefined) {
    const url = parseIngestUrl(ingestUrl);
    if (url === null) throw new Stop("invalid_input", "ingest_url_invalid");
    updates[ENV_NAMES.ingestUrl] = url;
  }
  checkCancel(signal);
  state.used = true;
  PLANS.delete(plan);
  const lock = await takeLock(state.target.lockDir, waitMs, signal);
  try {
    checkCancel(signal);
    const { receipt, journal } = deferSignals(() => apply(state, updates));
    const rollback = Object.freeze({});
    HANDLES.set(rollback, { journal, lockDir: state.target.lockDir });
    return { receipt, rollback };
  } finally {
    dropLock(lock);
  }
}

// Undoes a commit. Each file is restored only while it is still exactly what
// the commit left; otherwise the run stops with rollback_conflict and keeps
// that file and every earlier change, including the ignore rule, so a
// changed env file never loses its protection. A stopped rollback can be
// retried once the conflict is resolved.
export async function rollbackEnv(handle, { signal = null, waitMs = DEFAULT_WAIT_MS } = {}) {
  const state = HANDLES.get(handle);
  if (state === undefined) throw new Stop("internal_error", "invalid_plan");
  checkCancel(signal);
  if (state.journal.length > 0) {
    const lock = await takeLock(state.lockDir, waitMs, signal);
    try {
      checkCancel(signal);
      deferSignals(() => {
        try {
          undo(state.journal);
        } catch (error) {
          if (error instanceof Stop && error.outcome === "conflict") throw new Stop("conflict", "rollback_conflict");
          throw new Stop("filesystem_error", "rollback_incomplete");
        }
      });
    } finally {
      dropLock(lock);
    }
  }
  HANDLES.delete(handle);
  return freeze({ status: "restored" });
}

function stateOf(plan) {
  const state = PLANS.get(plan);
  if (state === undefined || state.used) throw new Stop("internal_error", "invalid_plan");
  return state;
}

function resolveTarget(root, envFile, allowOutside) {
  if (typeof envFile !== "string" || envFile.length === 0 || envFile.length > 4096 || /[\x00-\x1f\x7f]/.test(envFile)) {
    throw new Stop("invalid_input", "env_path_invalid");
  }
  if (path.isAbsolute(envFile)) return resolveOutside(root, envFile, allowOutside);
  const segments = envFile.split("/");
  if (envFile.length > 1024 || PROTECTED_DIRS.has(segments[0].toLowerCase())) {
    throw new Stop("invalid_input", "env_path_invalid");
  }
  segments.forEach(checkSegment);
  const base = segments.at(-1);
  checkBasename(base);
  let dir = root;
  for (const segment of segments.slice(0, -1)) {
    dir = path.join(dir, segment);
    const stat = lstatOrNull(dir);
    if (stat === null) throw new Stop("invalid_input", "env_dir_missing");
    if (!stat.isDirectory()) throw new Stop("conflict", "env_path_unsafe");
  }
  return { location: "project", rel: envFile, dir, file: path.join(dir, base), lockDir: root };
}

// A private path outside the project, for example in the user's config
// directory, only when the caller allows it. Git checks do not apply there
// and are never claimed. An absolute path inside the project is refused so
// project files always go through the project-relative checks.
function resolveOutside(root, envFile, allowOutside) {
  if (!allowOutside) throw new Stop("invalid_input", "env_path_outside_project");
  const base = path.basename(envFile);
  checkSegment(base);
  checkBasename(base);
  let dir;
  try {
    dir = fs.realpathSync(path.dirname(envFile));
    if (!fs.statSync(dir).isDirectory()) throw new Error("not a directory");
  } catch {
    throw new Stop("invalid_input", "env_dir_missing");
  }
  const relative = path.relative(root, dir);
  const outside = relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
  if (!outside) throw new Stop("invalid_input", "env_path_invalid");
  return { location: "outside_project", rel: null, dir, file: path.join(dir, base), lockDir: dir };
}

function checkSegment(segment) {
  if (
    segment === "" ||
    segment === "." ||
    segment === ".." ||
    segment.toLowerCase() === ".git" ||
    BAD_CHARACTER.test(segment) ||
    /[ .]$/.test(segment) ||
    /~[0-9]/.test(segment) ||
    DEVICE_NAME.test(segment) ||
    Buffer.byteLength(segment, "utf8") > 255
  ) {
    throw new Stop("invalid_input", "env_path_invalid");
  }
}

function checkBasename(base) {
  if (!ENV_BASENAME.test(base) || TEMPLATE_BASENAME.test(base)) throw new Stop("invalid_input", "env_path_invalid");
}

// A directory any user can write without the sticky bit would let another
// user swap the env file between the checks and the write.
function checkDirSafe(dir) {
  if (IS_WINDOWS) return;
  const { mode } = fs.statSync(dir);
  if ((mode & 0o002) !== 0 && (mode & 0o1000) === 0) throw new Stop("conflict", "env_dir_unsafe");
}

function protectionState(file, env) {
  if (env === null) return "will_create_private";
  if (IS_WINDOWS) return aclStatus(file) === "private" ? "private" : "needs_protection";
  return (env.mode & 0o077) === 0 ? "private" : "needs_tightening";
}

function currentFields(parsed) {
  const token = parsed.entries[ENV_NAMES.token];
  const url = parsed.entries[ENV_NAMES.ingestUrl];
  return {
    [ENV_NAMES.token]: token === undefined ? "absent" : isAppToken(token.value) ? "present" : "invalid",
    [ENV_NAMES.ingestUrl]: url === undefined ? "absent" : parseIngestUrl(url.value) === url.value ? "present" : "invalid",
  };
}

function plannedGit({ target, git, ignore }) {
  if (target.location !== "project") return { status: "outside_project", ignore_rule: null, verified: false };
  if (!git.repository) {
    const present = hasRule(ignore.before?.content ?? EMPTY, ignore.rule);
    return { status: "not_applicable", ignore_rule: present ? "present" : "needed", verified: false };
  }
  return git.ignored
    ? { status: "ignored", ignore_rule: "not_needed", verified: true }
    : { status: "needs_ignore_rule", ignore_rule: "needed", verified: false };
}

// Runs under the lock with signals deferred. Order: recheck both files,
// make the path ignored, write the env file privately, verify everything
// again. Any failure undoes the journal in reverse.
function apply(state, updates) {
  const { target, ignore } = state;
  const journal = [];
  try {
    expectUnchanged(target.file, state.env, ENV_REASONS, "env_changed");
    if (ignore !== null) expectUnchanged(ignore.file, ignore.before, IGNORE_REASONS, "ignore_changed");
    const content = serializeEnv(state.parsed, updates);
    checkSerialized(content, updates, state.parsed);
    const write = state.env === null ? Object.keys(updates).length > 0 : !content.equals(state.env.content);
    const present = state.env !== null || write;

    let git = plannedGit(state);
    if (ignore !== null && present) git = ensureIgnored(state, journal);

    let protection = "not_created";
    if (write) protection = writeEnv(state, content, journal);
    else if (present) protection = ensurePrivate(state, journal);

    // Everything again, with all changes in place.
    if (present) {
      const now = snapshot(target.file, ENV_REASONS);
      const expected = journal.findLast((entry) => entry.env)?.after ?? state.env;
      if (!same(expected, now)) throw new Stop("conflict", "env_changed");
      checkPrivate(target.file, now);
    }
    if (ignore !== null && present) {
      const expected = journal.find((entry) => !entry.env)?.after ?? ignore.before;
      expectUnchanged(ignore.file, expected, IGNORE_REASONS, "ignore_changed");
      if (git.verified && !pathState(state.root, target.rel).ignored) {
        throw new Stop("conflict", "git_ignore_ineffective");
      }
    }

    const receipt = freeze({
      path: target.rel,
      location: target.location,
      file: write ? (state.env === null ? "created" : "updated") : state.env === null ? "absent" : "unchanged",
      fields: fieldResults(state.parsed, updates),
      protection: { kind: PROTECTION_KIND, status: protection },
      git,
    });
    return { receipt, journal };
  } catch (error) {
    try {
      undo(journal);
    } catch {
      throw new Stop("filesystem_error", "rollback_incomplete");
    }
    throw fixed(error, "env_write_failed");
  }
}

// Inside a repository: refuse a tracked path, add the anchored rule only when
// Git does not already ignore the path, then require Git to confirm it.
// Without a repository: make sure the project .gitignore holds the rule, and
// report that Git verification does not apply.
function ensureIgnored(state, journal) {
  const { root, target, ignore } = state;
  const git = inspectGit(root, target.rel);
  const before = ignore.before?.content ?? EMPTY;
  if (git.repository && git.ignored) return { status: "ignored", ignore_rule: "not_needed", verified: true };
  if (!git.repository && hasRule(before, ignore.rule)) {
    return { status: "not_applicable", ignore_rule: "present", verified: false };
  }
  const content = appendRule(before, ignore.rule);
  replaceFile(ignore.file, content, {
    before: ignore.before,
    mode: ignore.before?.mode ?? null,
    protect: false,
    reasons: IGNORE_REASONS,
    changed: "ignore_changed",
  });
  const after = snapshot(ignore.file, IGNORE_REASONS);
  journal.push({ env: false, kind: "replace", file: ignore.file, reasons: IGNORE_REASONS, before: ignore.before, after, acl: null });
  if (after === null || !after.content.equals(content)) throw new Stop("conflict", "ignore_changed");
  if (!git.repository) return { status: "not_applicable", ignore_rule: "added", verified: false };
  if (!pathState(root, target.rel).ignored) throw new Stop("conflict", "git_ignore_ineffective");
  return { status: "ignored", ignore_rule: "added", verified: true };
}

function writeEnv(state, content, journal) {
  const { target, env } = state;
  const keep = env !== null && state.protection === "private";
  const acl = IS_WINDOWS && env !== null ? saveAcl(target.file) : null;
  replaceFile(target.file, content, {
    before: env,
    mode: IS_WINDOWS ? null : keep ? env.mode : 0o600,
    protect: IS_WINDOWS,
    reasons: ENV_REASONS,
    changed: "env_changed",
  });
  const after = snapshot(target.file, ENV_REASONS);
  journal.push({ env: true, kind: "replace", file: target.file, reasons: ENV_REASONS, before: env, after, acl });
  if (after === null || !after.content.equals(content)) throw new Stop("conflict", "env_changed");
  checkPrivate(target.file, after);
  if (env === null) return "created_private";
  if (keep) return "already_private";
  return IS_WINDOWS ? "protected" : "tightened";
}

// Content is unchanged: only make an existing file private if it is not.
function ensurePrivate(state, journal) {
  const { target, env } = state;
  if (state.protection === "private") return "already_private";
  const entry = { env: true, kind: "mode", file: target.file, reasons: ENV_REASONS, before: env, acl: null };
  if (IS_WINDOWS) {
    // Windows snapshots compare content only, so the entry is valid as soon
    // as the old ACL is saved, even if protecting the file then fails.
    entry.acl = saveAcl(target.file);
    journal.push({ ...entry, after: env });
    protectFile(target.file);
    return "protected";
  }
  setMode(target.file, 0o600);
  journal.push({ ...entry, after: { content: env.content, mode: 0o600 } });
  return "tightened";
}

function checkPrivate(file, stat) {
  const ok = IS_WINDOWS ? aclStatus(file) === "private" : stat !== null && (stat.mode & 0o077) === 0;
  if (!ok) throw new Stop("filesystem_error", "protection_failed");
}

// Reverts entries newest first, removing each one once it is reverted, so a
// stopped rollback can tell exactly what is left.
function undo(journal) {
  while (journal.length > 0) {
    const entry = journal.at(-1);
    expectUnchanged(entry.file, entry.after, entry.reasons, "rollback_conflict");
    if (entry.kind === "mode") {
      if (IS_WINDOWS) restoreAcl(entry.file, entry.acl);
      else setMode(entry.file, entry.before.mode);
    } else if (entry.before === null) {
      fs.unlinkSync(entry.file);
    } else {
      replaceFile(entry.file, entry.before.content, {
        before: entry.after,
        mode: IS_WINDOWS ? null : entry.before.mode,
        protect: IS_WINDOWS && entry.env,
        reasons: entry.reasons,
        changed: "rollback_conflict",
      });
      if (entry.acl !== null) restoreAcl(entry.file, entry.acl);
    }
    journal.pop();
  }
}

function fieldResults(parsed, updates) {
  const result = {};
  for (const name of Object.values(ENV_NAMES)) {
    const entry = parsed.entries[name];
    if (!Object.hasOwn(updates, name)) result[name] = entry === undefined ? "absent" : "unchanged";
    else if (entry === undefined) result[name] = "added";
    else result[name] = entry.value === updates[name] ? "unchanged" : "updated";
  }
  return result;
}

function lstatOrNull(file) {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if (error.code === "ENOENT") return null;
    throw error;
  }
}

// Returns { content, mode } for an owned regular file, or null when there is
// none. Symbolic links, hard links and other entries are refused.
function snapshot(file, reasons) {
  const stat = lstatOrNull(file);
  if (stat === null) return null;
  if (!stat.isFile() || stat.nlink > 1) throw new Stop("conflict", reasons.unsafe);
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  } catch (error) {
    if (error.code === "ELOOP") throw new Stop("conflict", reasons.unsafe);
    if (error.code === "ENOENT") return null;
    throw error;
  }
  try {
    const opened = fs.fstatSync(fd);
    const moved = !IS_WINDOWS && (opened.ino !== stat.ino || opened.dev !== stat.dev);
    if (!opened.isFile() || opened.nlink > 1 || moved) throw new Stop("conflict", reasons.unsafe);
    if (!IS_WINDOWS && typeof process.getuid === "function" && opened.uid !== process.getuid()) {
      throw new Stop("conflict", reasons.notOwned);
    }
    if (opened.size > MAX_ENV_BYTES) throw new Stop("conflict", reasons.tooLarge);
    const content = fs.readFileSync(fd);
    if (content.length > MAX_ENV_BYTES) throw new Stop("conflict", reasons.tooLarge);
    return { content, mode: opened.mode & 0o777 };
  } finally {
    fs.closeSync(fd);
  }
}

function same(expected, now) {
  if (expected === null || now === null) return expected === now;
  return now.content.equals(expected.content) && (IS_WINDOWS || now.mode === expected.mode);
}

function expectUnchanged(file, expected, reasons, reason) {
  if (!same(expected, snapshot(file, reasons))) throw new Stop("conflict", reason);
}

function setMode(file, mode) {
  const fd = fs.openSync(file, fs.constants.O_RDONLY | NOFOLLOW);
  try {
    if (!fs.fstatSync(fd).isFile()) throw new Stop("conflict", "env_path_unsafe");
    fs.fchmodSync(fd, mode);
  } finally {
    fs.closeSync(fd);
  }
}

// Writes an exclusive temporary file next to file and renames it into
// place. With protect, the temporary file gets the private Windows ACL
// before any content is written. On POSIX it is created with mode (or the
// umask default when mode is null). Right before the rename, file must still
// match before, so a concurrent edit is never replaced. The temporary file
// is removed on any failure.
function replaceFile(file, content, { before, mode, protect, reasons, changed }) {
  const dir = path.dirname(file);
  const temp = path.join(dir, `.metergraph-${randomBytes(6).toString("hex")}.tmp`);
  let created = false;
  try {
    if (protect) {
      fs.closeSync(fs.openSync(temp, "wx"));
      created = true;
      protectFile(temp);
      const fd = fs.openSync(temp, "r+");
      try {
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } else {
      const fd = fs.openSync(temp, "wx", mode ?? 0o666);
      created = true;
      try {
        if (mode !== null && !IS_WINDOWS) fs.fchmodSync(fd, mode);
        fs.writeFileSync(fd, content);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    }
    expectUnchanged(file, before, reasons, changed);
    fs.renameSync(temp, file);
    created = false;
  } catch (error) {
    if (created) {
      try {
        fs.unlinkSync(temp);
      } catch {
        // Reported by the caller's failure; nothing else to do.
      }
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

// An exclusive lock file in the project (or, outside a project, in the env
// file's directory). A held lock is waited on for at most waitMs, then
// reported; it is never taken over or removed, even if it looks stale.
async function takeLock(dir, waitMs, signal) {
  const file = path.join(dir, LOCK);
  const wait = Number.isFinite(waitMs) ? Math.min(Math.max(waitMs, 0), MAX_WAIT_MS) : DEFAULT_WAIT_MS;
  const until = Date.now() + wait;
  for (;;) {
    checkCancel(signal);
    let fd;
    try {
      fd = fs.openSync(file, "wx", 0o600);
    } catch (error) {
      if (error.code !== "EEXIST") throw fixed(error, "env_write_failed");
      if (Date.now() >= until) throw new Stop("conflict", "env_locked");
      await pause(50, signal);
      continue;
    }
    try {
      const stat = fs.fstatSync(fd);
      return { file, dev: stat.dev, ino: stat.ino };
    } finally {
      fs.closeSync(fd);
    }
  }
}

// Removes the lock only if it is still the file this process created.
function dropLock(lock) {
  try {
    const stat = fs.lstatSync(lock.file);
    if (IS_WINDOWS || (stat.dev === lock.dev && stat.ino === lock.ino)) fs.unlinkSync(lock.file);
  } catch {
    // Reported by the next run as a held lock.
  }
}

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

function checkCancel(signal) {
  if (signal?.aborted) throw new Stop("cancelled", "cancelled");
}

// Keeps SIGINT, SIGTERM and SIGHUP from killing the process while files are
// being replaced. The work inside is synchronous, so it finishes or rolls
// back before a signal could be handled. A hard kill cannot be deferred.
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

// Every failure leaves this module as a Stop with a fixed reason. A raw
// error, which can hold a path, is never passed on.
function fixed(error, reason) {
  if (error instanceof Stop) return error;
  if (DENIED.has(error?.code)) {
    return new Stop("filesystem_error", reason === "env_read_failed" ? "env_read_denied" : "env_write_denied");
  }
  return new Stop("filesystem_error", reason);
}

function freeze(value) {
  if (value !== null && typeof value === "object") {
    for (const item of Object.values(value)) freeze(item);
    Object.freeze(value);
  }
  return value;
}
