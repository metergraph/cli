import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";

// A process-local directory capability service. The shipped helper owns all
// descriptors; only its inherited anonymous pipes carry requests and contents.
// An absent or unverified backend is an error, never a pathname-write fallback.
const MAX = 2 * 1024 * 1024;
const base = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../native");
const errnoNames = new Map(Object.entries(os.constants.errno).map(([name, number]) => [number, name]));
let service = null;
let rollbackDepth = 0;
const aliases = new Map(process.platform === "darwin" ? [["/var", "/private/var"], ["/tmp", "/private/tmp"]] : []);
function failure(code) { const error = new Error(`Secure filesystem operation failed (${code}).`); error.code = code; return error; }
function verifiedHelper() {
  const name = `anchored-fs-${process.platform}-${process.arch}`;
  let file;
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(base, "manifest.json"), "utf8"));
    file = path.join(base, "bin", name);
    const bytes = fs.readFileSync(file);
    if (manifest.schema !== 1 || typeof manifest.artifacts[name] !== "string" ||
        createHash("sha256").update(bytes).digest("hex") !== manifest.artifacts[name]) throw failure("ENOTSUP");
  } catch { throw failure("ENOTSUP"); }
  return file;
}
// Test and diagnostic capability discovery verifies the same packaged bytes as
// start(). It never enables a platform merely because its name is recognised.
export function hasVerifiedHelper() {
  try { verifiedHelper(); return true; } catch { return false; }
}
function start() {
  if (service !== null) return service;
  const file = verifiedHelper();
  const child = spawn(file, [], { stdio: ["pipe", "pipe", "ignore"], windowsHide: true, env: {} });
  child.on("error", () => { /* synchronous pipe operations report backend loss */ });
  const input = child.stdin?._handle;
  const output = child.stdout?._handle;
  if (!input || !output || typeof input.setBlocking !== "function" || typeof output.setBlocking !== "function") {
    child.kill("SIGKILL"); throw failure("ENOTSUP");
  }
  input.setBlocking(true); output.setBlocking(true);
  service = { child, input: input.fd, output: output.fd };
  child.unref(); child.stdin.unref(); child.stdout.unref();
  return service;
}
function writeAll(fd, bytes) { let offset = 0; while (offset < bytes.length) { const count = fs.writeSync(fd, bytes, offset, bytes.length - offset); if (count === 0) throw failure("EIO"); offset += count; } }
function readAll(fd, bytes) { let offset = 0; while (offset < bytes.length) { const count = fs.readSync(fd, bytes, offset, bytes.length - offset, null); if (count === 0) throw failure("EIO"); offset += count; } }
function request(operation, args = [], payload = Buffer.alloc(0)) {
  const encoded = args.map(value => Buffer.from(String(value)));
  if (encoded.some(value => value.includes(0))) throw failure("EINVAL");
  const size = 2 + encoded.reduce((n, value) => n + 4 + value.length, 0) + payload.length;
  if (size > MAX) throw failure("EFBIG");
  const body = Buffer.alloc(4 + size); body.writeUInt32BE(size); body[4] = operation; body[5] = args.length;
  let offset = 6;
  for (const value of encoded) { body.writeUInt32BE(value.length, offset); offset += 4; value.copy(body, offset); offset += value.length; }
  payload.copy(body, offset);
  const pipe = start(); writeAll(pipe.input, body);
  const header = Buffer.alloc(8); readAll(pipe.output, header);
  const error = header.readUInt32BE(); const length = header.readUInt32BE(4);
  if (length > MAX) throw failure("EIO");
  const result = Buffer.alloc(length); readAll(pipe.output, result);
  if (error) throw failure(errnoNames.get(error) ?? "EIO");
  return result;
}
function canonical(value) {
  if (typeof value !== "string" || value.includes("\0")) throw failure("EINVAL");
  let absolute = path.resolve(value);
  const choices = [...aliases].sort((a,b) => b[0].length - a[0].length);
  for (const [alias, target] of choices) if (absolute === alias || absolute.startsWith(`${alias}/`)) { absolute = target + absolute.slice(alias.length); break; }
  return absolute;
}
function descriptor(value) { if (!Number.isSafeInteger(value) || value > -1001) throw failure("EBADF"); return -value - 1001; }
function statResult(bytes, options) {
  const keys = ["dev", "ino", "mode", "nlink", "uid", "gid", "size", "mtimeMs"];
  const result = {};
  keys.forEach((key, index) => { let n = bytes.readBigUInt64BE(index*8); if (key === "mtimeMs") n *= 1000n; result[key] = options?.bigint ? n : Number(n); });
  const mode = Number(result.mode) & 0o170000;
  return Object.assign(result, { isFile: () => mode === 0o100000, isDirectory: () => mode === 0o040000,
    isSymbolicLink: () => mode === 0o120000, isFIFO: () => mode === 0o010000,
    isSocket: () => mode === 0o140000, isBlockDevice: () => mode === 0o060000, isCharacterDevice: () => mode === 0o020000 });
}
export function validatePath(value) { request(13, [canonical(value)]); return true; }
export function withRollback(callback) {
  if (rollbackDepth++ === 0) request(14, [1]);
  try { return callback(); } finally { if (--rollbackDepth === 0) request(14, [0]); }
}
export function closeAnchoredFs() {
  if (service !== null) { service.child.stdin.destroy(); service.child.stdout.destroy(); service.child.kill("SIGKILL"); service = null; }
}
const anchored = {
  constants: fs.constants,
  lstatSync(value, options) { return statResult(request(1, [canonical(value)]), options); },
  statSync(value, options) { const result = this.lstatSync(value, options); if (result.isSymbolicLink()) throw failure("ELOOP"); return result; },
  realpathSync(value) {
    // Root selection is read-only. Pin the resolved identity immediately; every
    // subsequent operation uses the helper's retained directory descriptors.
    const absolute = path.resolve(value); const real = fs.realpathSync(absolute);
    const prior = aliases.get(absolute);
    if (prior !== undefined && prior !== real) throw failure("ESTALE");
    // Freeze both the selected spelling and the capability spelling. A later
    // root resolution cannot rebind an existing capability to another tree.
    const pinned = aliases.get(real);
    if (pinned !== undefined && pinned !== real) throw failure("ESTALE");
    validatePath(real); aliases.set(real, real); aliases.set(absolute, real); return real;
  },
  existsSync(value) { try { this.lstatSync(value); return true; } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; } },
  openSync(value, flags, mode = 0o666) {
    let kind;
    const extras = (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
    const stripped = typeof flags === "number" ? flags & ~extras : flags;
    if (flags === "r" || stripped === fs.constants.O_RDONLY) kind = 0;
    else if (flags === "r+" || stripped === fs.constants.O_RDWR) kind = 1;
    else if (flags === "wx" || flags === "wx+" || stripped === (fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL)) kind = 2;
    else throw failure("ENOTSUP");
    return -1001 - request(2, [canonical(value), kind, mode]).readUInt32BE();
  },
  fstatSync(fd, options) { return statResult(request(3, [descriptor(fd)]), options); },
  readFileSync(value, options) {
    const own = typeof value !== "number"; const fd = own ? this.openSync(value, "r") : value;
    try { const bytes = request(4, [descriptor(fd)]); const encoding = typeof options === "string" ? options : options?.encoding; return encoding ? bytes.toString(encoding) : bytes; }
    finally { if (own) this.closeSync(fd); }
  },
  readSync(fd, buffer, offset, length, position) {
    const bytes = request(16, [descriptor(fd), length, position ?? 0]); bytes.copy(buffer, offset); return bytes.length;
  },
  writeFileSync(fd, value, options) {
    if (typeof fd !== "number") throw failure("ENOTSUP");
    const encoding = typeof options === "string" ? options : options?.encoding;
    request(5, [descriptor(fd)], Buffer.isBuffer(value) ? value : Buffer.from(value, encoding));
  },
  fchmodSync(fd, mode) { request(6, [descriptor(fd), mode]); },
  chmodSync(value, mode) { const fd = this.openSync(value, "r"); try { this.fchmodSync(fd, mode); } finally { this.closeSync(fd); } },
  fsyncSync(fd) { request(7, [descriptor(fd)]); },
  closeSync(fd) { request(8, [descriptor(fd)]); },
  mkdirSync(value, options = {}) {
    const absolute = canonical(value); const mode = typeof options === "number" ? options : options.mode ?? 0o777;
    try { request(9, [absolute, mode]); }
    catch (error) {
      if (!options.recursive) throw error;
      if (error.code === "ENOENT") { this.mkdirSync(path.dirname(absolute), {recursive:true, mode}); request(9, [absolute, mode]); }
      else if (error.code !== "EEXIST" || !this.statSync(absolute).isDirectory()) throw error;
    }
  },
  renameSync(from, to) { request(10, [canonical(from), canonical(to)]); },
  unlinkSync(value) { request(11, [canonical(value)]); },
  rmdirSync(value) { request(12, [canonical(value)]); },
  linkSync(from, to) { request(15, [canonical(from), canonical(to)]); },
};
export default anchored;
