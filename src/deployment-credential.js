import fs from "node:fs";
import path from "node:path";

// Reads the separate Metadata agent credential for deployment verification
// from one explicit, absolute, private file. There is no argv, stdin or
// environment variable form. The file is read, never copied, written or
// persisted, and the token is returned only to the verifier that asked for
// it. Results are { ok: true, token } or { ok: false, outcome, reason } with
// fixed tokens: no path, file content or system error text is ever returned.
//
// The file must be a regular file owned by the current user with mode 0600
// and exactly one link, holding one bearer token and at most one trailing
// newline. No component of the path may be a symbolic link, so callers pass
// the canonical path (on macOS, /private/var/... rather than /var/...). The
// directory holding the file must be owned by the current user or root and
// must not be writable by group or others. Higher directories may be writable
// by others only when the sticky bit is set, which is how shared temporary
// directories such as /tmp are protected; the file's own directory gets no
// such allowance.
//
// Windows has no owner-only mode bits to check, and this CLI has no proof of
// a file's ACL, so the read fails closed there with a platform handoff.

const MAX_PATH_LENGTH = 4096;
// No token is shorter than this, so a fixed string that is shorter can never
// contain one.
export const CREDENTIAL_MIN_LENGTH = 16;
const TOKEN = new RegExp(`^[\\x21-\\x7e]{${CREDENTIAL_MIN_LENGTH},8192}$`);
// The longest token plus a CRLF line ending.
export const CREDENTIAL_MAX_BYTES = 8192 + 2;

const OPEN_FLAGS =
  fs.constants.O_RDONLY |
  (fs.constants.O_NOFOLLOW ?? 0) |
  // A FIFO opened without O_NONBLOCK blocks until a writer appears.
  (fs.constants.O_NONBLOCK ?? 0) |
  (fs.constants.O_NOCTTY ?? 0);

const fail = (reason) => ({ ok: false, outcome: "filesystem_error", reason });

// options.afterOpen and options.afterRead are test seams only: afterOpen runs
// after the file is opened and before it is checked, afterRead after the
// content is read and before it is checked again, so a test can replace,
// rewrite or chmod the file in between.
export function readCredentialFile(file, { platform = process.platform, afterOpen = null, afterRead = null } = {}) {
  if (platform === "win32") return { ok: false, outcome: "unsupported", reason: "platform_credential_handoff" };
  if (!validPath(file)) return fail("credential_path_invalid");
  const uid = process.getuid();

  const parents = checkParents(file, uid);
  if (!parents.ok) return parents;

  let before;
  try {
    before = fs.lstatSync(file, { bigint: true });
  } catch (error) {
    return fail(error?.code === "ENOENT" ? "credential_missing" : "credential_unreadable");
  }
  if (before.isSymbolicLink()) return fail("credential_symlink");
  const problem = credentialStatProblem(before, uid);
  if (problem !== null) return fail(problem);

  let fd;
  try {
    fd = fs.openSync(file, OPEN_FLAGS);
  } catch (error) {
    if (error?.code === "ELOOP") return fail("credential_symlink");
    return fail(error?.code === "ENOENT" ? "credential_changed" : "credential_unreadable");
  }
  let buffer = null;
  try {
    if (afterOpen !== null) afterOpen();
    const opened = fs.fstatSync(fd, { bigint: true });
    // No links left means the name was moved away or replaced after the open.
    if (opened.nlink === 0n) return fail("credential_changed");
    const openedProblem = credentialStatProblem(opened, uid);
    if (openedProblem !== null) return fail(openedProblem);
    if (!sameInode(opened, before)) return fail("credential_changed");

    buffer = Buffer.alloc(CREDENTIAL_MAX_BYTES + 1);
    let length = 0;
    while (length < buffer.length) {
      const count = fs.readSync(fd, buffer, length, buffer.length - length, length);
      if (count === 0) break;
      length += count;
    }
    if (length > CREDENTIAL_MAX_BYTES) return fail("credential_too_large");
    if (afterRead !== null) afterRead();

    // After the read the file must still pass every check and be the same
    // file with the same metadata. Rewriting it in place, even with content
    // of the same length, or changing its mode, owner or links moves ctime or
    // mtime, which are compared to the nanosecond.
    const after = fs.fstatSync(fd, { bigint: true });
    if (after.nlink === 0n) return fail("credential_changed");
    const afterProblem = credentialStatProblem(after, uid);
    if (afterProblem !== null) return fail(afterProblem);
    if (!unchanged(after, opened) || after.size !== BigInt(length)) return fail("credential_changed");
    let current;
    try {
      current = fs.lstatSync(file, { bigint: true });
    } catch {
      return fail("credential_changed");
    }
    if (!unchanged(current, opened)) return fail("credential_changed");
    // Every directory above it must still be the ones checked.
    const again = checkParents(file, uid);
    if (!again.ok) return again;
    if (again.inodes.some((inode, index) => !sameInode(inode, parents.inodes[index]))) {
      return fail("credential_changed");
    }

    return parseToken(buffer.subarray(0, length));
  } catch {
    return fail("credential_unreadable");
  } finally {
    if (buffer !== null) buffer.fill(0);
    fs.closeSync(fd);
  }
}

