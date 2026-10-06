// The loopback OAuth callback listener, exercised over real sockets.
import assert from "node:assert/strict";
import http from "node:http";
import { test } from "node:test";

import { startCallbackListener } from "../src/auth-callback.js";

const STATE = "synthetic-state-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const CODE = "synthetic-code-bbbbbbbbbbbbbbbbbbbbbbbb";
const ISSUER = "http://127.0.0.1:1/v1/oauth";
const enc = encodeURIComponent;
const valid = `/callback?code=${CODE}&state=${STATE}&iss=${enc(ISSUER)}`;

function hit(port, target, { method = "GET", host = `127.0.0.1:${port}` } = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port, path: target, method, headers: { host }, agent: false },
      (response) => {
        let body = "";
        response.setEncoding("utf8");
        response.on("data", (chunk) => (body += chunk));
        response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body }));
      },
    );
    request.on("error", reject);
    request.end();
  });
}

async function listen(options = {}) {
  const listener = await startCallbackListener();
  const url = new URL(listener.redirectUri);
  const waiting = listener.wait({
    state: STATE,
    issuer: ISSUER,
    requireIss: true,
    timeoutMs: 5000,
    cancel: null,
    ...options,
  });
  return { listener, url, port: Number(url.port), waiting };
}

test("binds 127.0.0.1 on an ephemeral port with a fixed callback path", async () => {
  const { listener, url, waiting } = await listen({ timeoutMs: 50 });
  try {
    assert.equal(url.protocol, "http:");
    assert.equal(url.hostname, "127.0.0.1");
    assert.equal(url.pathname, "/callback");
    assert.ok(Number(url.port) > 0);
    assert.equal(url.search, "");
    assert.deepEqual(await waiting, { kind: "timeout" });
  } finally {
    await listener.close();
  }
});

test("stray, forged and malformed requests are refused and the listener keeps waiting", async () => {
  const { listener, port, waiting } = await listen();
  try {
    const refused = [
      [valid, { host: `localhost:${port}` }, 400],
      [valid, { host: `127.0.0.1:${port + 1}` }, 400],
      [`/other?code=${CODE}&state=${STATE}`, {}, 404],
      [`/callback/?code=${CODE}&state=${STATE}`, {}, 404],
      [valid, { method: "POST" }, 405],
      [`/callback?code=${CODE}&state=${STATE}&state=${STATE}&iss=${enc(ISSUER)}`, {}, 400],
      [`/callback?code=${CODE}&state=forged&iss=${enc(ISSUER)}`, {}, 400],
      [`/callback?code=${CODE}&iss=${enc(ISSUER)}`, {}, 400],
      [`${valid}&extra=1`, {}, 400],
      [`/callback?code=${CODE}&state=${STATE}${"x".repeat(5000)}`, {}, 414],
    ];
    for (const [target, options, status] of refused) {
      const response = await hit(port, target, options);
      assert.equal(response.status, status);
      assert.ok(!response.body.includes(CODE), "a code was reflected");
      assert.ok(!response.body.includes(STATE), "a state was reflected");
    }

    const accepted = await hit(port, valid);
    assert.equal(accepted.status, 200);
    assert.ok(!accepted.body.includes(CODE) && !accepted.body.includes(STATE));
    assert.equal(accepted.headers["cache-control"], "no-store");
    assert.equal(accepted.headers["content-security-policy"], "default-src 'none'");
    assert.equal(accepted.headers["referrer-policy"], "no-referrer");
    assert.deepEqual(await waiting, { kind: "code", code: CODE });

    // A second delivery of the same callback cannot be used again.
    assert.equal((await hit(port, valid)).status, 410);
  } finally {
    await listener.close();
  }
  await assert.rejects(hit(port, valid), (error) => error.code === "ECONNREFUSED");
});

test("a matching callback without the advertised issuer, or with another, ends the flow as invalid", async () => {
  for (const target of [
    `/callback?code=${CODE}&state=${STATE}`,
    `/callback?code=${CODE}&state=${STATE}&iss=${enc("https://evil.example.com/v1/oauth")}`,
  ]) {
    const { listener, port, waiting } = await listen();
    try {
      assert.equal((await hit(port, target)).status, 400);
      assert.deepEqual(await waiting, { kind: "error", reason: "callback_issuer_mismatch" });
    } finally {
      await listener.close();
    }
  }
  // Without the metadata flag, a missing iss is accepted.
  const { listener, port, waiting } = await listen({ requireIss: false });
  try {
    assert.equal((await hit(port, `/callback?code=${CODE}&state=${STATE}`)).status, 200);
    assert.equal((await waiting).kind, "code");
  } finally {
    await listener.close();
  }
});

