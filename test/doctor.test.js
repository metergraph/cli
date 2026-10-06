import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FAKE_SECRETS,
  assertNoLeak,
  healthyRoutes,
  json,
  parseJsonLine,
  runCli,
  startServer,
} from "./helpers.js";

const GUIDE_URL = "https://www.metergraph.dev/docs/guides/agent-access/";

async function doctor(routes, extraArgs = []) {
  const server = await startServer(routes);
  try {
    const started = Date.now();
    const run = await runCli(["doctor", "--url", server.origin, "--json", ...extraArgs]);
    const elapsedMs = Date.now() - started;
    assert.equal(run.stderr, "", "JSON mode must keep stderr empty");
    assertNoLeak(assert, run.stdout, run.stderr);
    const result = parseJsonLine(run.stdout);
    assert.equal(result.exit_code, run.code);
    assert.equal(result.command, "doctor");
    assert.equal(result.data.authenticated, false);
    assert.equal(result.data.workspace, null);
    return { run, result, report: result.data, requests: server.requests, elapsedMs };
  } finally {
    await server.close();
  }
}

function delayed(ms, handler) {
  return (request, response) => {
    setTimeout(() => {
      if (!response.destroyed && !response.writableEnded) handler(request, response);
    }, ms);
  };
}

const checkResults = (report) => report.checks.map((check) => check.result);

for (const profile of ["managed", "local", "byoc-core"]) {
  test(`a supported ${profile} service that requires auth exits 3`, async () => {
    const routes = healthyRoutes(profile, {
      "/healthz": json(200, { ok: true }, {
        "x-debug": "SYNTHETIC_HEADER_MARKER",
        "set-cookie": "session=SYNTHETIC_HEADER_MARKER",
      }),
    });
    const { run, result, report, requests } = await doctor(routes);
    assert.equal(run.code, 3);
    assert.equal(result.ok, false);
    assert.equal(result.outcome, "authentication_required");
    assert.equal(result.error.code, "authentication_required");
    assert.equal(report.reachable, true);
    assert.equal(report.healthy, true);
    assert.equal(report.deployment_profile, profile);
    assert.equal(report.profile_status, "supported");
    assert.equal(report.authentication_required, true);
    assert.deepEqual(report.next_action, { kind: "connection_guide", url: GUIDE_URL });
    assert.deepEqual(checkResults(report), ["pass", "pass", "pass"]);

    assert.deepEqual(
      requests.map((request) => request.path),
      ["/healthz", "/v1/deployment", "/v1/agent/capabilities"],
    );
    for (const request of requests) {
      assert.equal(request.headers.authorization, undefined);
      assert.equal(request.headers.cookie, undefined);
      const sent = JSON.stringify(request.headers);
      for (const secret of Object.values(FAKE_SECRETS)) assert.ok(!sent.includes(secret));
    }
  });
}

test("terminal mode reports auth required and points at the connection guide", async () => {
  const server = await startServer(healthyRoutes("managed"));
  try {
    const run = await runCli(["doctor", "--url", server.origin]);
    assert.equal(run.code, 3);
    assert.equal(run.stderr, "");
    assert.match(run.stdout, /authentication_required \(exit 3\)/);
    assert.match(run.stdout, /No workspace is connected/);
    assert.ok(run.stdout.includes(GUIDE_URL));
    assertNoLeak(assert, run.stdout, run.stderr);
  } finally {
    await server.close();
  }
});

test("an unhealthy service exits 5 and skips later checks", async () => {
  for (const [handler, reason] of [
    [json(503, { ok: false, detail: "SYNTHETIC_BODY_MARKER" }), "service_unavailable"],
    [json(200, { ok: false }), "reported_unhealthy"],
    [json(500, { error: "SYNTHETIC_BODY_MARKER" }), "server_error"],
  ]) {
    const { run, result, report, requests } = await doctor(healthyRoutes("managed", { "/healthz": handler }));
    assert.equal(run.code, 5);
    assert.equal(result.outcome, "unhealthy");
    assert.equal(result.error.reason, reason);
    assert.equal(report.reachable, true);
    assert.equal(report.healthy, false);
    assert.equal(report.authentication_required, null);
    assert.deepEqual(checkResults(report), ["fail", "skipped", "skipped"]);
    assert.equal(requests.length, 1);
  }
});