// Returns a fixed reason when a stat of the credential file is not a private,
// owner-only, singly linked regular file of a usable size, otherwise null.
// Accepts number or bigint stats. Exported for tests that cannot create files
// owned by another user.
export function credentialStatProblem(stat, uid) {
  if (!stat.isFile()) return "credential_not_regular";
  if (Number(stat.uid) !== uid) return "credential_not_owner";
  if ((Number(stat.mode) & 0o7777) !== 0o600) return "credential_permissions_unsafe";
  if (Number(stat.nlink) !== 1) return "credential_hardlinked";
  if (Number(stat.size) === 0) return "credential_empty";
  if (Number(stat.size) > CREDENTIAL_MAX_BYTES) return "credential_too_large";
  return null;
}

function validPath(file) {
  return (
    typeof file === "string" &&
    file.length > 1 &&
    file.length <= MAX_PATH_LENGTH &&
    !file.includes("\0") &&
    path.isAbsolute(file) &&
    path.normalize(file) === file &&
    !file.endsWith(path.sep)
  );
}

// Checks every directory from the root down to the file's own directory.
// Returns { ok: true, inodes } so a second walk can prove nothing moved.
function checkParents(file, uid) {
  const directories = [];
  for (let dir = path.dirname(file); ; dir = path.dirname(dir)) {
    directories.unshift(dir);
    if (path.dirname(dir) === dir) break;
  }
  const inodes = [];
  for (const [index, dir] of directories.entries()) {
    let stat;
    try {
      stat = fs.lstatSync(dir);
    } catch (error) {
      return fail(error?.code === "ENOENT" ? "credential_missing" : "credential_unreadable");
    }
    if (stat.isSymbolicLink()) return fail("credential_path_symlink");
    if (!stat.isDirectory()) return fail("credential_path_invalid");
    if (stat.uid !== uid && stat.uid !== 0) return fail("credential_parent_unsafe");
    const shared = (stat.mode & 0o022) !== 0;
    const own = index === directories.length - 1;
    if (shared && (own || (stat.mode & 0o1000) === 0)) return fail("credential_parent_unsafe");
    inodes.push(stat);
  }
  return { ok: true, inodes };
}

function sameInode(a, b) {
  return a.dev === b.dev && a.ino === b.ino;
}

// The same file with the same owner, mode, links, size and change times.
// Both are bigint stats, so times compare to the nanosecond.
function unchanged(a, b) {
  return (
    sameInode(a, b) &&
    a.uid === b.uid &&
    a.mode === b.mode &&
    a.nlink === b.nlink &&
    a.size === b.size &&
    a.mtimeNs === b.mtimeNs &&
    a.ctimeNs === b.ctimeNs
  );
}

function parseToken(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return fail("credential_malformed");
  }
  if (text.endsWith("\r\n")) text = text.slice(0, -2);
  else if (text.endsWith("\n")) text = text.slice(0, -1);
  if (text.length === 0) return fail("credential_empty");
  // One token only: any whitespace means a second token, a label such as
  // "Bearer" or a second line.
  if (!TOKEN.test(text)) return fail("credential_malformed");
  return { ok: true, token: text };
}
