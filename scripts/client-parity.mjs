#!/usr/bin/env node
// Parity check of one CLI artifact: a packed tarball or a published package.
// The offline part is credential-free and proves packaged client skill
// placement and safe failure behavior only. --journey adds the live setup
// journey in parity/journey.mjs against a real deployment.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { release, tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { runJourney } from "./parity/journey.mjs";

const CLIENT_PATHS = Object.freeze({
  codex: ".agents/skills/metergraph/SKILL.md",
  claude: ".claude/skills/metergraph/SKILL.md",
  cursor: ".cursor/skills/metergraph/SKILL.md",
});
const NO_NETWORK = fileURLToPath(new URL("../test/fixtures/no-network.js", import.meta.url));
const USAGE = `Usage: node scripts/client-parity.mjs (--tarball /absolute/path.tgz | --package metergraph-cli@VERSION)
  [--journey customer-local|managed --url ORIGIN [--workspace UUID] [--bundle-manifest FILE]
   [--approver automated|person] [--python PATH] [--clients codex,claude,cursor] [--keep] [--out FILE]]
`;

function parseArgs(argv) {
  const values = {};
  const flags = new Set();
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    if (["--keep"].includes(name)) { flags.add(name); continue; }
    if (!name.startsWith("--") || index + 1 >= argv.length) return null;
    values[name] = argv[++index];
  }
  const known = ["--tarball", "--package", "--journey", "--url", "--workspace", "--bundle-manifest", "--approver",
    "--python", "--clients", "--out"];
  if (Object.keys(values).some((name) => !known.includes(name))) return null;
  if ((values["--tarball"] === undefined) === (values["--package"] === undefined)) return null;
  if (values["--tarball"] !== undefined && (!path.isAbsolute(values["--tarball"]) || !existsSync(values["--tarball"]))) return null;
  if (values["--package"] !== undefined && !/^metergraph-cli@[0-9A-Za-z.+-]+$/.test(values["--package"])) return null;
  const journey = values["--journey"] ?? null;
  if (journey !== null && !["customer-local", "managed"].includes(journey)) return null;
  if (journey !== null && values["--url"] === undefined) return null;
  if (journey === "customer-local" && values["--workspace"] === undefined) return null;
  const clients = (values["--clients"] ?? "codex,claude,cursor").split(",");
  if (clients.length === 0 || clients.some((client) => !Object.hasOwn(CLIENT_PATHS, client))) return null;
  const approver = values["--approver"] ?? (journey === "customer-local" ? "automated" : "person");
  if (!["automated", "person"].includes(approver) || (approver === "automated" && journey !== "customer-local")) return null;
  return { tarball: values["--tarball"] ?? null, spec: values["--package"] ?? null, journey, origin: values["--url"] ?? null,
    workspace: values["--workspace"] ?? null, manifest: values["--bundle-manifest"] ?? null, approver,
    python: values["--python"] ?? "python3", clients, keep: flags.has("--keep"), out: values["--out"] ?? null };
}

const options = parseArgs(process.argv.slice(2));
if (options === null) {
  process.stderr.write(USAGE);
  process.exit(2);
}
const { tarball } = options;

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const requireCheck = (condition, label) => { if (!condition) throw new Error(label); };
const work = mkdtempSync(path.join(tmpdir(), "metergraph-client-parity-"));
const report = {
  schema_version: 2,
  started_at: new Date().toISOString(),
  finished_at: null,
  artifact_source: tarball !== null ? "packed_tarball" : "registry",
  artifact_spec: options.spec,
  artifact_sha256: tarball !== null ? sha256(readFileSync(tarball)) : null,
  artifact_integrity: null,
  artifact_version: null,
  node: process.version,
  npm: null,
  platform: process.platform,
  os_release: release(),
  arch: process.arch,
  network: "blocked",
  grants_created: false,
  clients: [],
  failure_matrix: [],
  // Narrowed below to what this run actually covered. live_client_discovery
  // (a coding agent finding and following the skill) and provider-billed
  // application traffic are never covered by this harness.
  not_checked: ["published_registry_bytes", "live_authentication", "live_client_discovery", "application_traffic",
    "hosted_setup", "customer_local_bundle", "byoc", "oss"],
};