test("non-JSON and malformed health responses exit 6 without echoing the body", async () => {
  const html = (request, response) => {
    response.writeHead(200, { "content-type": "text/html" });
    response.end("<html>SYNTHETIC_BODY_MARKER</html>");
  };
  const badJson = (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.end("{SYNTHETIC_BODY_MARKER");
  };
  const gzip = (request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-encoding": "gzip" });
    response.end('{"ok":true}');
  };
  for (const handler of [html, badJson, gzip, json(200, [true]), json(200, { status: "SYNTHETIC_BODY_MARKER" })]) {
    const { run, result, requests } = await doctor(healthyRoutes("managed", { "/healthz": handler }));
    assert.equal(run.code, 6);
    assert.equal(result.outcome, "unsupported");
    assert.equal(result.error.reason, "invalid_response");
    assert.equal(requests.length, 1);
  }
});

test("an oversized declared body is rejected", async () => {
  const big = (request, response) => {
    const body = JSON.stringify({ ok: true, padding: "x".repeat(64 * 1024) });
    response.writeHead(200, {
      "content-type": "application/json",
      "content-length": Buffer.byteLength(body),
    });
    response.end(body);
  };
  const { run, result } = await doctor(healthyRoutes("managed", { "/healthz": big }));
  assert.equal(run.code, 6);
  assert.equal(result.error.reason, "response_too_large");
});

test("an endless streamed body is cut off at the size limit", async () => {
  const endless = (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    const chunk = Buffer.alloc(4096, 0x20);
    const timer = setInterval(() => response.write(chunk), 5);
    response.on("close", () => clearInterval(timer));
  };
  const { run, result } = await doctor(healthyRoutes("managed", { "/healthz": endless }), [
    "--timeout-ms",
    "10000",
  ]);
  assert.equal(run.code, 6);
  assert.equal(result.error.reason, "response_too_large");
});

test("a server that never answers hits the total timeout", async () => {
  const hang = () => {};
  const { run, result, report, elapsedMs } = await doctor(healthyRoutes("managed", { "/healthz": hang }), [
    "--timeout-ms",
    "300",
  ]);
  assert.equal(run.code, 4);
  assert.equal(result.outcome, "connection_failed");
  assert.equal(result.error.reason, "timeout");
  assert.equal(report.reachable, false);
  assert.ok(elapsedMs < 5000, "timeout was not enforced");
});

test("a body that stalls after the headers hits the total timeout", async () => {
  const stall = (request, response) => {
    response.writeHead(200, { "content-type": "application/json" });
    response.write('{"ok":');
  };
  const { run, result, report } = await doctor(healthyRoutes("managed", { "/healthz": stall }), [
    "--timeout-ms",
    "300",
  ]);
  assert.equal(run.code, 4);
  assert.equal(result.outcome, "connection_failed");
  assert.equal(result.error.reason, "timeout");
  // The headers arrived, so the origin answered; health is still unknown.
  assert.equal(report.reachable, true);
  assert.equal(report.healthy, null);
  assert.equal(report.authentication_required, null);
  assert.equal(report.checks[0].result, "fail");
  assert.equal(report.checks[0].http_status, 200);
});

test("a truncated health body is a connection failure that keeps reachability", async () => {
  const truncate = (request, response) => {
    response.writeHead(200, { "content-type": "application/json", "content-length": "64" });
    response.write('{"ok":', () => response.socket.destroy());
  };
  const { run, result, report } = await doctor(healthyRoutes("managed", { "/healthz": truncate }), [
    "--timeout-ms",
    "10000",
  ]);
  assert.equal(run.code, 4);
  assert.equal(result.outcome, "connection_failed");
  assert.notEqual(result.error.reason, "timeout");
  assert.equal(report.reachable, true);
  assert.equal(report.healthy, null);
  assert.equal(report.checks[0].http_status, 200);
  assert.deepEqual(checkResults(report), ["fail", "skipped", "skipped"]);
});

