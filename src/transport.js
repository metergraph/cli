import http from "node:http";
import https from "node:https";

import { PACKAGE_NAME, VERSION } from "./constants.js";
import { classifyError } from "./http.js";

const USER_AGENT = `${PACKAGE_NAME}/${VERSION}`;

// Sends one request to a fixed path on an already validated origin and
// resolves (never rejects) with either
//   { kind: "response", status, headers, body, tooLarge }
//   { kind: "error", reason, status, sent }
// reason is a fixed token from classifyError. sent is true when the whole
// request had been handed to the network before the failure, so the server
// may have acted on it (for example consumed a refresh token).
// Redirects are returned with a null body and never followed. Bodies of every
// other status are read up to maxBytes; a larger body sets tooLarge and is
// discarded. The only credential ever sent is the bearer argument, and only
// to this origin. Nothing is taken from the environment, and no cookies are
// sent or kept.
export function send(origin, pathname, { method = "GET", signal, maxBytes, bearer = null, form = null, json = null }) {
  const url = new URL(pathname, origin);
  if (url.origin !== origin || url.pathname !== pathname || url.search !== "") {
    // Paths are constants from this package, so this is a programming error.
    throw new Error("request path is not a fixed path on the origin");
  }

  const headers = {
    accept: "application/json",
    "accept-encoding": "identity",
    "user-agent": USER_AGENT,
  };
  let payload = null;
  if (form !== null) {
    payload = Buffer.from(new URLSearchParams(form).toString());
    headers["content-type"] = "application/x-www-form-urlencoded";
  } else if (json !== null) {
    payload = Buffer.from(JSON.stringify(json));
    headers["content-type"] = "application/json";
  }
  if (payload !== null) headers["content-length"] = String(payload.length);
  if (bearer !== null) headers.authorization = `Bearer ${bearer}`;

  return new Promise((resolve) => {
    let settled = false;
    let status = null;
    let sent = false;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const fail = (error) => finish({ kind: "error", reason: classifyError(error, signal), status, sent });

    const transport = url.protocol === "https:" ? https : http;
    let request;
    try {
      request = transport.request(url, { method, agent: false, signal, headers });
    } catch (error) {
      fail(error);
      return;
    }

    request.on("finish", () => {
      sent = true;
    });
    request.on("error", fail);
    request.on("response", (response) => {
      response.on("error", fail);
      status = response.statusCode;
      const respond = (body, tooLarge) =>
        finish({ kind: "response", status, headers: response.headers, body, tooLarge });

      if (status >= 300 && status < 400) {
        respond(null, false);
        response.destroy();
        return;
      }
      const declared = response.headers["content-length"];
      if (declared !== undefined && Number(declared) > maxBytes) {
        respond(null, true);
        response.destroy();
        return;
      }
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          respond(null, true);
          response.destroy();
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => respond(Buffer.concat(chunks), false));
      // A close without end means the body was cut off.
      response.on("close", () => fail(null));
    });
    request.end(payload ?? undefined);
  });
}

// Maps a transport result that cannot be used to { outcome, reason }, or
// returns null when the response has a status the caller should inspect.
export function failureOf(response) {
  if (response.kind === "error") return { outcome: "connection_failed", reason: response.reason };
  const { status } = response;
  if (status >= 300 && status < 400) return { outcome: "redirect_rejected", reason: "redirect" };
  if (status === 503) return { outcome: "unhealthy", reason: "service_unavailable" };
  if (status >= 500) return { outcome: "unhealthy", reason: "server_error" };
  if (response.tooLarge) return { outcome: "unsupported", reason: "response_too_large" };
  return null;
}

// A deadline for one group of requests, optionally tied to a cancel signal.
// timedOut tells a deadline apart from a cancellation.
export function deadline(ms, cancel = null) {
  const timer = AbortSignal.timeout(ms);
  const signal = cancel === null ? timer : AbortSignal.any([timer, cancel]);
  return { signal, timedOut: () => timer.aborted };
}

// Turns SIGINT, SIGTERM and SIGHUP into a cancel signal for the duration of
// a command, so every listener, socket and lock is cleaned up and the
// outcome is reported truthfully instead of the process dying mid-step.
// release() must be called on every outcome.
export function trapSignals() {
  const controller = new AbortController();
  const names = ["SIGINT", "SIGTERM", "SIGHUP"];
  const onSignal = () => controller.abort();
  for (const name of names) process.on(name, onSignal);
  return {
    signal: controller.signal,
    release() {
      for (const name of names) process.removeListener(name, onSignal);
    },
  };
}