function npmInstall(directory, source) {
  // On Windows npm.cmd requires a shell, where an absolute tarball path may
  // contain command metacharacters. Invoke npm's JS entry point with Node.
  const npmCli = [
    process.env.npm_execpath,
    path.join(path.dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    path.resolve(path.dirname(process.execPath), "..", "lib", "node_modules", "npm", "bin", "npm-cli.js"),
  ].find((candidate) => candidate && /\.c?js$/i.test(candidate) && existsSync(candidate));
  requireCheck(npmCli || process.platform !== "win32", "npm_js_cli_unavailable");
  const command = npmCli ? process.execPath : "npm";
  // A tarball installs offline. A registry spec needs the network, with an
  // empty cache so the bytes come from the registry.
  const npmArgs = [...(npmCli ? [npmCli] : []),
    "install", ...(tarball !== null ? ["--offline"] : []), "--ignore-scripts", "--no-audit", "--no-fund", source];
  const run = (extra) => spawnSync(command, [...(npmCli ? [npmCli] : []), ...extra], { cwd: directory, encoding: "utf8",
    timeout: 120000, maxBuffer: 1024 * 1024,
    env: { ...process.env, npm_config_cache: path.join(work, "npm-cache"), npm_config_audit: "false", npm_config_fund: "false" } });
  const result = run(npmArgs.slice(npmCli ? 1 : 0));
  requireCheck(result.status === 0, tarball !== null ? "offline_tarball_install_failed" : "registry_install_failed");
  report.npm = run(["--version"]).stdout.trim() || null;
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
  npmInstall(install, tarball ?? options.spec);
  const lock = JSON.parse(readFileSync(path.join(install, "package-lock.json"), "utf8"));
  report.artifact_integrity = lock.packages?.["node_modules/metergraph-cli"]?.integrity ?? null;
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

  if (options.journey !== null) {
    report.journey = await journey(bin, bundledSkill);
    if (report.journey.results.some((result) => !result.ok)) process.exitCode = 1;
  }
  const covered = new Set([
    ...(tarball === null ? ["published_registry_bytes"] : []),
    ...(options.journey !== null ? ["live_authentication"] : []),
    ...(options.journey === "customer-local" ? ["customer_local_bundle"] : []),
    ...(options.journey === "managed" ? ["hosted_setup"] : []),
  ]);
  report.not_checked = report.not_checked.filter((gate) => !covered.has(gate));
  report.finished_at = new Date().toISOString();
  const text = `${JSON.stringify(report)}\n`;
  if (options.out !== null) writeFileSync(options.out, text);
  process.stdout.write(text);
} catch (error) {
  process.stderr.write(`Parity smoke failed: ${error.message}\n`);
  process.exitCode = 1;
} finally {
  if (options.keep) process.stderr.write(`Kept parity work directory: ${work}\n`);
  else rmSync(work, { recursive: true, force: true });
}

async function journey(bin, bundledSkill) {
  const journeyWork = path.join(work, "journey");
  mkdirSync(journeyWork);
  const python = spawnSync(options.python, ["-c",
    "import importlib.metadata as m, platform; print(platform.python_version(), m.version('metergraph'), m.version('openai'))"],
  { encoding: "utf8" });
  const [pythonVersion, sdkVersion, openaiVersion] = python.status === 0 ? python.stdout.trim().split(" ") : [null, null, null];
  const deployment = options.journey === "managed" ? "managed" : "customer-local";
  const live = await runJourney({ bin, deployment, origin: options.origin, workspace: options.workspace,
    work: journeyWork, clients: options.clients, bundledSkill, approver: options.approver, python: options.python });
  // Only the release fields of the signed manifest; it holds no credential.
  let bundle = null;
  if (options.manifest !== null) {
    const manifest = JSON.parse(readFileSync(options.manifest, "utf8"));
    bundle = { release: manifest.release, source_commit: manifest.source_commit,
      local_bundle_sha256: manifest.local_bundle_sha256, local_image_digest: manifest.local_image_digest };
  }
  const setups = live.results.filter((result) => result.id.startsWith("fresh_setup_"));
  return {
    deployment, origin: options.origin, workspace_id: options.workspace, bundle, approver: options.approver,
    sdk: { python: pythonVersion, metergraph: sdkVersion, openai: openaiVersion },
    trace_id: live.trace_id, results: live.results,
    baseline: {
      setup_ms: setups.map((result) => result.cli_ms ?? null),
      approvals_per_fresh_setup: setups.map((result) => result.approvals ?? null),
      failed: live.results.filter((result) => !result.ok).map((result) => result.id),
    },
    evidence_dir: options.keep ? live.evidence_dir : null,
  };
}