test("a known status is reported at the headers even when its body stalls", async () => {
  const stalled = (status, headers = {}) => (request, response) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.write('{"detail":"SYNTHETIC_BODY_MARKER"');
  };
  const redirect = stalled(302, { location: "https://evil.example.com/SYNTHETIC_HEADER_MARKER" });
  const cases = [
    ["/healthz", stalled(503), 503, 5, "unhealthy", "service_unavailable", 0],
    ["/healthz", stalled(500), 500, 5, "unhealthy", "server_error", 0],
    ["/healthz", redirect, 302, 7, "redirect_rejected", "redirect", 0],
    ["/v1/deployment", redirect, 302, 7, "redirect_rejected", "redirect", 1],
    ["/v1/deployment", stalled(404), 404, 6, "unsupported", "deployment_endpoint_missing", 1],
  ];
  for (const [path, handler, status, code, outcome, reason, index] of cases) {
    const { run, result, report, elapsedMs } = await doctor(
      healthyRoutes("managed", { [path]: handler }),
      ["--timeout-ms", "10000"],
    );
    assert.equal(run.code, code);
    assert.equal(result.outcome, outcome);
    assert.equal(result.error.reason, reason);
    assert.equal(report.reachable, true);
    assert.equal(report.checks[index].result, "fail");
    assert.equal(report.checks[index].http_status, status);
    assert.equal(report.authentication_required, null);
    if (outcome === "unhealthy") assert.equal(report.healthy, false);
    assert.ok(elapsedMs < 5000, "a stalled body delayed a known status");
  }
});

test("the timeout covers the whole probe, not each request", async () => {
  const routes = healthyRoutes("managed");
  const slow = Object.fromEntries(
    Object.entries(routes).map(([path, handler]) => [path, delayed(400, handler)]),
  );
  // Two answers fit in the budget, the third does not.
  const { run, result, report } = await doctor(slow, ["--timeout-ms", "1000"]);
  assert.equal(run.code, 4);
  assert.equal(result.error.reason, "timeout");
  assert.deepEqual(checkResults(report), ["pass", "pass", "fail"]);
});

test("redirects are never followed and their targets are never echoed", async () => {
  const redirect = (request, response) => {
    response.writeHead(302, { location: "https://evil.example.com/SYNTHETIC_HEADER_MARKER" });
    response.end();
  };
  for (const path of ["/healthz", "/v1/deployment", "/v1/agent/capabilities"]) {
    const { run, result, requests } = await doctor(healthyRoutes("managed", { [path]: redirect }));
    assert.equal(run.code, 7);
    assert.equal(result.outcome, "redirect_rejected");
    assert.equal(requests.at(-1).path, path);
    assert.ok(requests.every((request) => !request.path.includes("SYNTHETIC")));
  }
});

test("an unknown deployment profile is unsupported and never echoed", async () => {
  for (const profile of ["SYNTHETIC_BODY_MARKER", "hosted", "staging", "Managed", ""]) {
    const { run, result, report, requests } = await doctor(healthyRoutes(profile));
    assert.equal(run.code, 6);
    assert.equal(result.error.reason, "unrecognized_profile");
    assert.equal(report.deployment_profile, null);
    assert.equal(report.profile_status, "unrecognized");
    assert.equal(report.authentication_required, null);
    assert.equal(requests.length, 2);
  }
});

test("a server without the deployment endpoint is not labelled hosted", async () => {
  const routes = healthyRoutes("managed");
  delete routes["/v1/deployment"];
  const { run, result, report } = await doctor(routes);
  assert.equal(run.code, 6);
  assert.equal(result.error.reason, "deployment_endpoint_missing");
  assert.equal(report.deployment_profile, null);
  assert.equal(report.profile_status, "unavailable");
});

test("a malformed deployment response is unsupported", async () => {
  for (const handler of [json(200, { profile: "managed" }), json(200, { deployment_profile: 7 })]) {
    const { run, result } = await doctor(healthyRoutes("managed", { "/v1/deployment": handler }));
    assert.equal(run.code, 6);
    assert.equal(result.error.reason, "invalid_response");
  }
});

