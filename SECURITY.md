# Security policy

## Reporting a vulnerability

Please report security issues privately through this repository's GitHub
**Security** tab ("Report a vulnerability"). Do not open a public issue, and do not
include real credentials, tokens or customer data in a report.

## Supported versions

`metergraph-cli` is a development preview. Only the latest version receives fixes.

## Security properties of the CLI

The current preview holds no credentials of its own and is designed to limit what it
reads, writes, sends and prints. These are the boundaries it is designed to keep:

- **No credential stores.** It reads no credentials from environment variables,
  configuration files, keychains, cookies or arguments, and sends no `Authorization` or
  `Cookie` header.
- **Fixed requests.** `doctor` makes only unauthenticated `GET` requests to `/healthz`,
  `/v1/deployment` and `/v1/agent/capabilities` on the origin you choose.
- **Origin validation.** `--url` must be a bare `https` origin, or an `http` origin on
  `localhost`, `127.0.0.1` or `[::1]`. Values with a username, password, path, query or
  fragment are rejected before any request is made.
- **Redacted input errors.** Invalid option values and unknown arguments are reported
  with a fixed message, without echoing the value.
- **Redacted server content.** Output contains fixed text, HTTP status codes, the
  accepted origin and a recognized deployment profile. Response bodies, headers,
  authentication challenges, server-supplied URLs, unrecognized profile names and
  network error text are not printed.
- **Bounded probe.** Redirects are not followed. At most 32 KiB of each response body
  is read, and the whole probe is bounded by `--timeout-ms`.
- **No runtime dependencies.**

### Skill installer

`skill install` and `skill update` write files inside a project directory you name.
They are designed to keep these boundaries:

- **No network and no remote code.** The skill is copied from this package. It is
  checked against a SHA-256 pinned in the code and in `assets/skill/manifest.json`
  before anything is written, and a mismatch stops the command.
- **Two files only.** The client's `SKILL.md` and `.metergraph/skill-installations.json`.
  Client settings, MCP configuration, `AGENTS.md`, `CLAUDE.md` and unrelated files are
  never written.
- **Secret-free receipt.** The receipt holds relative paths, the skill name, revision,
  hash and requested runtimes. It holds no credentials, user names or absolute paths.
- **Ownership before overwrite.** A skill the CLI did not install, or one changed since
  it installed it, is never replaced. There is no force option.
- **No link following.** The `--project` path is resolved once. Below it, a symbolic
  link or non-regular entry on the skill or receipt path stops the command. Files are
  opened without following links where the platform supports it.
- **Atomic writes.** Each file is written to an exclusive temporary file and renamed
  into place under a lock file. A failed receipt write restores the previous skill
  file, so ownership is never recorded for a skill that was not written.
- **Redacted output.** Invalid option values, file contents, absolute paths and raw error text
  are never printed. Recognized client and runtime names appear in receipts.

A person or process that can already write to the project can still change files
between the installer's checks and its writes. The installer re-checks every target
right before replacing it, which narrows but does not remove that window.

### What remains visible

The accepted origin is not secret. It is printed in text and JSON output, resolved
through DNS and sent to that host as part of each request. Anything you place in a
hostname, including a value that happens to be a secret, is visible to your terminal,
logs, CI output, resolvers, network observers and the server. Pass only origins you
are comfortable sharing.

The CLI cannot control what the chosen server, your network or your shell history
records about a request.

If you find a way to make the CLI print or send something outside these boundaries,
please report it.
