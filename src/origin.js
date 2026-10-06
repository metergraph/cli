const MAX_INPUT_LENGTH = 2048;

// A bare authority with an optional trailing slash: no userinfo, path, query,
// fragment or backslash. Checked on the raw text because the URL parser
// silently normalizes some of these away.
const HTTPS_ORIGIN = /^https:\/\/[^/?#@\\]+\/?$/i;

// Plaintext HTTP is only for these exact loopback spellings. Alternate forms
// such as 127.1 or 0x7f000001 are rejected even though they resolve locally.
const HTTP_LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?\/?$/i;
const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]"]);

// Returns the normalized origin (for example "https://example.com") or null.
// The caller must not echo the raw input when this returns null.
export function parseOrigin(raw) {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_INPUT_LENGTH) {
    return null;
  }
  // Printable ASCII only. Hosts with non-ASCII labels use their xn-- form.
  if (/[^\x21-\x7e]/.test(raw)) return null;
  if (!HTTPS_ORIGIN.test(raw) && !HTTP_LOOPBACK_ORIGIN.test(raw)) return null;

  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (url.username !== "" || url.password !== "") return null;
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "") return null;
  if (url.hostname === "" || url.port === "0") return null;
  if (url.protocol === "http:" && !LOOPBACK_HOSTNAMES.has(url.hostname)) return null;

  return url.origin;
}
