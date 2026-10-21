// experiments list, estimate, start and get against the synthetic loopback
// service in test/fixtures/oauth-server.js, as a coding agent runs them with
// a key in its environment. Every value is synthetic. This proves the CLI's
// protocol and output only, not the real service.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";

import { LOCAL_ENV, checked, sandboxes } from "./auth-helpers.js";
import { runCli } from "./helpers.js";
import { EXPERIMENT_ID, WORKSPACE_A, startOAuthServer } from "./fixtures/oauth-server.js";

const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "metergraph experiments test "));
after(() => fs.rmSync(workDir, { recursive: true, force: true }));
const sandbox = sandboxes(workDir);

const METADATA_KEY = "mgak_synthetic_metadata_key_7777777777777777";
const START_KEY = "mgak_synthetic_start_key_8888888888888888";
const DEBUG_KEY = "mgak_synthetic_debug_key_9999999999999999";
const SSH = { SSH_CONNECTION: "192.0.2.1 50000 192.0.2.2 22" };
const ESTIMATE = [
  "experiments", "estimate", "--workload", "summarizeTicket",
  "--treatment", "openai/gpt-6-luna,label=Luna,temperature=0.2",
  "--treatment", "anthropic/claude-haiku-4-5,max_tokens=400,reasoning_effort=low",
  "--last-n", "12", "--track", "$.priority",
];
const SENT = {
  workload_id: "summarizeTicket",
  sample: { last_n: 12 },
  treatments: [
    { provider: "openai", model: "gpt-6-luna", label: "Luna", settings: { temperature: 0.2 } },
    { provider: "anthropic", model: "claude-haiku-4-5", settings: { max_tokens: 400, reasoning_effort: "low" } },
  ],
  tracked_fields: ["$.priority"],
};

async function withServer(behavior, work) {
  const server = await startOAuthServer({ agentTokens: [METADATA_KEY], startTokens: [START_KEY], ...behavior });
  try {
    return await work(server);
  } finally {
    await server.close();
  }
}

// Runs one experiments command with a key and checks that no key, marker or
// absolute path is printed or written.
async function run(server, args, { key = METADATA_KEY, json = true, env = {} } = {}) {
  const box = sandbox();
  const full = [...(json ? ["--json"] : []), ...args, "--project", box.project, "--config-dir", box.config];
  const keyEnv = key === null ? {} : { METERGRAPH_AGENT_TOKEN: key };
  const result = await runCli(full, { env: { ...LOCAL_ENV, ...SSH, METERGRAPH_URL: server.origin, ...keyEnv, ...env } });
  const { result: parsed } = checked(assert, result, { box, json });
  for (const secret of [METADATA_KEY, START_KEY, DEBUG_KEY]) {
    assert.ok(!result.stdout.includes(secret) && !result.stderr.includes(secret), "a key was printed");
  }
  assert.ok(!result.stdout.includes("SYNTHETIC_CONTENT_MARKER"), "content outside the contract was printed");
  return { run: result, result: parsed };
}

const sent = (server, before) => server.requests.slice(before).map((request) => `${request.method} ${request.path}`);

test("estimate sends exactly the parsed request and offers the start", () =>
  withServer({}, async (server) => {
    const before = server.requests.length;
    const { result } = await run(server, ESTIMATE);
    assert.equal(result.outcome, "ok");
    assert.equal(result.command, "experiments estimate");
    const [estimate] = server.requestsTo("/v1/agent/experiments/estimate");
    assert.deepEqual(JSON.parse(estimate.body), SENT);
    assert.deepEqual(sent(server, before).filter((line) => line.includes("experiments")), ["POST /v1/agent/experiments/estimate"]);
    const report = result.data.result;
    assert.equal(report.request.treatments[1].label, "Treatment B");
    assert.equal(report.estimate.sample.cases, 12);
    assert.deepEqual(report.estimate.sample.models_seen, { "gpt-5.4": 12 });
    assert.equal(report.start_granted, false);
    assert.equal(report.new_experiment_url, `${server.origin}/#experiments?workload=summarizeTicket&view=new&workspace=${WORKSPACE_A}`);
    assert.equal(result.data.next_action.kind, "start_experiment");
    assert.deepEqual(result.data.scopes, ["agent:metadata"]);
  }));

