// Packs the package into temporary storage, installs the tarball into a clean
// project and runs the installed CLI. Nothing is written inside the checkout.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import { healthyRoutes, parseJsonLine, startServer } from "../helpers.js";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const sourcePackage = JSON.parse(readFileSync(path.join(PACKAGE_ROOT, "package.json"), "utf8"));
const isWindows = process.platform === "win32";

const EXPECTED_FILES = [
  "LICENSE",
  "README.md",
  "assets/skill/SKILL.md",
  "assets/skill/manifest.json",
  "bin/metergraph.js",
  "package.json",
  "src/args.js",
  "src/auth-binding.js",
  "src/auth-browser.js",
  "src/auth-callback.js",
  "src/auth-login.js",
  "src/auth-oauth.js",
  "src/auth-session.js",
  "src/auth-store.js",
  "src/cli.js",
  "src/constants.js",
  "src/doctor.js",
  "src/http.js",
  "src/origin.js",
  "src/output.js",
  "src/skill-bundle.js",
  "src/skill.js",
  "src/transport.js",
];
const SKILL_SHA256 = "90f7d8d78a5b0b7a57436f194222f0c73310b0b04201c297c8fbf0b00ad6bb3f";
const NO_NETWORK = fileURLToPath(new URL("../fixtures/no-network.js", import.meta.url));

let workDir;
let tarball;
let packedFiles;
let projectDir;
let npmEnv;

// Runs npm without a shell where possible. Under "npm run", npm_execpath
// points at npm's JavaScript entry point, which works the same on every OS.
function npm(args, cwd) {
  const execPath = process.env.npm_execpath;
  const viaNode = execPath && /\.c?js$/.test(execPath);
  const command = viaNode ? process.execPath : isWindows ? "npm.cmd" : "npm";
  const commandArgs = viaNode ? [execPath, ...args] : args;
  return run(command, commandArgs, { cwd, shell: !viaNode && isWindows });
}

