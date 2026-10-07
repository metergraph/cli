#!/usr/bin/env node
// Offline, credential-free smoke of an explicitly supplied CLI tarball.
// It proves packaged client skill placement and safe failure behavior only.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const CLIENT_PATHS = Object.freeze({
  codex: ".agents/skills/metergraph/SKILL.md",
  claude: ".claude/skills/metergraph/SKILL.md",
  cursor: ".cursor/skills/metergraph/SKILL.md",
});
const NO_NETWORK = fileURLToPath(new URL("../test/fixtures/no-network.js", import.meta.url));
const args = process.argv.slice(2);
const tarball = args.length === 2 && args[0] === "--tarball" ? args[1] : null;
if (!tarball || !path.isAbsolute(tarball) || !existsSync(tarball)) {
  process.stderr.write("Usage: node scripts/client-parity.mjs --tarball /absolute/path/to/metergraph-cli.tgz\n");
  process.exit(2);
}

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requireCheck = (condition, label) => { if (!condition) throw new Error(label); };
const work = mkdtempSync(path.join(tmpdir(), "metergraph-client-parity-"));
const report = {
  schema_version: 1,
  artifact_sha256: sha256(readFileSync(tarball)),
  artifact_version: null,
  node: process.version,
  platform: process.platform,
  network: "blocked",
  grants_created: false,
  clients: [],
  failure_matrix: [],
  not_checked: ["published_registry_bytes", "live_authentication", "application_traffic", "hosted_setup", "customer_local_bundle", "byoc", "oss"],
};

function npmInstall(directory) {
  const exec = process.env.npm_execpath;
  const viaNode = exec && /\.c?js$/.test(exec);
  const command = viaNode ? process.execPath : process.platform === "win32" ? "npm.cmd" : "npm";
  const npmArgs = viaNode ? [exec, "install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball]
    : ["install", "--offline", "--ignore-scripts", "--no-audit", "--no-fund", tarball];
  const result = spawnSync(command, npmArgs, { cwd: directory, encoding: "utf8", shell: !viaNode && process.platform === "win32",
    timeout: 60000, maxBuffer: 1024 * 1024,
    env: { ...process.env, npm_config_cache: path.join(work, "npm-cache"), npm_config_audit: "false", npm_config_fund: "false" } });
  requireCheck(result.status === 0, "offline_tarball_install_failed");
}

function invoke(bin, command, project, configDir, { skill = false } = {}) {
  const result = spawnSync(process.execPath,
    ["--import", pathToFileURL(NO_NETWORK).href, bin, ...command, "--project", project,
      ...(skill ? [] : ["--config-dir", configDir]), "--json"],
    { cwd: project, encoding: "utf8", timeout: 30000, maxBuffer: 1024 * 1024,
      env: { ...process.env, METERGRAPH_CONFIG_DIR: configDir } });
  requireCheck(result.stderr === "", "unexpected_stderr");
  let body;
  try { body = JSON.parse(result.stdout); } catch { throw new Error("invalid_json_envelope"); }
  requireCheck(result.stdout.trim().split("\n").length === 1 && body.exit_code === result.status, "invalid_exit_or_output");
  return body;
}

try {
  const install = path.join(work, "runner");
  mkdirSync(install);
  writeFileSync(path.join(install, "package.json"), JSON.stringify({ name: "metergraph-parity-runner", version: "0.0.0", private: true }));
  npmInstall(install);
  const pkgRoot = path.join(install, "node_modules", "metergraph-cli");
  const pkg = JSON.parse(readFileSync(path.join(pkgRoot, "package.json"), "utf8"));
  report.artifact_version = pkg.version;
  const bin = path.join(pkgRoot, "bin", "metergraph.js");
  const bundledSkill = readFileSync(path.join(pkgRoot, "assets", "skill", "SKILL.md"));
  const configDir = path.join(work, "never-signed-in");
  const since = new Date(Date.now() - 60000).toISOString();
  const until = new Date(Date.now() - 30000).toISOString();

  for (const [client, relative] of Object.entries(CLIENT_PATHS)) {
    const project = path.join(work, `fresh-${client}`);
    mkdirSync(project);
    const skillResult = invoke(bin, ["skill", "install", "--client", client, "--runtime", "local"],
      project, configDir, { skill: true });
    const target = path.join(project, relative);
    requireCheck(skillResult.outcome === "ok" && skillResult.data.status === "installed" && skillResult.data.discovery === "pending" &&
      skillResult.data.authenticated === false && existsSync(target), "client_discovery_claim_invalid");
    requireCheck(sha256(readFileSync(target)) === sha256(bundledSkill), "skill_bytes_mismatch");
    const receipt = path.join(project, ".metergraph", "skill-installations.json");
    const receiptHash = sha256(readFileSync(receipt));
    const rerun = invoke(bin, ["skill", "install", "--client", client, "--runtime", "local"],
      project, configDir, { skill: true });
    requireCheck(rerun.outcome === "ok" && rerun.data.status === "reused" &&
      sha256(readFileSync(target)) === sha256(bundledSkill) && sha256(readFileSync(receipt)) === receiptHash,
    "skill_rerun_not_idempotent");
    const status = invoke(bin, ["status"], project, configDir);
    requireCheck(status.outcome === "login_required" && status.data.authenticated === false &&
      status.data.application_traffic_verified === false, "status_claim_invalid");
    const verify = invoke(bin,
      ["verify", "--trace-id", "example-trace", "--since", since, "--until", until, "--source", "synthetic"], project, configDir);
    requireCheck(verify.outcome === "login_required" && verify.data === null, "verify_claim_invalid");
    requireCheck(!existsSync(path.join(project, ".metergraph", "project.json")) && !existsSync(configDir), "grant_or_binding_created");
    report.clients.push({ client, skill_path: relative, skill_sha256: sha256(readFileSync(target)),
      discovery: skillResult.data.discovery, rerun: rerun.data.status,
      status: status.outcome, verify: verify.outcome });
  }

  const matrixProject = path.join(work, "failure-matrix");
  mkdirSync(matrixProject);
  for (const [name, command, outcome, reason] of [
    ["cloud_login", ["login", "--runtime", "cloud"], "unsupported", "runtime_not_supported"],
    ["environment_selector", ["usage", "--environment", "production"], "unsupported", "environment_selector_unsupported"],
    ["workload_filter", ["traces", "--workload", "example"], "unsupported", "workload_filter_unsupported"],
    ["content_access", ["traces", "--content"], "unsupported", "content_access_unsupported"],
    ["missing_trace_identity", ["verify", "--since", since, "--until", until], "invalid_input", "invalid_trace_identity"],
  ]) {
    const result = invoke(bin, command, matrixProject, configDir);
    requireCheck(result.outcome === outcome && result.error?.reason === reason, `failure_matrix_${name}`);
    report.failure_matrix.push({ case: name, outcome, reason });
  }
  const cloudSkill = invoke(bin, ["skill", "install", "--client", "codex", "--runtime", "cloud-no-shell"],
    matrixProject, configDir, { skill: true });
  requireCheck(cloudSkill.outcome === "unsupported" && cloudSkill.error?.reason === "runtime_not_supported" &&
    !existsSync(path.join(matrixProject, ".metergraph")), "failure_matrix_cloud_skill");
  report.failure_matrix.push({ case: "cloud_skill", outcome: "unsupported", reason: "runtime_not_supported" });
  requireCheck(!existsSync(configDir), "grant_created");
  process.stdout.write(`${JSON.stringify(report)}\n`);
} catch (error) {
  process.stderr.write(`Parity smoke failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  rmSync(work, { recursive: true, force: true });
}