test("capabilities without a bearer challenge or without auth are unsupported", async () => {
  const cases = [
    [json(401, {}, { "www-authenticate": 'Basic realm="SYNTHETIC_CHALLENGE_MARKER"' }), "unexpected_auth_challenge"],
    [json(401, {}), "unexpected_auth_challenge"],
    [json(200, { tools: ["SYNTHETIC_BODY_MARKER"] }), "unexpected_unauthenticated_access"],
    [json(403, {}), "unexpected_status"],
  ];
  for (const [handler, reason] of cases) {
    const { run, result, report } = await doctor(
      healthyRoutes("managed", { "/v1/agent/capabilities": handler }),
    );
    assert.equal(run.code, 6);
    assert.equal(result.error.reason, reason);
    assert.equal(report.next_action, null);
  }
});

test("only a real Bearer challenge scheme counts, never a quoted value or parameter", async () => {
  const accepted = [
    "Bearer",
    'bearer realm="SYNTHETIC_CHALLENGE_MARKER"',
    'Basic realm="example", Bearer realm="SYNTHETIC_CHALLENGE_MARKER", error="invalid_token"',
    'Newauth realm="apps", type=1, title="Login to \\"apps\\"", Basic realm="simple", Bearer',
    'Basic realm="ends in backslash\\\\", Bearer realm="SYNTHETIC_CHALLENGE_MARKER"',
    "Bearer c3ludGhldGlj==",
  ];
  const rejected = [
    'Basic realm="example, Bearer fake-value"',
    'Basic realm="SYNTHETIC_CHALLENGE_MARKER, Bearer"',
    'Basic realm="say \\"hi\\", Bearer x"',
    'Basic realm="escaped quote\\", Bearer realm=x"',
    'Basic realm="example", Bearer = "fake-value"',
    "Basic Bearer=fake-value",
    'Bearer realm="unterminated',
    'Bearer realm="trailing escape\\',
    'Basic realm="example" Bearer',
    'Bearer realm="example"junk',
  ];
  for (const [challenges, accept] of [[accepted, true], [rejected, false]]) {
    for (const challenge of challenges) {
      const routes = healthyRoutes("managed", {
        "/v1/agent/capabilities": json(401, {}, { "www-authenticate": challenge }),
      });
      const { run, result, report } = await doctor(routes);
      assert.ok(!run.stdout.includes(challenge), "the challenge header was echoed");
      if (accept) {
        assert.equal(run.code, 3, challenge);
        assert.equal(result.outcome, "authentication_required");
        assert.equal(report.authentication_required, true);
        assert.deepEqual(report.next_action, { kind: "connection_guide", url: GUIDE_URL });
      } else {
        assert.equal(run.code, 6, challenge);
        assert.equal(result.outcome, "unsupported");
        assert.equal(result.error.reason, "unexpected_auth_challenge");
        assert.equal(report.authentication_required, null);
        assert.equal(report.next_action, null);
      }
      assert.equal(report.checks[2].http_status, 401);
    }
  }
});

test("a refused connection exits 4 and reports the origin unreachable", async () => {
  const server = await startServer({});
  const origin = server.origin;
  await server.close();
  const run = await runCli(["doctor", "--url", origin, "--json", "--timeout-ms", "2000"]);
  assert.equal(run.code, 4);
  assert.equal(run.stderr, "");
  const result = parseJsonLine(run.stdout);
  assert.equal(result.outcome, "connection_failed");
  assert.equal(result.error.reason, "connection_refused");
  assert.equal(result.data.reachable, false);
  assert.equal(result.data.authenticated, false);
  assert.equal(result.data.workspace, null);
  assertNoLeak(assert, run.stdout, run.stderr);
});

test("a dropped connection is a connection failure without exception text", async () => {
  const drop = (request) => request.socket.destroy();
  const { run, result } = await doctor(healthyRoutes("managed", { "/healthz": drop }));
  assert.equal(run.code, 4);
  assert.equal(result.outcome, "connection_failed");
  assert.ok(!run.stdout.includes("socket hang up"));
});