function run(command, args, { cwd, shell = false }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd, env: npmEnv, shell, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

function check(result, label) {
  assert.equal(result.code, 0, `${label} failed:\n${result.stderr}`);
  return result;
}

before(async () => {
  workDir = mkdtempSync(path.join(tmpdir(), "metergraph-cli-pack-"));
  const packDir = path.join(workDir, "pack");
  projectDir = path.join(workDir, "project");
  for (const dir of [packDir, projectDir]) mkdirSync(dir, { recursive: true });

  npmEnv = {
    ...process.env,
    npm_config_cache: path.join(workDir, "cache"),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };
  // Strip npm lifecycle variables so nested npm calls do not inherit them.
  for (const key of Object.keys(npmEnv)) {
    if (key.startsWith("npm_lifecycle_") || key === "npm_package_json") delete npmEnv[key];
  }

  const packed = check(
    await npm(["pack", "--json", "--ignore-scripts", "--pack-destination", packDir], PACKAGE_ROOT),
    "npm pack",
  );
  const [info] = JSON.parse(packed.stdout);
  tarball = path.join(packDir, info.filename);
  packedFiles = info.files.map((file) => file.path.replaceAll("\\", "/")).sort();

  writeFileSync(
    path.join(projectDir, "package.json"),
    JSON.stringify({ name: "metergraph-cli-smoke", version: "0.0.0", private: true }),
  );
  check(
    await npm(["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball], projectDir),
    "npm install of the packed tarball",
  );
});

after(() => {
  if (workDir) rmSync(workDir, { recursive: true, force: true });
});

test("the tarball contains exactly the allowlisted files", () => {
  assert.deepEqual(packedFiles, EXPECTED_FILES);
  assert.ok(path.basename(tarball).startsWith("metergraph-cli-"));
});

test("the installed package has the expected metadata and no dependencies", () => {
  const installedRoot = path.join(projectDir, "node_modules", "metergraph-cli");
  const installed = JSON.parse(readFileSync(path.join(installedRoot, "package.json"), "utf8"));
  assert.equal(installed.name, "metergraph-cli");
  assert.equal(installed.version, sourcePackage.version);
  assert.equal(installed.license, "Apache-2.0");
  assert.deepEqual(installed.bin, { metergraph: "bin/metergraph.js" });
  assert.equal(installed.engines.node, ">=22");
  for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "bundleDependencies"]) {
    const value = installed[field];
    assert.ok(value === undefined || Object.keys(value).length === 0, `${field} must be empty`);
  }
  const license = readFileSync(path.join(installedRoot, "LICENSE"), "utf8");
  assert.match(license, /Apache License\s+Version 2\.0, January 2004/);

  const lock = JSON.parse(readFileSync(path.join(projectDir, "package-lock.json"), "utf8"));
  assert.deepEqual(Object.keys(lock.packages).sort(), ["", "node_modules/metergraph-cli"]);
});

test("npm exposes the metergraph bin for this platform", async () => {
  const binDir = path.join(projectDir, "node_modules", ".bin");
  if (isWindows) {
    assert.ok(existsSync(path.join(binDir, "metergraph.cmd")));
    assert.ok(existsSync(path.join(binDir, "metergraph.ps1")));
  } else {
    assert.ok(existsSync(path.join(binDir, "metergraph")));
  }
  const result = check(await npm(["exec", "--offline", "--", "metergraph", "--version", "--json"], projectDir), "npm exec");
  const parsed = parseJsonLine(result.stdout);
  assert.equal(parsed.data.version, sourcePackage.version);
});

test("npm exec runs the packed artifact from an empty directory", async () => {
  const emptyDir = path.join(workDir, "empty");
  mkdirSync(emptyDir, { recursive: true });
  const result = check(
    await npm(
      ["exec", "--yes", "--offline", `--package=${tarball}`, "--", "metergraph", "--help", "--json"],
      emptyDir,
    ),
    "npm exec --package",
  );
  const parsed = parseJsonLine(result.stdout);
  assert.equal(parsed.command, "help");
  assert.equal(parsed.ok, true);
});

test("the packed skill asset is byte-identical to the pinned source", () => {
  const assetDir = path.join(projectDir, "node_modules", "metergraph-cli", "assets", "skill");
  const skill = readFileSync(path.join(assetDir, "SKILL.md"));
  const manifest = JSON.parse(readFileSync(path.join(assetDir, "manifest.json"), "utf8"));
  assert.equal(createHash("sha256").update(skill).digest("hex"), SKILL_SHA256);
  assert.equal(manifest.sha256, SKILL_SHA256);
  assert.equal(manifest.size, skill.length);
  assert.deepEqual(skill, readFileSync(path.join(PACKAGE_ROOT, "assets", "skill", "SKILL.md")));
});

test("the installed CLI installs the skill offline into a project with spaces", async () => {
  const target = path.join(workDir, "skill project");
  mkdirSync(target, { recursive: true });
  const bin = path.join(projectDir, "node_modules", "metergraph-cli", "bin", "metergraph.js");
  const args = [
    "--import",
    pathToFileURL(NO_NETWORK).href,
    bin,
    "skill",
    "install",
    "--client",
    "claude",
    "--runtime",
    "local",
    "--project",
    target,
    "--json",
  ];
  const result = check(await run(process.execPath, args, { cwd: workDir }), "packed skill install");
  const parsed = parseJsonLine(result.stdout);
  assert.equal(parsed.data.status, "installed");
  assert.equal(parsed.data.discovery, "pending");
  assert.equal(parsed.data.authenticated, false);
  assert.equal(parsed.data.source.sha256, SKILL_SHA256);
  const installed = readFileSync(path.join(target, ".claude", "skills", "metergraph", "SKILL.md"));
  assert.equal(createHash("sha256").update(installed).digest("hex"), SKILL_SHA256);
  assert.ok(existsSync(path.join(target, ".metergraph", "skill-installations.json")));

  const rerun = check(await run(process.execPath, args, { cwd: workDir }), "packed skill rerun");
  assert.equal(parseJsonLine(rerun.stdout).data.status, "reused");
});

test("the installed CLI hands a cloud sign in off offline and writes nothing", async () => {
  const target = path.join(workDir, "login project");
  const config = path.join(workDir, "login config");
  mkdirSync(target, { recursive: true });
  const bin = path.join(projectDir, "node_modules", "metergraph-cli", "bin", "metergraph.js");
  const args = [
    "--import",
    pathToFileURL(NO_NETWORK).href,
    bin,
    "login",
    "--runtime",
    "cloud",
    "--url",
    "http://127.0.0.1:9",
    "--project",
    target,
    "--config-dir",
    config,
    "--json",
  ];
  const result = await run(process.execPath, args, { cwd: workDir });
  assert.equal(result.code, 6);
  assert.equal(result.stderr, "");
  const parsed = parseJsonLine(result.stdout);
  assert.equal(parsed.command, "login");
  assert.equal(parsed.error.reason, "runtime_not_supported");
  assert.equal(parsed.data.authenticated, false);
  assert.equal(parsed.data.next_action.kind, "connection_guide");
  assert.equal(existsSync(config), false);
  assert.equal(existsSync(path.join(target, ".metergraph")), false);
});

test("the installed CLI probes a loopback service", async () => {
  const server = await startServer(healthyRoutes("local"));
  try {
    const bin = path.join(projectDir, "node_modules", "metergraph-cli", "bin", "metergraph.js");
    const result = await run(process.execPath, [bin, "doctor", "--url", server.origin, "--json"], {
      cwd: projectDir,
    });
    assert.equal(result.code, 3);
    const parsed = parseJsonLine(result.stdout);
    assert.equal(parsed.outcome, "authentication_required");
    assert.equal(parsed.data.deployment_profile, "local");
    assert.equal(parsed.data.workspace, null);
  } finally {
    await server.close();
  }
});
