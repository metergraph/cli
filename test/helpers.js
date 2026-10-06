import { spawn } from "node:child_process";
import http from "node:http";
import { fileURLToPath, pathToFileURL } from "node:url";

export const BIN = fileURLToPath(new URL("../bin/metergraph.js", import.meta.url));
const NO_NETWORK = pathToFileURL(
  fileURLToPath(new URL("./fixtures/no-network.js", import.meta.url)),
).href;

// Fixed fake values. A test fails if any of them appears in CLI output.
export const FAKE_SECRETS = Object.freeze({
  METERGRAPH_API_KEY: "mg_fake_key_0000000000000000",
  METERGRAPH_TOKEN: "fake-token-1111111111111111",
  OPENAI_API_KEY: "sk-fake-2222222222222222",
  ANTHROPIC_API_KEY: "sk-ant-fake-3333333333333333",
  AWS_SECRET_ACCESS_KEY: "fakeAwsSecret4444444444444444",
});

// Markers planted in fixture bodies, headers and arguments. None may be echoed.
export const MARKERS = Object.freeze([
  "SYNTHETIC_BODY_MARKER",
  "SYNTHETIC_HEADER_MARKER",
  "SYNTHETIC_CHALLENGE_MARKER",
  "https://evil.example.com",
  "hunter2",
  ...Object.values(FAKE_SECRETS),
]);

// Runs the CLI as a subprocess. stdin is an open pipe that is never written
// or closed, so a CLI that waits on stdin would hang and fail the test.
// imports are extra modules preloaded with --import, bin replaces the CLI
// entry point (for example a tampered copy), and env adds variables.
export function runCli(
  args,
  { offline = false, timeoutMs = 20000, cwd, imports = [], bin = BIN, env = {} } = {},
) {
  const preload = [...(offline ? [NO_NETWORK] : []), ...imports].flatMap((url) => ["--import", url]);
  const nodeArgs = [...preload, bin, ...args];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, nodeArgs, {
      cwd,
      env: { ...process.env, ...FAKE_SECRETS, NO_COLOR: "1", ...env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error("CLI subprocess did not exit in time"));
    }, timeoutMs);
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });
}

export function parseJsonLine(stdout) {
  const lines = stdout.split("\n");
  if (lines.length !== 2 || lines[1] !== "") {
    throw new Error("expected exactly one line of stdout");
  }
  return JSON.parse(lines[0]);
}

export function assertNoLeak(assert, ...texts) {
  for (const text of texts) {
    for (const marker of MARKERS) {
      assert.ok(!text.includes(marker), "CLI output contains a planted secret or marker");
    }
  }
}

// Starts a loopback HTTP server. routes maps a path to a handler
// (request, response) => void. Unknown paths answer 404. Every request path
// is recorded in server.requests.
export async function startServer(routes) {
  const requests = [];
  const sockets = new Set();
  const server = http.createServer((request, response) => {
    requests.push({ path: request.url, headers: request.headers });
    const handler = routes[request.url];
    if (handler) {
      handler(request, response);
    } else {
      response.writeHead(404, { "content-type": "application/json" });
      response.end('{"error":"not_found"}');
    }
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    port,
    requests,
    async close() {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

export function json(status, body, headers = {}) {
  return (request, response) => {
    response.writeHead(status, { "content-type": "application/json", ...headers });
    response.end(JSON.stringify(body));
  };
}

// The contract of a healthy, supported, auth-protected service.
export function healthyRoutes(profile = "managed", overrides = {}) {
  return {
    "/healthz": json(200, { ok: true }),
    "/v1/deployment": json(200, {
      deployment_profile: profile,
      cloud: { provider: "example" },
      capabilities: { agent: true },
    }),
    "/v1/agent/capabilities": json(
      401,
      { error: "unauthorized", detail: "SYNTHETIC_BODY_MARKER" },
      { "www-authenticate": 'Bearer realm="SYNTHETIC_CHALLENGE_MARKER"' },
    ),
    ...overrides,
  };
}