test("denial, server errors and contradictory callbacks are reported without their text", async () => {
  const cases = [
    [`/callback?error=access_denied&state=${STATE}&iss=${enc(ISSUER)}`, { kind: "denied" }],
    [
      `/callback?error=server_error&error_description=SYNTHETIC_BODY_MARKER&state=${STATE}&iss=${enc(ISSUER)}`,
      { kind: "error", reason: "authorization_error" },
    ],
    [`/callback?error=access_denied&code=${CODE}&state=${STATE}&iss=${enc(ISSUER)}`, { kind: "error", reason: "callback_invalid" }],
    [`/callback?code=&state=${STATE}&iss=${enc(ISSUER)}`, { kind: "error", reason: "callback_invalid" }],
    [`/callback?code=${"c".repeat(3000)}&state=${STATE}&iss=${enc(ISSUER)}`, { kind: "error", reason: "callback_invalid" }],
  ];
  for (const [target, expected] of cases) {
    const { listener, port, waiting } = await listen();
    try {
      const response = await hit(port, target);
      assert.ok(!response.body.includes("SYNTHETIC_BODY_MARKER"));
      assert.deepEqual(await waiting, expected);
    } finally {
      await listener.close();
    }
  }
});

test("timeout and cancellation end the wait truthfully and close cleanly", async () => {
  const started = Date.now();
  const timed = await listen({ timeoutMs: 200 });
  assert.deepEqual(await timed.waiting, { kind: "timeout" });
  assert.ok(Date.now() - started < 3000);
  await timed.listener.close();
  await timed.listener.close();

  const controller = new AbortController();
  const cancelled = await listen({ cancel: controller.signal });
  setTimeout(() => controller.abort(), 50);
  assert.deepEqual(await cancelled.waiting, { kind: "cancelled" });
  await cancelled.listener.close();

  const already = new AbortController();
  already.abort();
  const early = await listen({ cancel: already.signal });
  assert.deepEqual(await early.waiting, { kind: "cancelled" });
  await early.listener.close();
});

test("wait arms synchronously, so an immediate callback is accepted", async () => {
  const listener = await startCallbackListener();
  const port = Number(new URL(listener.redirectUri).port);
  try {
    // Before arming, nothing can end the flow.
    assert.equal((await hit(port, valid)).status, 503);
    const waiting = listener.wait({ state: STATE, issuer: ISSUER, requireIss: true, timeoutMs: 5000, cancel: null });
    // No delay of any kind between arming and the request.
    const response = await hit(port, valid);
    assert.equal(response.status, 200);
    assert.deepEqual(await waiting, { kind: "code", code: CODE });
    assert.throws(() => listener.wait({ state: STATE, issuer: ISSUER, requireIss: true, timeoutMs: 10, cancel: null }));
  } finally {
    await listener.close();
  }
});

test("close settles a pending wait as cancelled and leaves no timer behind", async () => {
  const timers = () => process.getActiveResourcesInfo().filter((name) => name === "Timeout").length;
  const before = timers();
  const listener = await startCallbackListener();
  const controller = new AbortController();
  const waiting = listener.wait({
    state: STATE,
    issuer: ISSUER,
    requireIss: true,
    timeoutMs: 600000,
    cancel: controller.signal,
  });
  assert.equal(timers(), before + 1);
  // An early return in the caller, such as a launcher that cannot start.
  await listener.close();
  assert.deepEqual(await waiting, { kind: "cancelled" });
  assert.equal(timers(), before, "the wait timer was left running");
  // A later abort is a no-op once settled.
  controller.abort();

  // Arming a closed listener cancels at once, without starting a timer.
  const closed = await startCallbackListener();
  await closed.close();
  assert.deepEqual(
    await closed.wait({ state: STATE, issuer: ISSUER, requireIss: true, timeoutMs: 600000, cancel: null }),
    { kind: "cancelled" },
  );
  assert.equal(timers(), before);
});

test("an open idle connection does not keep a closed listener alive", async () => {
  const { listener, port, waiting } = await listen({ timeoutMs: 100 });
  const net = await import("node:net");
  const socket = net.connect(port, "127.0.0.1");
  await new Promise((resolve) => socket.once("connect", resolve));
  assert.deepEqual(await waiting, { kind: "timeout" });
  const closed = new Promise((resolve) => socket.once("close", resolve));
  await listener.close();
  await closed;
});
