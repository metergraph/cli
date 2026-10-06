import assert from "node:assert/strict";
import { test } from "node:test";

import { parseOrigin } from "../src/origin.js";

test("accepts bare https origins and normalizes them", () => {
  assert.equal(parseOrigin("https://metergraph.example.com"), "https://metergraph.example.com");
  assert.equal(parseOrigin("https://metergraph.example.com/"), "https://metergraph.example.com");
  assert.equal(parseOrigin("HTTPS://Metergraph.Example.COM"), "https://metergraph.example.com");
  assert.equal(parseOrigin("https://example.com:8443"), "https://example.com:8443");
  assert.equal(parseOrigin("https://example.com:443"), "https://example.com");
});

test("accepts plain http only for canonical loopback hosts", () => {
  assert.equal(parseOrigin("http://localhost:8080"), "http://localhost:8080");
  assert.equal(parseOrigin("http://127.0.0.1:3000/"), "http://127.0.0.1:3000");
  assert.equal(parseOrigin("http://[::1]:3000"), "http://[::1]:3000");
  assert.equal(parseOrigin("http://localhost"), "http://localhost");
});

test("rejects plain http to any other host", () => {
  for (const input of [
    "http://example.com",
    "http://metergraph.example.com:8080",
    "http://127.1:3000",
    "http://0x7f000001",
    "http://127.0.0.2",
    "http://localhost.example.com",
    "http://[::ffff:127.0.0.1]",
  ]) {
    assert.equal(parseOrigin(input), null, "expected an unsafe http origin to be rejected");
  }
});

test("rejects credentials, paths, queries, fragments and other schemes", () => {
  for (const input of [
    "https://user:hunter2@example.com",
    "https://user@example.com",
    "https://example.com/app",
    "https://example.com/v1/deployment",
    "https://example.com?token=hunter2",
    "https://example.com/?token=hunter2",
    "https://example.com#hunter2",
    "https://example.com\\@evil.example.com",
    "ftp://example.com",
    "file:///etc/hosts",
    "javascript:alert(1)",
    "example.com",
    "//example.com",
    "https://",
    "https://example.com:0",
    "https://example.com:99999",
    "https://exa mple.com",
    "https://example.com\n",
    "",
    "https://" + "a".repeat(3000) + ".example.com",
  ]) {
    assert.equal(parseOrigin(input), null, "expected an unsafe origin to be rejected");
  }
});

test("rejects non-string input", () => {
  assert.equal(parseOrigin(undefined), null);
  assert.equal(parseOrigin(null), null);
  assert.equal(parseOrigin(42), null);
});
