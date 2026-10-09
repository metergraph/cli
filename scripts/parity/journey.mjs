// Live setup journey for client-parity.mjs: runs the installed CLI against a
// real deployment, through the release scenarios (fresh setup per
// client, rerun, existing env file, wrong workspace, revoked grant,
// interrupted and denied approval, modified skill, no-browser, an SDK trace,
// exact verify and its view, verify timeout, logout).
//
// customer-local approvals are automated by browser-approver.mjs as the
// stack's own throwaway administrator. hosted approvals open the person's own
// browser and wait for them: run that only with their consent.
//
// Nothing here prints a credential. The env file setup writes is read only to
// hand its two values to the SDK child process.
import { spawn, spawnSync } from "node:child_process";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { chmodSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const APPROVER = pathToFileURL(fileURLToPath(new URL("./browser-approver.mjs", import.meta.url))).href;
const BROWSER = fileURLToPath(new URL("./approve-browser.mjs", import.meta.url));
const SDK_APP = fileURLToPath(new URL("./sdk_app.py", import.meta.url));
const CLIENT_PATHS = Object.freeze({
  codex: ".agents/skills/metergraph/SKILL.md",
  claude: ".claude/skills/metergraph/SKILL.md",
  cursor: ".cursor/skills/metergraph/SKILL.md",
});
// Blank the runner's own CI and SSH markers: the harness stands in for a
// person's local terminal session.
const LOCAL_SESSION = { CI: "", SSH_CONNECTION: "", SSH_CLIENT: "", SSH_TTY: "", CODESPACES: "",
  GITPOD_WORKSPACE_ID: "", CLOUD_SHELL: "", METERGRAPH_CONFIG_DIR: "" };

const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const hashOf = (file) => (existsSync(file) ? sha256(readFileSync(file)) : null);
const now = () => Date.now();

export async function runJourney(options) {
  const { bin, deployment, origin, workspace, work, clients, bundledSkill, approver, python } = options;
  const configDir = path.join(work, "config");
  const browserProfile = path.join(work, "browser-profile");
  const approverLog = path.join(work, "evidence", "approver.jsonl");
  mkdirSync(path.dirname(approverLog), { recursive: true });
  const results = [];
  const approvals = () => (existsSync(approverLog)
    ? readFileSync(approverLog, "utf8").trim().split("\n").filter((line) => line.includes('"step":"opened"')).length : 0);

  function cli(args, project, { mode = "approve", signalAfterOpen = null } = {}) {
    const preload = approver === "automated" ? ["--import", APPROVER] : [];
    const env = { ...process.env, ...LOCAL_SESSION, METERGRAPH_PARITY_APPROVER: mode,
      METERGRAPH_PARITY_PROFILE: browserProfile, METERGRAPH_PARITY_LOG: approverLog };
    const started = now();
    const before = approvals();
    return new Promise((resolve) => {
      const child = spawn(process.execPath, [...preload, bin, "--json", ...args, "--project", project,
        "--config-dir", configDir], { cwd: project, env, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk) => { stdout += chunk; });
      child.stderr.on("data", (chunk) => { stderr += chunk; });
      let poll = null;
      if (signalAfterOpen !== null) {
        poll = setInterval(() => {
          if (approvals() > before) { clearInterval(poll); setTimeout(() => child.kill(signalAfterOpen), 300); }
        }, 100);
      }
      child.on("close", (code, signal) => {
        if (poll !== null) clearInterval(poll);
        let body = null;
        try { body = JSON.parse(stdout.trim().split("\n").at(-1)); } catch { /* recorded as null */ }
        resolve({ code, signal, body, stderr, ms: now() - started, approvals: approvals() - before });
      });
    });
  }

  async function scenario(id, evidence, fn) {
    const record = { id, evidence, ok: false, checks: {}, notes: [] };
    const check = (name, condition, detail = undefined) => {
      record.checks[name] = condition ? "pass" : (detail === undefined ? "fail" : `fail: ${detail}`);
    };
    const started = now();
    try {
      await fn(record, check);
    } catch (error) {
      record.checks.harness_error = `fail: ${String(error?.message ?? error).split("\n")[0].slice(0, 160)}`;
    }
    record.ms = now() - started;
    record.ok = Object.values(record.checks).length > 0 && Object.values(record.checks).every((value) => value === "pass");
    results.push(record);
    return record;
  }
  const summarize = (record, run) => {
    record.exit_code = run.code;
    record.outcome = run.body?.outcome ?? null;
    record.reason = run.body?.error?.reason ?? null;
    record.cli_ms = run.ms;
    record.approvals = run.approvals;
  };
  const freshProject = (name, files = {}) => {
    const project = path.join(work, "projects", name);
    mkdirSync(project, { recursive: true });
    spawnSyncGitInit(project);
    for (const [relative, text] of Object.entries(files)) writeFileSync(path.join(project, relative), text);
    return project;
  };
  const setupArgs = (client, extra = []) => ["setup", "--runtime", "local", "--client", client,
    ...(deployment === "managed" ? ["--url", origin] : ["--deployment", deployment, "--url", origin,
      "--workspace", workspace, "--confirm-prerequisites"]), "--timeout-ms", "120000", ...extra];
  const projectState = (project, client = "claude") => ({
    env: hashOf(path.join(project, ".env")),
    setup: hashOf(path.join(project, ".metergraph", "setup.json")),
    binding: hashOf(path.join(project, ".metergraph", "project.json")),
    skill: hashOf(path.join(project, CLIENT_PATHS[client])),
  });
  const nothingWritten = (project) => !existsSync(path.join(project, ".env")) &&
    !existsSync(path.join(project, ".metergraph", "setup.json")) && !existsSync(path.join(project, ".metergraph", "project.json"));

  // 1. A fresh project per client. The first one is the baseline project the
  // later scenarios reuse.
  const projects = {};
  for (const client of clients) {
    await scenario(`fresh_setup_${client}`, "real_deployment", async (record, check) => {
      const project = freshProject(`fresh-${client}`);
      projects[client] = project;
      const run = await cli(setupArgs(client), project);
      summarize(record, run);
      check("outcome_ok", run.body?.outcome === "ok", record.reason);
      check("env_created", run.body?.data?.env === "created");
      check("skill_installed", run.body?.data?.skill === "installed");
      check("receipt_profile", run.body?.data?.receipt?.deployment_profile === (deployment === "managed" ? "managed" : "local"));
      check("receipt_workspace", workspace === null || run.body?.data?.receipt?.workspace_id === workspace);
      check("traffic_not_claimed", run.body?.data?.application_traffic_verified === false);
      const env = path.join(project, ".env");
      check("env_private", process.platform === "win32" || (existsSync(env) && (statSync(env).mode & 0o077) === 0));
      check("env_gitignored", existsSync(path.join(project, ".gitignore")) &&
        readFileSync(path.join(project, ".gitignore"), "utf8").split(/\r?\n/).some((line) => [".env", "/.env"].includes(line)));
      const skill = path.join(project, CLIENT_PATHS[client]);
      check("skill_bytes_match_bundle", hashOf(skill) === sha256(bundledSkill));
      check("no_credential_in_output", !leaks(project, run));
      record.skill_path = CLIENT_PATHS[client];
    });
  }
  const base = projects[clients[0]];
  const baseClient = clients[0];

  await scenario("rerun", "real_deployment", async (record, check) => {
    const before = projectState(base, baseClient);
    const run = await cli(setupArgs(baseClient), base);
    summarize(record, run);
    check("outcome_ok", run.body?.outcome === "ok", record.reason);
    check("env_unchanged", run.body?.data?.env === "unchanged");
    check("skill_reused", run.body?.data?.skill === "reused");
    check("no_approval", run.approvals === 0);
    check("files_identical", JSON.stringify(projectState(base, baseClient)) === JSON.stringify(before));
  });

  await scenario("rerun_no_browser_json", "real_deployment", async (record, check) => {
    const run = await cli(setupArgs(baseClient, ["--no-browser"]), base);
    summarize(record, run);
    check("outcome_ok", run.body?.outcome === "ok", record.reason);
    check("no_approval", run.approvals === 0);
  });

  await scenario("no_browser_fresh_json", "real_deployment", async (record, check) => {
    const project = freshProject("no-browser");
    const run = await cli(setupArgs(baseClient, ["--no-browser"]), project);
    summarize(record, run);
    check("refused_exit_6", run.code === 6 && record.reason === "no_browser_requires_terminal", record.reason);
    check("next_action_run_in_terminal", run.body?.data?.next_action?.kind === "run_in_terminal");
    check("no_approval", run.approvals === 0);
    check("nothing_written", nothingWritten(project));
  });

  await scenario("existing_env_unowned_key", "real_deployment", async (record, check) => {
    const text = `EXAMPLE_SETTING=keep\nMETERGRAPH_APP_TOKEN=mg_${randomBytes(24).toString("hex")}\n`;
    const project = freshProject("existing-env-key", { ".env": text, ".gitignore": ".env\n" });
    const run = await cli(setupArgs(baseClient), project);
    summarize(record, run);
    check("refused_conflict", record.reason === "existing_ingest_key_unowned", record.reason);
    check("env_byte_identical", readFileSync(path.join(project, ".env"), "utf8") === text);
    check("no_setup_state", !existsSync(path.join(project, ".metergraph", "setup.json")));
    if (run.approvals > 0) record.notes.push("sign-in approval happened before the existing key was refused");
  });

  await scenario("existing_env_other_values", "real_deployment", async (record, check) => {
    const project = freshProject("existing-env-values", { ".env": "EXAMPLE_SETTING=keep\n", ".gitignore": ".env\n" });
    const run = await cli(setupArgs(baseClient), project);
    summarize(record, run);
    check("outcome_ok", run.body?.outcome === "ok", record.reason);
    const env = readFileSync(path.join(project, ".env"), "utf8");
    check("unrelated_value_kept", env.includes("EXAMPLE_SETTING=keep\n"));
    check("ingest_values_added", /^METERGRAPH_APP_TOKEN=/m.test(env) && /^METERGRAPH_INGEST_URL=/m.test(env));
  });

  await scenario("wrong_workspace_bound_project", "real_deployment", async (record, check) => {
    const before = projectState(base, baseClient);
    const args = setupArgs(baseClient).filter((value, index, all) => all[index - 1] !== "--workspace" && value !== "--workspace");
    const run = await cli([...args, "--workspace", randomUUID()], base);
    summarize(record, run);
    check("refused_conflict", run.body?.outcome === "conflict", `${record.outcome}/${record.reason}`);
    check("no_approval", run.approvals === 0);
    check("files_identical", JSON.stringify(projectState(base, baseClient)) === JSON.stringify(before));
  });

  if (deployment !== "managed") {
    await scenario("wrong_workspace_fresh_project", "real_deployment", async (record, check) => {
      const project = freshProject("wrong-workspace");
      const args = setupArgs(baseClient).filter((value, index, all) => all[index - 1] !== "--workspace" && value !== "--workspace");
      const run = await cli([...args, "--workspace", randomUUID()], project);
      summarize(record, run);
      check("refused", run.body?.ok === false, `${record.outcome}/${record.reason}`);
      check("nothing_written", nothingWritten(project));
    });
  }

  await scenario("modified_skill", "real_deployment", async (record, check) => {
    const skill = path.join(base, CLIENT_PATHS[baseClient]);
    const original = readFileSync(skill);
    const envBefore = hashOf(path.join(base, ".env"));
    writeFileSync(skill, `${original}\n<!-- local edit -->\n`);
    const run = await cli(setupArgs(baseClient), base);
    summarize(record, run);
    check("refused_conflict", run.body?.outcome === "conflict", `${record.outcome}/${record.reason}`);
    check("status_skill_pending", run.body?.data?.status === "credential_ready_skill_pending");
    check("edit_preserved", readFileSync(skill, "utf8").endsWith("<!-- local edit -->\n"));
    check("env_unchanged", hashOf(path.join(base, ".env")) === envBefore);
    check("no_approval", run.approvals === 0);
    writeFileSync(skill, original);
    const restored = await cli(setupArgs(baseClient), base);
    check("restored_rerun_ok", restored.body?.outcome === "ok" && restored.body?.data?.skill === "reused");
  });

  if (approver === "automated") {
    for (const [id, mode, signal, expected] of [
      ["interrupted_setup", "ignore", "SIGINT", "cancelled"],
      ["denied_approval", "deny", null, "access_denied"],
    ]) {
      await scenario(id, "real_deployment", async (record, check) => {
        const project = freshProject(id);
        const run = await cli(setupArgs(baseClient), project, { mode, signalAfterOpen: signal });
        summarize(record, run);
        check("authorization_failed", run.body?.outcome === "authorization_failed" && record.reason === expected,
          `${record.outcome}/${record.reason}`);
        check("nothing_written", nothingWritten(project));
        const status = await cli(["status"], project);
        check("status_login_required", status.body?.outcome === "login_required", status.body?.outcome);
      });
    }
  }

  // The SDK sends one trace through the key setup wrote; the provider is a
  // local mock. Then exact verification, its link, and the deadline.
  let traceId = null;
  let window = null;
  let appUrl = null;
  await scenario("sdk_trace_and_exact_verify", "synthetic_application_traffic", async (record, check) => {
    const mock = await startMockProvider();
    try {
      traceId = randomBytes(16).toString("hex");
      const since = new Date(now() - 60000).toISOString();
      const env = { ...process.env, ...readSetupEnv(path.join(base, ".env")) };
      const sdk = await runChild(python, [SDK_APP, traceId, `${mock.origin}/v1`], { cwd: base, env });
      check("sdk_flushed", sdk.code === 0 && sdk.stdout.includes('"flushed": true'), sdk.stderr.split("\n").at(-2));
      check("mock_provider_called_once", mock.calls() === 1);
      // The window must bound a past invocation, so it ends now.
      window = { since, until: new Date(now()).toISOString() };
      const run = await cli(["verify", "--trace-id", traceId, "--since", window.since, "--until", window.until,
        "--source", "synthetic", "--timeout-ms", "60000"], base);
      summarize(record, run);
      check("verify_ok", run.body?.outcome === "ok", `${record.outcome}/${record.reason}`);
      const data = run.body?.data ?? {};
      record.verify = { attempts: data.attempts ?? null, trace_status: data.trace?.status ?? data.status ?? null,
        link_workspace_bound: data.link_workspace_bound ?? null, content_included: data.content_included ?? null };
      check("content_not_included", data.content_included === false);
      check("link_workspace_bound", data.link_workspace_bound === true);
      appUrl = data.app_url ?? null;
    } finally {
      await mock.close();
    }
  });

  await scenario("verify_open_json", "synthetic_application_traffic", async (record, check) => {
    const run = await cli(["verify", "--trace-id", traceId, "--since", window.since, "--until", window.until,
      "--source", "synthetic", "--open"], base, { mode: "view" });
    summarize(record, run);
    check("verify_ok", run.body?.outcome === "ok", `${record.outcome}/${record.reason}`);
    check("browser_suppressed_by_json", run.body?.data?.browser === "suppressed_by_json", run.body?.data?.browser);
    if (approver === "automated" && appUrl !== null) {
      // Open the returned link as the administrator would, and confirm the
      // page shows this exact trace.
      const viewer = spawn(process.execPath, [BROWSER], { stdio: ["pipe", "ignore", "inherit"],
        env: { ...process.env, METERGRAPH_PARITY_APPROVER: "view", METERGRAPH_PARITY_EXPECT: traceId,
          METERGRAPH_PARITY_PROFILE: browserProfile, METERGRAPH_PARITY_LOG: approverLog } });
      viewer.stdin.end(appUrl);
      await new Promise((resolve) => viewer.on("close", resolve));
      const viewed = readFileSync(approverLog, "utf8").trim().split("\n").map((line) => JSON.parse(line))
        .filter((entry) => entry.step === "view").at(-1);
      record.view = viewed ? { page: viewed.page, screenshot: path.basename(viewed.screenshot ?? "") } : null;
      check("dashboard_shows_exact_trace", viewed?.expected_visible === true);
    }
  });

  await scenario("verify_timeout", "real_deployment", async (record, check) => {
    const since = new Date(now() - 60000).toISOString();
    const until = new Date(now()).toISOString();
    const run = await cli(["verify", "--trace-id", randomBytes(16).toString("hex"), "--since", since, "--until", until,
      "--source", "synthetic", "--timeout-ms", "3000"], base);
    summarize(record, run);
    check("exit_11_verification_failed", run.code === 11 && run.body?.outcome === "verification_failed",
      `${record.exit_code}/${record.outcome}/${record.reason}`);
    check("bounded", run.ms < 3000 + 2500, `${run.ms} ms`);
  });

  await scenario("revoked_metadata_grant", "real_deployment", async (record, check) => {
    // Keep a copy of the signed-in state, log out (which revokes the grant on
    // the server), then put the copy back: a grant the server revoked but
    // this machine still holds.
    const project = projects[clients.at(-1)];
    const saved = path.join(work, "revoked-snapshot");
    copyWithModes(configDir, path.join(saved, "config"));
    copyWithModes(path.join(project, ".metergraph"), path.join(saved, "metergraph"));
    const logout = await cli(["logout"], project);
    check("logout_revocation_accepted", logout.body?.data?.revocation === "accepted", logout.body?.data?.revocation);
    rmSync(configDir, { recursive: true, force: true });
    copyWithModes(path.join(saved, "config"), configDir);
    copyWithModes(path.join(saved, "metergraph"), path.join(project, ".metergraph"));
    rmSync(saved, { recursive: true, force: true });
    const status = await cli(["status"], project);
    summarize(record, status);
    check("status_not_authenticated", status.body?.data?.authenticated !== true, status.body?.outcome);
    check("status_refused", status.body?.ok === false, status.body?.outcome);
    const verify = await cli(["verify", "--trace-id", traceId ?? randomBytes(16).toString("hex"), "--since",
      new Date(now() - 60000).toISOString(), "--until", new Date(now()).toISOString(), "--source", "synthetic"], project);
    check("verify_refused", verify.body?.ok === false, verify.body?.outcome);
    record.verify_outcome = `${verify.body?.outcome}/${verify.body?.error?.reason}`;
    check("no_credential_in_output", !leaks(project, status) && !leaks(project, verify));
  });

  await scenario("logout", "real_deployment", async (record, check) => {
    const run = await cli(["logout"], base);
    summarize(record, run);
    check("revocation_accepted", run.body?.data?.revocation === "accepted", run.body?.data?.revocation);
    const verify = await cli(["verify", "--trace-id", traceId ?? randomBytes(16).toString("hex"), "--since",
      window?.since ?? new Date(now() - 60000).toISOString(), "--until", window?.until ?? new Date(now()).toISOString(),
      "--source", "synthetic"], base);
    check("verify_login_required", verify.body?.outcome === "login_required", verify.body?.outcome);
  });

  return { results, trace_id: traceId, evidence_dir: path.dirname(approverLog),
    screenshots: readdirSync(path.dirname(approverLog)).filter((name) => name.endsWith(".png")) };
}

// cpSync does not keep directory modes, and the CLI refuses a credential
// directory that is not private. Copy the tree and then its modes.
function copyWithModes(from, to) {
  cpSync(from, to, { recursive: true });
  const walk = (source, target) => {
    chmodSync(target, statSync(source).mode & 0o777);
    if (statSync(source).isDirectory()) {
      for (const name of readdirSync(source)) walk(path.join(source, name), path.join(target, name));
    }
  };
  walk(from, to);
}

// True when the output holds the ingest token setup wrote to this project.
function leaks(project, run) {
  const env = path.join(project, ".env");
  if (!existsSync(env)) return false;
  const token = readFileSync(env, "utf8").match(/^METERGRAPH_APP_TOKEN=(.+)$/m)?.[1];
  return token !== undefined && (JSON.stringify(run.body ?? "").includes(token) || run.stderr.includes(token));
}

function readSetupEnv(file) {
  const text = readFileSync(file, "utf8");
  const value = (key) => text.match(new RegExp(`^${key}=(.*)$`, "m"))?.[1] ?? "";
  return { METERGRAPH_APP_TOKEN: value("METERGRAPH_APP_TOKEN"), METERGRAPH_INGEST_URL: value("METERGRAPH_INGEST_URL") };
}

function spawnSyncGitInit(project) {
  if (spawnSync("git", ["init", "-q"], { cwd: project, stdio: "ignore" }).status !== 0) throw new Error("git_init_failed");
}

function runChild(command, args, options) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { ...options, stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("close", (code) => resolve({ code, stdout, stderr }));
  });
}

// A loopback stand-in for the provider. It answers one chat completion shape
// and counts calls; no request leaves this machine.
function startMockProvider() {
  let calls = 0;
  const server = http.createServer((request, response) => {
    let body = "";
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      if (request.method !== "POST" || !request.url.endsWith("/chat/completions")) {
        response.writeHead(404).end();
        return;
      }
      calls += 1;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({
        id: `chatcmpl-parity-${calls}`, object: "chat.completion", created: Math.floor(now() / 1000),
        model: "parity-mock-model",
        choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
        usage: { prompt_tokens: 5, completion_tokens: 1, total_tokens: 6 },
      }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve({
      origin: `http://127.0.0.1:${server.address().port}`,
      calls: () => calls,
      close: () => new Promise((done) => server.close(done)),
    }));
  });
}
