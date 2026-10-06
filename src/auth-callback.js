import { timingSafeEqual } from "node:crypto";
import http from "node:http";

// Loopback listener for the OAuth redirect (RFC 8252 section 7.3). It binds
// 127.0.0.1 on an ephemeral port and accepts exactly one callback: a GET on
// the fixed path, with the exact Host, one state that matches, and either one
// code or one error. Anything else is answered with a fixed page and the
// listener keeps waiting, so a stray or forged request cannot end the flow.
// Pages are static: no code, state or other request value is reflected, and
// nothing about a request is logged.

export const CALLBACK_PATH = "/callback";
const HOST = "127.0.0.1";
const MAX_URL_LENGTH = 4096;
const MAX_CODE_LENGTH = 2048;
const ALLOWED_PARAMS = new Set(["code", "state", "error", "error_description", "error_uri", "iss"]);

const PAGE_HEADERS = {
  "content-type": "text/html; charset=utf-8",
  "cache-control": "no-store",
  "content-security-policy": "default-src 'none'",
  "referrer-policy": "no-referrer",
  "x-content-type-options": "nosniff",
  "x-frame-options": "DENY",
  connection: "close",
};
const page = (text) =>
  `<!doctype html><meta charset="utf-8"><title>Metergraph CLI</title><p>${text}</p>\n`;
const PAGES = {
  done: page("Metergraph CLI: authorization received. You can close this tab and return to the terminal."),
  failed: page("Metergraph CLI: authorization did not complete. Return to the terminal for details."),
  invalid: page("Metergraph CLI: this request was not accepted."),
};

// Starts listening. Resolves with { redirectUri, wait, close }.
//   wait({ state, issuer, requireIss, timeoutMs, cancel }) arms the listener
//     synchronously: from the moment it returns, a matching callback is
//     accepted and the timeout is running. Call it before the authorization
//     URL is opened or printed, so a fast browser can never reach an unarmed
//     listener. It may be called once. The promise resolves with
//     { kind: "code", code }
//     { kind: "denied" }                  the user or server declined
//     { kind: "error", reason }           authorization_error,
//                                         callback_issuer_mismatch or
//                                         callback_invalid
//     { kind: "timeout" } or { kind: "cancelled" }
//   close() stops the listener, destroys every socket and settles a pending
//   wait as cancelled, clearing its timer. It is safe to call more than once
//   and must be called on every outcome, including early returns.
export async function startCallbackListener() {
  const sockets = new Set();
  let handler = (request, response) => respond(response, 503, PAGES.invalid);
  const server = http.createServer(
    { maxHeaderSize: 8192, requestTimeout: 10000, headersTimeout: 10000 },
    (request, response) => handler(request, response),
  );
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  server.on("clientError", (error, socket) => socket.destroy());

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, HOST, () => {
      server.removeListener("error", reject);
      resolve();
    });
  });
  const { port } = server.address();
  const host = `${HOST}:${port}`;
  const redirectUri = `http://${host}${CALLBACK_PATH}`;

  let closed = false;
  let armed = false;
  // Settles the pending wait, if any. Replaced when wait() arms.
  let settlePending = () => {};

  const close = async () => {
    settlePending({ kind: "cancelled" });
    if (closed) return;
    closed = true;
    const done = new Promise((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await done;
  };

  const wait = ({ state, issuer, requireIss, timeoutMs, cancel }) => {
    if (armed) throw new Error("callback listener is already armed");
    armed = true;
    // The executor runs synchronously, so the handler and timer are in
    // place before wait() returns.
    return new Promise((resolve) => {
      let settled = false;
      let timer = null;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        if (timer !== null) clearTimeout(timer);
        cancel?.removeEventListener("abort", onCancel);
        resolve(result);
      };
      const onCancel = () => finish({ kind: "cancelled" });
      settlePending = finish;

      handler = (request, response) => {
        if (settled) return respond(response, 410, PAGES.invalid);
        const verdict = inspect(request, { host, state, issuer, requireIss });
        if (verdict.result === undefined) return respond(response, verdict.status, PAGES.invalid);
        const result = verdict.result;
        respond(response, verdict.status, result.kind === "code" ? PAGES.done : PAGES.failed);
        finish(result);
      };

      if (closed || cancel?.aborted) {
        onCancel();
        return;
      }
      timer = setTimeout(() => finish({ kind: "timeout" }), timeoutMs);
      cancel?.addEventListener("abort", onCancel, { once: true });
    });
  };

  return { redirectUri, wait, close };
}

function respond(response, status, body) {
  response.writeHead(status, { ...PAGE_HEADERS, "content-length": Buffer.byteLength(body) });
  response.end(body);
}

// Returns { status } for a request that is ignored, or { status, result }
// for the one request that ends the flow.
function inspect(request, { host, state, issuer, requireIss }) {
  const url = request.url ?? "";
  if (url.length > MAX_URL_LENGTH) return { status: 414 };
  if (request.method !== "GET") return { status: 405 };
  if (request.headers.host !== host) return { status: 400 };
  const mark = url.indexOf("?");
  const pathname = mark === -1 ? url : url.slice(0, mark);
  if (pathname !== CALLBACK_PATH) return { status: 404 };

  let params;
  try {
    params = new URLSearchParams(mark === -1 ? "" : url.slice(mark + 1));
  } catch {
    return { status: 400 };
  }
  const seen = new Set();
  for (const key of params.keys()) {
    if (!ALLOWED_PARAMS.has(key) || seen.has(key)) return { status: 400 };
    seen.add(key);
  }
  // Only a request that carries this flow's exact state can end it.
  if (!seen.has("state") || !sameText(params.get("state"), state)) return { status: 400 };

  if (seen.has("iss") ? params.get("iss") !== issuer : requireIss) {
    return { status: 400, result: { kind: "error", reason: "callback_issuer_mismatch" } };
  }
  if (seen.has("error")) {
    if (seen.has("code")) return { status: 400, result: { kind: "error", reason: "callback_invalid" } };
    return params.get("error") === "access_denied"
      ? { status: 200, result: { kind: "denied" } }
      : { status: 200, result: { kind: "error", reason: "authorization_error" } };
  }
  const code = params.get("code");
  if (code === null || code.length === 0 || code.length > MAX_CODE_LENGTH || /[^\x21-\x7e]/.test(code)) {
    return { status: 400, result: { kind: "error", reason: "callback_invalid" } };
  }
  return { status: 200, result: { kind: "code", code } };
}

function sameText(actual, expected) {
  const a = Buffer.from(actual);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