test("list and get read Metadata only, and get says when to poll", () =>
  withServer({ experimentStatus: "running" }, async (server) => {
    const listed = await run(server, ["experiments", "list", "--workload", "summarizeTicket", "--limit", "5"]);
    assert.equal(listed.result.outcome, "ok");
    assert.deepEqual(server.requestsTo("/v1/agent/experiments").at(-1).query, { workload_id: "summarizeTicket", limit: "5" });
    assert.equal(listed.result.data.result.experiments[0].id, EXPERIMENT_ID);
    assert.equal(listed.result.data.result.experiments[0].arms[0].model, "gpt-6-luna");

    const running = await run(server, ["experiments", "get", "--id", EXPERIMENT_ID]);
    assert.equal(running.result.data.result.experiment.terminal, false);
    assert.deepEqual(running.result.data.next_action, {
      kind: "poll_experiment",
      message: "The experiment is running. Run the same command again in about 15 seconds.",
      command: `metergraph experiments get --id ${EXPERIMENT_ID} --json`,
      poll_after_seconds: 15,
    });
  }));

test("a finished experiment shows statistics per arm next to production, and no content", () =>
  withServer({}, async (server) => {
    const { result } = await run(server, ["experiments", "get", "--id", EXPERIMENT_ID]);
    const experiment = result.data.result.experiment;
    assert.equal(experiment.status, "done");
    assert.equal(experiment.sample.replayed, 10);
    assert.deepEqual(experiment.sample.not_replayable_reasons, { tool_messages_unsupported: 2 });
    assert.equal(experiment.arms[0].statistics.latency_ms_p50, 420);
    assert.equal(experiment.arms[0].control_statistics.latency_ms_p50, 1800);
    assert.equal(experiment.control.statistics.same_keys_rate, 0.9);
    assert.equal(result.data.next_action.kind, "open_experiment");
    assert.equal(result.data.next_action.url, experiment.app_url);
    // Validated fields only: the settings seen and the stray previews are dropped.
    assert.equal(experiment.control.settings_seen, undefined);
    assert.equal(JSON.stringify(result).includes("case_previews"), false);

    const text = await run(server, ["experiments", "get", "--id", EXPERIMENT_ID], { json: false });
    assert.match(text.run.stdout, /Luna: openai\/gpt-6-luna \(temperature=0\.2\)/);
    assert.match(text.run.stdout, /production on Luna's cases/);
    assert.match(text.run.stdout, /they do not judge it/);
  }));

test("an unknown experiment and an over-budget estimate are refused with fixed text", () =>
  withServer({
    experimentsRaw(_request, response, urlPath) {
      if (urlPath !== "/v1/agent/experiments/estimate") return false;
      response.writeHead(422, { "content-type": "application/json" });
      response.end(JSON.stringify({ schema_version: "metergraph.agent-access/v1", error: {
        code: "precondition_failed", message: "SYNTHETIC_BODY_MARKER", reason: "over_budget",
        estimate_usd: 9.5, budget_usd: 5, arms: [{ label: "SYNTHETIC_BODY_MARKER" }],
      } }));
      return true;
    },
  }, async (server) => {
    const missing = await run(server, ["experiments", "get", "--id", "11111111-1111-4111-8111-111111111111"]);
    assert.equal(missing.result.outcome, "refused");
    assert.equal(missing.result.exit_code, 19);
    assert.equal(missing.result.error.reason, "experiment_not_found");
    assert.equal(missing.result.data.next_action.kind, "list_experiments");

    const over = await run(server, ESTIMATE);
    assert.equal(over.result.outcome, "refused");
    assert.equal(over.result.error.reason, "over_budget");
    assert.deepEqual(over.result.data.refusal, {
      code: "precondition_failed", reason: "over_budget", estimate_usd: 9.5, budget_usd: 5,
    });
    assert.equal(over.result.data.next_action.kind, "change_experiment");
  }));

test("start needs a start key: none or a Metadata key sends nothing", () =>
  withServer({}, async (server) => {
    const start = ["experiments", "start", ...ESTIMATE.slice(2)];
    let before = server.requests.length;
    const none = await run(server, start, { key: null });
    assert.equal(none.result.outcome, "permission_denied");
    assert.equal(none.result.error.reason, "experiment_start_key_required");
    assert.equal(none.result.data.next_action.kind, "use_experiment_start_key");
    assert.equal(none.result.data.next_action.url, `${server.origin}/#api-keys`);
    assert.deepEqual(sent(server, before), []);

    before = server.requests.length;
    const metadata = await run(server, start, { key: METADATA_KEY });
    assert.equal(metadata.result.outcome, "permission_denied");
    assert.equal(metadata.result.error.reason, "experiment_start_not_granted");
    // Verified, then refused: no experiment request was sent with it.
    assert.ok(!sent(server, before).some((line) => line.includes("/v1/agent/experiments")));
  }));

test("start with a start key sends one POST and hands back the experiment to poll", () =>
  withServer({}, async (server) => {
    const before = server.requests.length;
    const { result } = await run(server, ["experiments", "start", ...ESTIMATE.slice(2)], { key: START_KEY });
    assert.equal(result.outcome, "ok", JSON.stringify(result.error));
    assert.deepEqual(sent(server, before), [
      "GET /v1/deployment",
      "GET /v1/agent/workspace",
      "GET /v1/agent/capabilities",
      "POST /v1/agent/experiments",
    ]);
    const [posted] = server.requestsTo("/v1/agent/experiments");
    assert.equal(posted.headers.authorization, `Bearer ${START_KEY}`);
    assert.deepEqual(JSON.parse(posted.body), SENT);
    assert.equal(result.data.result.experiment.id, EXPERIMENT_ID);
    assert.equal(result.data.result.experiment.status, "queued");
    assert.deepEqual(result.data.scopes, ["agent:analysis-run", "agent:read"]);
    assert.equal(result.data.next_action.command, `metergraph experiments get --id ${EXPERIMENT_ID} --json`);
  }));

test("a start key also reads, and the reads send only their Metadata requests", () =>
  withServer({}, async (server) => {
    const before = server.requests.length;
    const { result } = await run(server, ["experiments", "list"], { key: START_KEY });
    assert.equal(result.outcome, "ok", JSON.stringify(result.error));
    assert.deepEqual(result.data.scopes, ["agent:analysis-run", "agent:read"]);
    assert.ok(sent(server, before).every((line) => line.startsWith("GET ")));
  }));

test("a Debug key with every workflow permission starts an experiment", () =>
  withServer({ debugTokens: [DEBUG_KEY] }, async (server) => {
    const { result } = await run(server, ["experiments", "start", ...ESTIMATE.slice(2)], { key: DEBUG_KEY });
    assert.equal(result.outcome, "ok", JSON.stringify(result.error));
    assert.deepEqual(result.data.scopes, ["agent:analysis-run", "agent:eval-preview", "agent:eval-write", "agent:read"]);
    assert.equal(server.requestsTo("/v1/agent/experiments").filter((request) => request.method === "POST").length, 1);
  }));

for (const extra of ["ingest", "agent:replay", "agent:metadata"]) {
  test(`a start key that also holds ${extra} cannot start`, () =>
    withServer({
      workspace: (doc) => (doc.access.scopes.includes("agent:read")
        ? { ...doc, access: { scopes: ["agent:analysis-run", "agent:read", extra] } } : doc),
    }, async (server) => {
      const { result } = await run(server, ["experiments", "start", ...ESTIMATE.slice(2)], { key: START_KEY });
      assert.equal(result.error.reason, "experiment_start_not_granted");
      assert.equal(server.requestsTo("/v1/agent/experiments").length, 0);
    }));
}

const START = ["experiments", "start", ...ESTIMATE.slice(2)];

test("a start the service may have recorded is unconfirmed, never a plain failure", async () => {
  const answers = [
    // A server error after the request arrived.
    (response) => { response.writeHead(500, { "content-type": "application/json" }); response.end("{}"); },
    // Accepted, but the answer does not match the contract.
    (response) => { response.writeHead(202, { "content-type": "application/json" }); response.end(JSON.stringify({ ok: true })); },
    ...[200, 201, 202, 204].flatMap((status) => ["", "{invalid"].map((body) =>
      (response) => { response.writeHead(status, { "content-type": "application/json" }); response.end(body); })),
    // The connection closes after the request was sent.
    (response) => response.socket.destroy(),
  ];
  for (const respond of answers) {
    await withServer({
      experimentsRaw(request, response, urlPath) {
        if (request.method !== "POST" || urlPath !== "/v1/agent/experiments") return false;
        respond(response);
        return true;
      },
    }, async (server) => {
      const { result } = await run(server, START, { key: START_KEY });
      assert.equal(result.outcome, "unconfirmed");
      assert.equal(result.exit_code, 20);
      assert.equal(result.error.reason, "experiment_start_unconfirmed");
      assert.equal(result.data.next_action.kind, "check_before_retry");
      assert.equal(result.data.next_action.command, "metergraph experiments list --json");
    });
  }
});

test("a start whose runner could not launch is not reported as started", () =>
  withServer({
    experiments: (doc, kind) => (kind === "start"
      ? { ...doc, experiment: { ...doc.experiment, status: "failed", terminal: true, error_code: "launch_failed" }, follow: null }
      : doc),
  }, async (server) => {
    const { result } = await run(server, START, { key: START_KEY });
    assert.equal(result.outcome, "unhealthy");
    assert.equal(result.error.reason, "experiment_launch_failed");
    assert.equal(result.data.result.experiment.error_code, "launch_failed");
    assert.equal(result.data.next_action.kind, "start_again_later");
  }));

test("experiments the service does not offer are not read", () =>
  withServer({
    capabilities: (doc) => ({ ...doc, agent: { ...doc.agent, experiment_estimate: { ...doc.agent.experiment_estimate, available: false } } }),
  }, async (server) => {
    const { result } = await run(server, ESTIMATE);
    assert.equal(result.outcome, "capability_unavailable");
    assert.equal(result.error.reason, "experiments_unavailable");
    assert.equal(server.requestsTo("/v1/agent/experiments/estimate").length, 0);
  }));

test("a service answer that does not echo the sent request is not printed", () =>
  withServer({
    experiments: (doc, kind) => (kind === "estimate"
      ? { ...doc, request: { ...doc.request, treatments: doc.request.treatments.map((arm) => ({ ...arm, model: "other" })) } }
      : doc),
  }, async (server) => {
    const { result } = await run(server, ESTIMATE);
    assert.equal(result.outcome, "verification_failed");
    assert.equal(result.error.reason, "request_mismatch");
    assert.equal(result.data.result, null);
  }));

test("a dashboard link to another origin or experiment is dropped", () =>
  withServer({
    experiments: (doc, kind) => (kind === "get"
      ? { ...doc, experiment: { ...doc.experiment, app_url: "https://evil.example.com/#experiments?id=x" } }
      : doc),
  }, async (server) => {
    const { result } = await run(server, ["experiments", "get", "--id", EXPERIMENT_ID]);
    assert.equal(result.outcome, "ok");
    assert.equal(result.data.result.experiment.app_url, null);
    assert.ok(result.data.notices.includes("experiment_link_omitted"));
  }));

test("malformed experiments arguments are refused before any request", async () => {
  for (const args of [
    ["experiments"],
    ["experiments", "estimate", "--workload", "w"],
    ["experiments", "estimate", "--workload", "w", "--treatment", "no-slash"],
    ["experiments", "estimate", "--workload", "w", "--treatment", "openai/gpt,temperature=3"],
    ["experiments", "estimate", "--workload", "w", "--treatment", "openai/gpt,label=control"],
    ["experiments", "estimate", "--workload", "w", "--treatment", "a/b", "--treatment", "a/b", "--treatment", "a/b", "--treatment", "a/b"],
    ["experiments", "estimate", "--workload", "w", "--treatment", "a/b", "--last-n", "41"],
    ["experiments", "get", "--id", "not-a-uuid"],
    ["experiments", "list", "--treatment", "a/b"],
    ["experiments", "list", "--workload", "\u00e9".repeat(400)],
  ]) {
    const result = await runCli(["--json", ...args], { offline: true, env: LOCAL_ENV });
    const parsed = JSON.parse(result.stdout);
    assert.equal(parsed.outcome, "invalid_input", args.join(" "));
    assert.ok(!result.stdout.includes("gpt,temperature=3"), "an argument value was echoed");
  }
});

test("an experiment whose treatment set extra request fields still lists and reads", () =>
  withServer({
    experiments: (doc, kind) => {
      const extra = { extra_params: { web_search_options: { search_context_size: "low" } } };
      if (kind === "list") {
        return { ...doc, experiments: doc.experiments.map((item) => ({
          ...item, arms: item.arms.map((arm) => ({ ...arm, settings: { ...arm.settings, ...extra } })),
        })) };
      }
      if (kind === "get") {
        return { ...doc, experiment: { ...doc.experiment, arms: doc.experiment.arms.map((arm) => ({
          ...arm, settings: { ...arm.settings, ...extra },
        })) } };
      }
      return doc;
    },
  }, async (server) => {
    const listed = await run(server, ["experiments", "list"]);
    assert.equal(listed.result.outcome, "ok");
    assert.deepEqual(listed.result.data.result.experiments[0].arms[0].settings.extra_params,
      { web_search_options: { search_context_size: "low" } });
    const text = await run(server, ["experiments", "get", "--id", EXPERIMENT_ID], { json: false });
    assert.match(text.run.stdout, /web_search_options\.search_context_size=low/);
  }));


test("capability discovery includes experiment reads and unavailable sensitive entries", () =>
  withServer({}, async (server) => {
    const { result } = await run(server, ["capabilities"]);
    assert.equal(result.outcome, "ok");
    const agent = result.data.result.agent;
    for (const name of ["experiments", "experiment_estimate", "experiment"]) assert.equal(agent[name].available, true);
    assert.equal(agent.experiment_cases.available, false);
    assert.equal(agent.experiment_start.available, false);
    assert.equal(agent.experiment_start.required_scope, "agent:analysis-run");
  }));

test("estimates reject arm identity mismatches and contradictory budget flags", async () => {
  const changes = [
    (doc) => { doc.estimate.arms.reverse(); },
    (doc) => { doc.estimate.arms[0].gateway_model = "openai/other"; },
    (doc) => { doc.estimate.arms[0].label = "Other"; },
    (doc) => { doc.estimate.over_budget = true; },
    (doc) => { doc.estimate.daily_budget_exhausted = true; },
    (doc) => { doc.blocking_reasons = ["over_budget"]; },
    (doc) => { doc.blocking_reasons = ["daily_budget_exhausted"]; },
  ];
  for (const change of changes) {
    await withServer({ experiments: (doc, kind) => {
      if (kind === "estimate") change(doc);
      return doc;
    } }, async (server) => {
      const { result } = await run(server, ESTIMATE);
      assert.equal(result.outcome, "verification_failed");
      assert.equal(result.error.reason, "experiment_estimate_invalid");
      assert.notEqual(result.data.next_action?.kind, "start_experiment");
    });
  }
});

test("a truncated list at the maximum does not suggest an invalid limit", () =>
  withServer({ experiments: (doc, kind) => {
    if (kind === "list") doc.page.truncated = true;
    return doc;
  } }, async (server) => {
    const { run: output } = await run(server, ["experiments", "list", "--limit", "50"], { json: false });
    assert.match(output.stdout, /only the newest results are shown/);
    assert.doesNotMatch(output.stdout, /raise --limit/);
  }));
