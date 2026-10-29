import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { VERSION } from "./constants.js";
import { createStyle } from "./style.js";

export const UPDATE_TTL_MS = 24 * 60 * 60 * 1000;
const WORKER = fileURLToPath(import.meta.url);
const TAGS_URL = "https://registry.npmjs.org/-/package/metergraph-cli/dist-tags";
const STABLE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

// Only stable versions from npm's latest tag can appear in terminal output.
function stableParts(version) {
  if (typeof version !== "string" || version.length > 64 || !STABLE.test(version)) return null;
  const parts = version.split(".").map(Number);
  return parts.every(Number.isSafeInteger) ? parts : null;
}

export function isNewer(latest, current) {
  const target = stableParts(latest);
  const match = typeof current === "string" && current.match(/^(\d+\.\d+\.\d+)(-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/);
  const installed = match && stableParts(match[1]);
  if (!target || !installed) return false;
  for (let i = 0; i < 3; i++) {
    if (target[i] !== installed[i]) return target[i] > installed[i];
  }
  return Boolean(match[2]);
}

export function updateCacheDir(env = process.env) {
  if (process.platform === "win32") {
    const base = env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA) ? env.LOCALAPPDATA : path.join(os.homedir(), "AppData", "Local");
    return path.join(base, "Metergraph", "Cache");
  }
  const base = env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : path.join(os.homedir(), ".cache");
  return path.join(base, "metergraph");
}

function readCache(dir) {
  let fd;
  try {
    fd = fs.openSync(path.join(dir, "update.json"), fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > 4096) return null;
    const data = JSON.parse(fs.readFileSync(fd, "utf8"));
    if (!Number.isSafeInteger(data.checked_at) || data.checked_at < 0) return null;
    if (data.latest !== null && !stableParts(data.latest)) return null;
    return data;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function fresh(cache, now) {
  return cache && cache.checked_at <= now && now - cache.checked_at < UPDATE_TTL_MS;
}

function startRefresh() {
  const child = spawn(process.execPath, [WORKER], { detached: true, stdio: "ignore", windowsHide: true });
  child.on("error", () => {});
  child.unref();
}

// The foreground only reads a tiny cache. A detached worker does all network
// work; the first successful refresh can produce a notice on the next run.
export function maybeUpdateNotice({ command, json, stdout, stderr }, {
  env = process.env, current = VERSION, now = Date.now(), dir = updateCacheDir(env), refresh = startRefresh,
} = {}) {
  try {
    if (!["help", "version"].includes(command) || json || !stdout?.isTTY || !stderr?.isTTY
      || env.METERGRAPH_NO_UPDATE_CHECK || (env.CI && !["0", "false"].includes(env.CI.toLowerCase()))) return;
    const cache = readCache(dir);
    if (!fresh(cache, now)) {
      refresh();
      return;
    }
    if (isNewer(cache.latest, current)) {
      const style = createStyle(stderr, env);
      stderr.write(`\n${style.cyan(`Update available: ${current} → ${cache.latest}`)}\nRun npm install -g metergraph-cli@latest\n`);
    }
  } catch {
    // Optional presentation must never change the command result.
  }
}

// Fixed public endpoint: no project settings, credentials, or configured npm
// registry are read. Bound the response, deadline and redirects independently.
export async function latestVersion(fetcher = fetch) {
  const signal = AbortSignal.timeout(1500);
  const response = await fetcher(TAGS_URL, { signal, redirect: "error", credentials: "omit", headers: { accept: "application/json" } });
  if (!response.ok) {
    await response.body?.cancel();
    return null;
  }
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 4096) return null;
      chunks.push(Buffer.from(value));
    }
    const data = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    return stableParts(data.latest) ? data.latest : null;
  } finally {
    await reader.cancel();
  }
}

function writeCache(dir, data) {
  const temp = path.join(dir, `update-${randomUUID()}.tmp`);
  try {
    fs.writeFileSync(temp, JSON.stringify(data), { mode: 0o600, flag: "wx" });
    fs.renameSync(temp, path.join(dir, "update.json"));
  } finally {
    try { fs.unlinkSync(temp); } catch { /* Renamed or unwritable. */ }
  }
}

export async function refreshUpdateCache({ dir = updateCacheDir(), now = Date.now(), load = latestVersion } = {}) {
  let locked = false;
  const lock = path.join(dir, "update.lock");
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    if (!fs.lstatSync(dir).isDirectory()) return;
    try {
      fs.mkdirSync(lock, { mode: 0o700 });
    } catch {
      // Recover a worker killed before cleanup, without removing live locks.
      const stat = fs.lstatSync(lock);
      if (!stat.isDirectory() || now - stat.mtimeMs < 60000) return;
      fs.rmdirSync(lock);
      fs.mkdirSync(lock, { mode: 0o700 });
    }
    locked = true;
    if (fresh(readCache(dir), now)) return;
    // Failures are cached too: an offline terminal does not spawn a request on
    // every help invocation. A successful refresh replaces this same record.
    writeCache(dir, { checked_at: now, latest: null });
    const latest = await load();
    if (stableParts(latest)) writeCache(dir, { checked_at: now, latest });
  } catch {
    // Missing network or an unwritable cache is not a CLI error.
  } finally {
    if (locked) { try { fs.rmdirSync(lock); } catch { /* Best effort. */ } }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === WORKER) {
  if (!process.env.METERGRAPH_NO_UPDATE_CHECK) await refreshUpdateCache();
}
