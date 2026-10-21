// Opt-in end-to-end checks against the actual core engine, not fixture responses.
// PRICING_PYTHON points to an isolated Python with metergraph-core==0.5.0.
// PRICING_BIN optionally points to the installed CLI's bin for package checks.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
const python = process.env.PRICING_PYTHON;
if (!python) throw new Error("Set PRICING_PYTHON to an isolated Python with metergraph-core==0.5.0 installed.");
const adapter = fileURLToPath(new URL("./pricing-server.py", import.meta.url));
const bin = process.env.PRICING_BIN ?? fileURLToPath(new URL("../bin/metergraph.js", import.meta.url));
const server = spawn(python, [adapter, "--port", "0"], { stdio: ["ignore", "pipe", "pipe"] });
let errors = "";
server.stderr.on("data", (chunk) => (errors += chunk));
async function cli(args, json = true) {
  const child = spawn(
    process.execPath,
    [bin, "pricing", ...args, "--api", "reference", "--at", "2026-10-20", "--url", origin, ...(json ? ["--json"] : [])],
    { stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, NO_COLOR: "1" } },
  );
  let out = "",
    err = "";
  child.stdout.on("data", (c) => (out += c));
  child.stderr.on("data", (c) => (err += c));
  const [code] = await once(child, "exit");
  assert.equal(code, 0, `${args.join(" ")}: ${out} ${err}`);
  assert.equal(err, "");
  return json ? JSON.parse(out).data : out;
}
let origin;
const timer = setTimeout(() => server.kill(), 30000);
try {
  origin = await new Promise((resolve, reject) => {
    let output = "";
    server.stdout.on("data", (chunk) => {
      output += chunk;
      const m = output.match(/http:\/\/127\.0\.0\.1:\d+/);
      if (m) resolve(m[0]);
    });
    server.on("exit", () => reject(new Error(`Adapter exited: ${errors}`)));
    server.on("error", reject);
  });
  const selectors = ["--model", "openai/gpt-6-sol", "--channel", "openai-api"];
  const lookup = await cli(["lookup", ...selectors]);
  assert.equal(lookup.catalog.core_version, "0.5.0");
  assert.equal(lookup.result.price.input_per_mtok, "2.0");
  const base = ["cost", ...selectors, "--input-tokens", "1000", "--output-tokens", "200"];
  const cost = await cli(base);
  assert.equal(cost.result.cost, "0.00400000");
  const batch = await cli([...base, "--batch"]);
  assert.equal(batch.result.cost, "0.00200000");
  const cached = await cli([...base, "--cache-read-tokens", "500"]);
  assert.equal(cached.result.cost, "0.00310000");
  const partial = await cli(["cost", ...selectors, "--input-tokens", "1000"]);
  assert.equal(partial.result.status, "partial");
  assert.ok(partial.result.missing_dimensions.includes("output_tokens"));
  const unknown = await cli(["lookup", "--model", "example/nonexistent", "--channel", "openai-api"]);
  assert.equal(unknown.result.status, "unpriced");
  const noChannel = await cli(["lookup", "--model", "openai/gpt-6-sol"]);
  assert.deepEqual(noChannel.result.missing_dimensions, ["channel"]);
  const history = await cli(["history", "--model", "openai/gpt-5.6-terra", "--channel", "openai-api"]);
  assert.ok(history.result.series[0].points.length >= 2);
  const market = await cli(["market", "--channel", "openai-api", "--limit", "5"]);
  assert.equal(market.result.series.length, 5);
  assert.equal(market.result.truncated, true);
  const chart = await cli(["history", "--model", "openai/gpt-5.6-terra", "--channel", "openai-api"], false);
  assert.match(chart, /linear UTC time/);
  const html = await cli(
    ["history", "--model", "openai/gpt-5.6-terra", "--channel", "openai-api", "--format", "html"],
    false,
  );
  assert.match(html, /<svg/);
  const table = await cli(["market", "--channel", "openai-api", "--limit", "5"], false);
  assert.match(table, /USD/);
  const invalid = await fetch(`${origin}/v1/pricing/cost?model=a&at=2026-10-20&input_tokens=-1`);
  assert.equal(invalid.status, 400);
  console.log(`13 core-backed checks passed (${lookup.catalog.core_version}, catalog ${lookup.catalog.version}).`);
} finally {
  clearTimeout(timer);
  server.kill();
}
