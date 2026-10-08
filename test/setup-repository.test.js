import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { BROWSER, LOCAL_ENV, login, sandboxes } from "./auth-helpers.js";
import { assertNoLeak, parseJsonLine, runCli } from "./helpers.js";
import { startOAuthServer } from "./fixtures/oauth-server.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph setup repository test "));
after(() => fs.rmSync(dir, { recursive: true, force: true }));
const boxFor = sandboxes(dir);
process.env.GIT_CEILING_DIRECTORIES = dir;
const SECRET = "remote-credential-value";
// An empty global config: Git for Windows cannot read os.devNull as one.
const GIT_CONFIG = path.join(dir, "gitconfig");
fs.writeFileSync(GIT_CONFIG, "");
const GIT_ENV = { ...process.env, GIT_CONFIG_GLOBAL: GIT_CONFIG, GIT_CONFIG_NOSYSTEM: "1" };

function gitProject(box, remote) {
  for (const args of [["init", "-q"], ...(remote ? [["remote", "add", "origin", remote]] : [])]) {
    const result = spawnSync("git", args, { cwd: box.project, env: GIT_ENV, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  }
}

async function setup(box, server, extra = [], { json = true } = {}) {
  const run = await runCli([...(json ? ["--json"] : []), "setup", "--runtime", "local", "--project", box.project,
    "--config-dir", box.config, "--deployment", "customer-local", "--confirm-prerequisites",
    "--url", server.origin, "--workspace", server.behavior.workspaceId, "--skip-skill", ...extra],
  { imports: [BROWSER], env: { ...LOCAL_ENV, GIT_CONFIG_GLOBAL: GIT_CONFIG, GIT_CONFIG_NOSYSTEM: "1",
    GIT_CEILING_DIRECTORIES: dir,
    METERGRAPH_TEST_BROWSER: "follow", METERGRAPH_TEST_BROWSER_LOG: box.log } });
  assertNoLeak(assert, run.stdout, run.stderr);
  for (const secret of [...server.issued, SECRET]) {
    assert.ok(!run.stdout.includes(secret) && !run.stderr.includes(secret), "a secret was printed");
  }
  return json ? parseJsonLine(run.stdout) : run;
}

const config = (box) => path.join(box.project, ".metergraph", "config.json");

test("setup records the git remote's owner/name once and reports it", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    gitProject(box, `https://user:${SECRET}@example.com/example-org/example-app.git`);
    assert.equal((await login(assert, box, server)).result.ok, true);
    const first = await setup(box, server);
    assert.equal(first.outcome, "ok");
    assert.deepEqual(first.data.repository, { status: "written", repository: "example-org/example-app",
      source: "git_remote", path: ".metergraph/config.json", reason: null });
    assert.deepEqual(JSON.parse(fs.readFileSync(config(box), "utf8")), { version: 2, repository: "example-org/example-app" });
    assert.ok(!fs.readFileSync(config(box), "utf8").includes(SECRET));

    // A rerun keeps the file byte for byte and needs no new approval.
    const before = fs.readFileSync(config(box));
    const authorizations = server.requestsTo("/v1/cli/setup/authorize").length;
    const second = await setup(box, server);
    assert.equal(second.outcome, "ok");
    assert.equal(second.data.repository.status, "existing");
    assert.ok(fs.readFileSync(config(box)).equals(before));
    assert.equal(server.requestsTo("/v1/cli/setup/authorize").length, authorizations);

    // A different explicit value is reported and never written.
    const third = await setup(box, server, ["--repository", "example-org/renamed-app"]);
    assert.equal(third.outcome, "ok");
    assert.equal(third.data.repository.status, "mismatch");
    assert.equal(third.data.repository.expected, "example-org/renamed-app");
    assert.ok(fs.readFileSync(config(box)).equals(before));

    const human = await setup(box, server, [], { json: false });
    assert.match(human.stdout, /^Repository: example-org\/example-app \(already set in \.metergraph\/config\.json\)$/m);
  } finally { await server.close(); }
});

test("--repository records an identity outside a git checkout and --no-repository records none", async () => {
  const server = await startOAuthServer({ setup: true });
  try {
    const box = boxFor();
    assert.equal((await login(assert, box, server)).result.ok, true);
    const skipped = await setup(box, server, ["--no-repository"]);
    assert.equal(skipped.outcome, "ok");
    assert.equal(skipped.data.repository.status, "skipped");
    assert.ok(!fs.existsSync(config(box)));
    const inferred = await setup(box, server);
    assert.equal(inferred.data.repository.status, "not_inferred");
    assert.ok(!fs.existsSync(config(box)));
    const written = await setup(box, server, ["--repository", "example-org/example-app"]);
    assert.equal(written.data.repository.status, "written");
    assert.equal(written.data.repository.source, "flag");
    assert.equal(JSON.parse(fs.readFileSync(config(box), "utf8")).repository, "example-org/example-app");
  } finally { await server.close(); }
});

test("invalid or conflicting repository options fail before any sign in", async () => {
  const box = boxFor();
  for (const [extra, reason] of [[["--repository", "example-app"], "invalid_repository"],
    [["--repository", "example-org/example-app", "--no-repository"], "repository_conflict"]]) {
    const run = await runCli(["--json", "setup", "--runtime", "local", "--project", box.project,
      "--config-dir", box.config, "--skip-skill", ...extra], { env: LOCAL_ENV });
    const result = parseJsonLine(run.stdout);
    assert.equal(result.ok, false);
    assert.equal(result.error.reason, reason);
  }
  assert.ok(!fs.existsSync(path.join(box.project, ".metergraph")));
});
