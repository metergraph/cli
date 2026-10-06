// The transport accepts a query only as a caller-built URLSearchParams, only on
// allowlisted read paths and only with each path's own keys, so no argument
// can choose another path, origin or header.
import assert from "node:assert/strict";
import { test } from "node:test";

import { send } from "../src/transport.js";
import { startServer } from "./helpers.js";

test("a query is sent only on allowlisted read paths with allowlisted keys", async () => {
  const server = await startServer({});
  try {
    const signal = AbortSignal.timeout(5000);
    const base = { signal, maxBytes: 1024 };
    const query = new URLSearchParams({ days: "7", limit: "2", route: "a&b=c/../x" });
    const response = await send(server.origin, "/v1/agent/traces", { ...base, query });
    assert.equal(response.kind, "response");
    assert.equal(server.requests[0].path, "/v1/agent/traces?days=7&limit=2&route=a%26b%3Dc%2F..%2Fx");

    const refused = [
      ["/v1/agent/routes", new URLSearchParams({ limit: "2" })],
      ["/v1/agent/workspace", new URLSearchParams({ days: "1" })],
      ["/v1/agent/usage", new URLSearchParams({ days: "1", route: "x" })],
      ["/v1/agent/usage", new URLSearchParams([["days", "1"], ["days", "2"]])],
      ["/v1/agent/usage", "days=1"],
      ["/v1/agent/usage", { days: "1" }],
      ["/v1/agent/usage?days=1", null],
      ["//evil.example.com/v1/agent/usage", new URLSearchParams({ days: "1" })],
      ["/v1/agent/traces", new URLSearchParams({ cursor: "x".repeat(3000) })],
    ];
    for (const [path, value] of refused) {
      assert.throws(() => send(server.origin, path, { ...base, query: value }));
    }
    assert.equal(server.requests.length, 1, "a refused request reached the network");
  } finally {
    await server.close();
  }
});
