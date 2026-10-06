import http from "node:http";
import https from "node:https";

import { MAX_BODY_BYTES, PACKAGE_NAME, VERSION } from "./constants.js";

const USER_AGENT = `${PACKAGE_NAME}/${VERSION}`;

const DNS_ERRORS = new Set(["ENOTFOUND", "EAI_AGAIN", "EAI_FAIL", "EAI_NONAME"]);
const REFUSED_ERRORS = new Set(["ECONNREFUSED"]);
const RESET_ERRORS = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED"]);
const UNREACHABLE_ERRORS = new Set(["EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"]);

// Sends one unauthenticated GET and resolves (never rejects) with either
//   { kind: "response", status, headers, body, tooLarge }
//   { kind: "error", reason, status }
// where reason is a fixed token from classifyError, and status is the HTTP
// status when the headers arrived before the failure (a body timeout, reset or
// truncation), otherwise null. Redirects are returned as ordinary responses
// and never followed. Only fixed headers are sent: no cookies, no
// authorization and nothing taken from the environment.
// The body is read only when readBody is true and the status is 200. Any
// other response is settled as soon as its headers arrive and its body is
// discarded, so a slow body cannot hide a status that is already known.
export function get(url, { signal, readBody }) {
  return new Promise((resolve) => {
    let settled = false;
    let status = null;
    const finish = (value) => {
      if (!settled) {
        settled = true;
        resolve(value);
      }
    };
    const fail = (error) =>
      finish({ kind: "error", reason: classifyError(error, signal), status });

    const transport = url.protocol === "https:" ? https : http;
    let request;
    try {
      request = transport.request(url, {
        method: "GET",
        agent: false,
        signal,
        headers: {
          accept: "application/json",
          "accept-encoding": "identity",
          "user-agent": USER_AGENT,
        },
      });
    } catch (error) {
      fail(error);
      return;
    }

    request.on("error", fail);
    request.on("response", (response) => {
      response.on("error", fail);
      status = response.statusCode;
      const headers = response.headers;
      const respond = (body, tooLarge) =>
        finish({ kind: "response", status, headers, body, tooLarge });

      if (!readBody || status !== 200) {
        respond(null, false);
        response.destroy();
        return;
      }

      const declared = headers["content-length"];
      if (declared !== undefined && Number(declared) > MAX_BODY_BYTES) {
        respond(null, true);
        response.destroy();
        return;
      }

      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY_BYTES) {
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
    request.end();
  });
}

export function classifyError(error, signal) {
  if (signal?.aborted) return "timeout";
  const code = typeof error?.code === "string" ? error.code : "";
  if (DNS_ERRORS.has(code)) return "dns_lookup_failed";
  if (REFUSED_ERRORS.has(code)) return "connection_refused";
  if (RESET_ERRORS.has(code)) return "connection_reset";
  if (UNREACHABLE_ERRORS.has(code)) return "host_unreachable";
  if (code.startsWith("HPE_")) return "invalid_http_response";
  if (code.startsWith("ERR_TLS") || code.startsWith("ERR_SSL") || code.includes("CERT")) {
    return "tls_error";
  }
  return "network_error";
}

// Decodes a bounded body as a JSON object. Returns the object, or null when
// the content type, encoding, text or top-level shape is not acceptable.
export function parseJsonObject(response) {
  if (response.body === null || response.tooLarge) return null;
  const encoding = response.headers["content-encoding"];
  if (encoding !== undefined && encoding.trim().toLowerCase() !== "identity") return null;
  const contentType = response.headers["content-type"];
  if (typeof contentType !== "string") return null;
  const mediaType = contentType.split(";")[0].trim().toLowerCase();
  if (mediaType !== "application/json") return null;

  let value;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(response.body);
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
  return value;
}
