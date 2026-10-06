// Helpers for sign in tests. Every run uses a temporary project and a
// temporary --config-dir, so no real configuration or credential is touched.
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { BIN, FAKE_SECRETS, assertNoLeak, parseJsonLine, runCli } from "./helpers.js";

export const BROWSER = pathToFileURL(fileURLToPath(new URL("./fixtures/browser-agent.js", import.meta.url))).href;
export const isWindows = process.platform === "win32";

// Blank presence markers so the inherited CI or SSH environment of the test
// runner does not turn every sign in into a handoff. Tests that check the
// handoff set them explicitly.
export const LOCAL_ENV = Object.freeze({
  CI: "",
  SSH_CONNECTION: "",
  SSH_CLIENT: "",
  SSH_TTY: "",
  CODESPACES: "",
  GITPOD_WORKSPACE_ID: "",
  CLOUD_SHELL: "",
  METERGRAPH_CONFIG_DIR: "",
});

export function sandboxes(workDir) {
  let counter = 0;
  return () => {
    counter += 1;
    const base = path.join(workDir, `case ${counter}`);
    const project = path.join(base, "my project");
    fs.mkdirSync(project, { recursive: true });
    return { base, project, config: path.join(base, "config"), log: path.join(base, "browser.log") };
  };
}

export const FAULTS = pathToFileURL(fileURLToPath(new URL("./fixtures/fs-faults.js", import.meta.url))).href;

export async function login(
  assert,
  box,
  server,
  extra = [],
  { browser = "follow", env = {}, json = true, imports = [] } = {},
) {
  const args = [
    "login",
    "--runtime",
    "local",
    "--url",
    server.origin,
    "--project",
    box.project,
    "--config-dir",
    box.config,
    ...extra,
  ];
  const run = await runCli(json ? ["--json", ...args] : args, {
    imports: [BROWSER, ...imports],
    env: { ...LOCAL_ENV, METERGRAPH_TEST_BROWSER: browser, METERGRAPH_TEST_BROWSER_LOG: box.log, ...env },
  });
  return checked(assert, run, { box, server, json });
}

export async function logout(assert, box, server = null, { json = true, offline = false, imports = [], env = {} } = {}) {
  const args = ["logout", "--project", box.project, "--config-dir", box.config];
  const run = await runCli(json ? ["--json", ...args] : args, { offline, imports, env: { ...LOCAL_ENV, ...env } });
  return checked(assert, run, { box, server, json });
}

// Checks what every sign in run must satisfy and returns { run, result }.
export function checked(assert, run, { box, server = null, json = true }) {
  assertNoLeak(assert, run.stdout, run.stderr);
  for (const text of [run.stdout, run.stderr]) {
    for (const secret of secretsOf(server)) assert.ok(!text.includes(secret), "a credential value was printed");
    for (const base of [box.base, realpath(box.base)]) assert.ok(!text.includes(base), "an absolute path was printed");
    assert.ok(!text.includes("SYNTHETIC_FAULT_MARKER"), "raw error text was printed");
  }
  for (const file of filesUnder(box.project)) {
    const content = fs.readFileSync(path.join(box.project, file), "latin1");
    for (const secret of secretsOf(server)) assert.ok(!content.includes(secret), "a credential was written into the project");
  }
  if (!json) return { run, result: null };
  assert.equal(run.stderr, "", "JSON mode must keep stderr empty");
  const result = parseJsonLine(run.stdout);
  assert.equal(result.exit_code, run.code);
  return { run, result };
}

// Issued codes and tokens, plus PKCE verifiers and refresh tokens the CLI sent.
export function secretsOf(server) {
  if (server === null) return [];
  const sent = [];
  for (const request of server.requests) {
    if (request.method !== "POST" || !request.body) continue;
    const form = new URLSearchParams(request.body);
    for (const key of ["code_verifier", "refresh_token", "token", "code"]) {
      const value = form.get(key);
      if (value) sent.push(value);
    }
  }
  return [...server.issued, ...sent];
}

function realpath(file) {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

export function filesUnder(dir, prefix = "") {
  if (!fs.existsSync(path.join(dir, prefix))) return [];
  const entries = [];
  for (const name of fs.readdirSync(path.join(dir, prefix)).sort()) {
    const relative = prefix ? `${prefix}/${name}` : name;
    const stat = fs.lstatSync(path.join(dir, relative));
    if (stat.isDirectory()) entries.push(...filesUnder(dir, relative));
    else entries.push(relative);
  }
  return entries;
}

export function browserLog(box) {
  if (!fs.existsSync(box.log)) return [];
  return fs.readFileSync(box.log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

export function readBindingFile(box) {
  return JSON.parse(fs.readFileSync(path.join(box.project, ".metergraph", "project.json"), "utf8"));
}

export function credentialFiles(box) {
  const dir = path.join(box.config, "credentials");
  return fs.existsSync(dir) ? fs.readdirSync(dir).sort() : [];
}

// Starts the CLI without waiting for it, for runs a test must watch or
// interrupt. waitFor polls until predicate returns a truthy value.
export function startCli(args, { env = {}, imports = [] } = {}) {
  const child = spawn(process.execPath, [...imports.flatMap((url) => ["--import", url]), BIN, ...args], {
    env: { ...process.env, ...FAKE_SECRETS, NO_COLOR: "1", ...LOCAL_ENV, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  const output = { stdout: "", stderr: "" };
  child.stdout.setEncoding("utf8").on("data", (chunk) => (output.stdout += chunk));
  child.stderr.setEncoding("utf8").on("data", (chunk) => (output.stderr += chunk));
  const done = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("CLI subprocess did not exit in time"));
    }, 20000);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, ...output });
    });
  });
  const waitFor = async (predicate) => {
    for (let i = 0; i < 400; i += 1) {
      const value = predicate(output);
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    throw new Error("expected output was not seen");
  };
  return { child, done, waitFor };
}

// What a person's browser does after consent: follow the service's
// redirects to the loopback callback and load it. Returns the callback status.
export async function completeInBrowser(start) {
  let current = new URL(start);
  for (let hop = 0; hop < 5; hop += 1) {
    const response = await get(current.href);
    if (current.pathname === "/callback") return response.status;
    if (response.status !== 302) return response.status;
    current = new URL(response.location, current);
  }
  return null;
}

function get(url) {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { agent: false }, (response) => {
      response.resume();
      response.on("end", () => resolve({ status: response.statusCode, location: response.headers.location }));
    });
    request.on("error", reject);
  });
}
