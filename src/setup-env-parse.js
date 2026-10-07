import { Stop } from "./auth-store.js";
import { parseOrigin } from "./origin.js";

// Reads and edits dotenv files as text. Nothing is evaluated: no
// interpolation, command substitution or escape processing, and no file is
// ever sourced. Only the two Metergraph assignments are ever interpreted or
// changed; every other byte is kept exactly. Anything this parser cannot read
// without guessing stops with env_syntax_ambiguous.

export const ENV_NAMES = Object.freeze({
  token: "METERGRAPH_APP_TOKEN",
  ingestUrl: "METERGRAPH_INGEST_URL",
});
const NAMES = Object.values(ENV_NAMES);

// Ingest paths the service accepts on an origin. A URL with any other path,
// a query, a fragment or user information is refused.
export const INGEST_PATHS = Object.freeze(["/v1/ingest"]);

// Server-generated application tokens are RFC 3986 unreserved characters
// only, so a value can never carry a quote, newline, comment or space.
const TOKEN = /^[A-Za-z0-9._~-]{16,1024}$/;
const URL_TEXT = /^(https?:\/\/[^/?#@\\]+)(\/[A-Za-z0-9/_.-]*)$/i;
const SAFE_URL = /^[A-Za-z0-9.:/[\]_-]+$/;

const ASSIGNMENT = /^([ \t]*)(export[ \t]+)?([A-Za-z_][A-Za-z0-9_.-]*)([ \t]*=[ \t]*)(.*)$/;
const DOUBLE = /^"([^"\\$`]*)"([ \t]*(?:#.*)?)$/;
const SINGLE = /^'([^'\\$`]*)'([ \t]*(?:#.*)?)$/;
const BARE = /^([^\s#"'`$\\]*)((?:[ \t]+#.*)?[ \t]*)$/;
const BLANK_OR_COMMENT = /^[ \t]*(?:#.*)?$/;
const DECODER = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
const BOM = 0xfeff;

export function isAppToken(value) {
  return typeof value === "string" && TOKEN.test(value);
}

// Returns the normalized ingest URL (origin plus a supported path) or null.
// The caller must not echo the raw input when this returns null.
export function parseIngestUrl(raw) {
  if (typeof raw !== "string" || raw.length > 2048) return null;
  const match = URL_TEXT.exec(raw);
  if (match === null || !INGEST_PATHS.includes(match[2])) return null;
  const origin = parseOrigin(match[1]);
  if (origin === null) return null;
  const url = `${origin}${match[2]}`;
  return SAFE_URL.test(url) ? url : null;
}

function ambiguous() {
  return new Stop("conflict", "env_syntax_ambiguous");
}

function mentions(text) {
  const upper = text.toUpperCase();
  return NAMES.some((name) => upper.includes(name));
}

// Returns the text after the closing quote, or null when the quote does not
// close on this line. Only double quotes treat a backslash as an escape.
function afterQuote(text, quote) {
  for (let i = 0; i < text.length; i += 1) {
    if (quote === '"' && text[i] === "\\") i += 1;
    else if (text[i] === quote) return text.slice(i + 1);
  }
  return null;
}

function metergraphValue(rest) {
  for (const [pattern, quote] of [[DOUBLE, '"'], [SINGLE, "'"], [BARE, ""]]) {
    const match = pattern.exec(rest);
    if (match !== null) return { quote, value: match[1], trailer: match[2] };
  }
  throw ambiguous();
}

// Returns { bom, eol, lines, entries } where lines keeps each line's text and
// its own terminator, and entries maps a Metergraph name to its one
// assignment. content is a Buffer of the whole file.
export function parseEnv(content) {
  if (content.includes(0)) throw new Stop("conflict", "env_file_invalid");
  let text;
  try {
    text = DECODER.decode(content);
  } catch {
    throw new Stop("conflict", "env_file_invalid");
  }
  const bom = text.charCodeAt(0) === BOM;
  if (bom) text = text.slice(1);
  // A lone carriage return ends a line for some parsers and not others.
  if (/\r(?!\n)/.test(text)) throw ambiguous();

  const pieces = text.split(/(\r?\n)/);
  const lines = [];
  for (let i = 0; i < pieces.length; i += 2) lines.push({ text: pieces[i], eol: pieces[i + 1] ?? "" });
  if (lines.at(-1).text === "" && lines.at(-1).eol === "") lines.pop();

  const entries = {};
  let open = null;
  for (const [index, line] of lines.entries()) {
    if (open !== null) {
      // Inside another variable's multiline quoted value.
      if (mentions(line.text)) throw ambiguous();
      const rest = afterQuote(line.text, open);
      if (rest === null) continue;
      if (!BLANK_OR_COMMENT.test(rest)) throw ambiguous();
      open = null;
      continue;
    }
    if (BLANK_OR_COMMENT.test(line.text)) continue;
    const match = ASSIGNMENT.exec(line.text);
    if (match === null) {
      // Kept as is unless it could hide a Metergraph value or open a quote.
      if (mentions(line.text) || /["'`]/.test(line.text)) throw ambiguous();
      continue;
    }
    const [, lead, exported = "", key, separator, rest] = match;
    if (NAMES.includes(key)) {
      if (Object.hasOwn(entries, key)) throw new Stop("conflict", "env_duplicate_assignment");
      entries[key] = { index, lead, exported, separator, ...metergraphValue(rest) };
      continue;
    }
    if (NAMES.includes(key.toUpperCase())) throw ambiguous();
    const quote = rest[0];
    if (quote === '"' || quote === "'" || quote === "`") {
      const after = afterQuote(rest.slice(1), quote);
      if (after === null) open = quote;
      else if (!BLANK_OR_COMMENT.test(after)) throw ambiguous();
    }
  }
  if (open !== null) throw ambiguous();

  const endings = new Set(lines.map((line) => line.eol).filter((eol) => eol !== ""));
  const eol = endings.size === 1 && endings.has("\r\n") ? "\r\n" : "\n";
  return { bom, eol, lines, entries };
}

// Returns the file content with each name in updates set to its value. A
// line whose value already matches is left exactly as it was. A changed line
// keeps its indentation, export keyword, quote style and trailing comment.
// Missing names are appended, one line each, with the file's line ending.
export function serializeEnv(parsed, updates) {
  const lines = parsed.lines.map((line) => ({ ...line }));
  const appended = [];
  for (const [name, value] of Object.entries(updates)) {
    const entry = parsed.entries[name];
    if (entry === undefined) {
      appended.push(`${name}=${value}`);
    } else if (entry.value !== value) {
      const { lead, exported, separator, quote, trailer } = entry;
      lines[entry.index].text = `${lead}${exported}${name}${separator}${quote}${value}${quote}${trailer}`;
    }
  }
  if (appended.length > 0 && lines.length > 0 && lines.at(-1).eol === "") lines.at(-1).eol = parsed.eol;
  for (const text of appended) lines.push({ text, eol: parsed.eol });
  const body = lines.map((line) => line.text + line.eol).join("");
  return Buffer.from(`${parsed.bom ? String.fromCharCode(BOM) : ""}${body}`, "utf8");
}

// Reparses generated content and checks that it holds exactly the intended
// Metergraph values, so no value can ever add or hide an assignment.
export function checkSerialized(content, updates, previous) {
  const parsed = parseEnv(content);
  for (const name of NAMES) {
    const expected = Object.hasOwn(updates, name) ? updates[name] : previous.entries[name]?.value;
    if (parsed.entries[name]?.value !== expected) throw new Stop("internal_error", "env_write_failed");
  }
  return parsed;
}
