# Security policy

## Reporting a vulnerability

Please report security issues privately through
[GitHub private vulnerability reporting](https://github.com/metergraph/cli/security/advisories/new)
(the repository's **Security** tab, "Report a vulnerability"). Do not open a public issue, and do not
include real credentials, tokens or customer data in a report.

## Supported versions

`metergraph-cli` is a development preview. Only the latest version receives fixes.

## Security properties of the CLI

The published `0.1.0` package holds no credentials of its own. The
`0.2.0` previews add `login` and `logout`, which hold one delegated,
Metadata-only grant per signed in project, and read commands that use it; see
[Sign in](#sign-in-checkout-only) and [Read commands](#read-commands-checkout-only). The
CLI is designed to limit what it reads, writes, sends and prints. These are the
boundaries it is designed to keep:

- **No credentials for doctor and skill.** They read no credentials from environment
  variables, configuration files, keychains, cookies or arguments, and send no
  `Authorization` or `Cookie` header. No command ever sends a `Cookie` header or reads
  a credential from arguments, the environment or stdin.
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
`skills install` and `skills update` apply the same boundaries to each workflow skill
they install, with one receipt per skill in `.metergraph/skills/`; the pack's
manifest hash is pinned in the code and pins each skill's hash. `skills list` only
reads. They are designed to keep these boundaries:

- **No network and no remote code.** The skill is copied from this package. It is
  checked against a SHA-256 pinned in the code and in `assets/skill/manifest.json`
  before anything is written, and a mismatch stops the command.
- **Two files per skill only.** The client's `SKILL.md` and `.metergraph/skill-installations.json`
  (for the pack, `.metergraph/skills/<name>.json`).
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

### Sign in (checkout only)

`login` and `logout` are not in any published package yet. They are designed to keep
these boundaries:

- **Delegated, Metadata-only grant.** The browser keeps the person's own sign in. The
  CLI requests exactly `agent:metadata` and refuses a grant with any other scope. It
  never requests Debug or Replay access and never falls back to them. It copies no
  browser cookies and does not create an application ingest key; no manual API key is
  required. The service records the grant as an OAuth connection on its own side,
  limited to `agent:metadata` and separate from any API or ingest key you manage.
- **One origin, fixed paths.** Every request goes to the origin you chose, on fixed
  paths. OAuth metadata that names any other origin or path is refused, redirects are
  not followed, and every response is size and time bounded.
- **Public client with PKCE.** Each sign in registers a public client (no client
  secret) for one loopback redirect on `127.0.0.1` and an ephemeral port, and uses a
  random 256 bit state and an `S256` PKCE challenge.
- **Hardened callback.** The listener is armed before the browser opens. It accepts one
  `GET` on the exact host, path and state, refuses duplicates and oversized requests,
  answers with static pages that reflect nothing, and logs nothing. It closes on
  success, failure, timeout and Ctrl+C.
- **Server-verified context.** Before anything is saved, the new token is used to read
  the workspace and capability documents. Workspace, token and expected workspace
  must agree, the deployment profile must match the preflight, and content, evidence
  and replay access must be unavailable. Token claims are checked as a sanity check
  only; the CLI does not verify signatures, and the service's answers are
  authoritative.
- **Best-effort revocation of unkept grants.** Once a token response is validated and
  holds a usable refresh token, a grant the CLI decides not to keep is sent to the
  revocation endpoint. The service may not answer or confirm, and the CLI does not
  retry, so this is not a guarantee. A token response that fails validation is
  dropped without a revocation request; a server-side grant may remain active until it expires
  or is revoked from the service.
- **Private storage.** The grant is saved in a per-user config directory. On Linux and
  macOS, directories must be `0700` and files `0600`, owned by the current user;
  unsafe permissions, other owners, symbolic links and non-regular files are refused
  and never changed. On Windows, the grant is encrypted with DPAPI for the current user
  by a fixed PowerShell script that receives data on stdin and returns it on stdout;
  nothing secret is on a command line. Files are written to an exclusive temporary file
  and renamed into place.
- **Secret-free binding.** `.metergraph/project.json` holds the origin, workspace ID,
  deployment profile and an opaque slot name. A project bound to one origin or
  workspace is never switched without `--reconnect`.
- **Safe refresh.** A refresh runs once under an exclusive lock and is marked pending
  on disk before the refresh token is sent. If the outcome is not known and saved, the
  old refresh token is never sent again and the user must sign in again. Revoked
  grants and lost workspace access fail closed.
- **Honest sign out.** `logout` asks the service to revoke the grant, then removes the
  local grant and binding. It reports separately whether the service accepted the
  revocation request; a `200` is not proof that every remote session ended.
- **Remote and cloud sessions.** SSH sessions, cloud development environments, CI and
  cloud runtimes get a handoff before any listener, request or file write. Only the
  presence of the detecting variables is checked; their values are never printed.
- **Redacted output.** Tokens, the authorization code, the PKCE verifier, workspace
  names, user names, email addresses, absolute paths and server text are never
  printed. `--json` prints one line on stdout and nothing on stderr.

### Read commands (checkout only)

`status`, `context`, `capabilities`, `usage`, `routes` and `traces` are not in any
published package yet. They are designed to keep these boundaries:

- **Existing grant only.** They use the project's saved Metadata grant through the same
  verified session as `login`: the workspace, deployment profile and `agent:metadata`
  scope are checked with the service on every run, and content, evidence and replay
  capabilities must be unavailable. They never open a browser, sign in, request a
  broader scope or accept a credential from arguments, the environment or stdin.
- **Fixed GET requests.** Requests go only to fixed paths on the bound origin. A query
  string is built from validated options and is accepted by the transport only on the
  usage and traces paths, with an allowlist of keys per path, so no argument can choose
  a path, origin or header. Redirects are not followed and bodies over 1 MiB are
  discarded.
- **One deadline, no silent retries.** Every request of a command, including a token
  refresh and any wait for another process's grant lock, shares one `--timeout-ms`
  deadline, and Ctrl+C stops that wait too. A lock held by another process is never
  removed or taken over. A refused, rate limited or failed read is
  reported, not retried, and a refresh that may have consumed the refresh token is
  never repeated.
- **Validated output only.** Every read document must carry the service's contract
  version and the bound workspace and profile in its provenance, and must state that
  content is not included. Only fields the CLI validates are printed. Unknown fields
  are dropped without naming them, a row with a content or credential field is refused
  as a whole, and names with control or formatting characters are replaced with
  `null`. Route descriptions, constraints, evaluation contracts, warning messages and
  server error text are not printed. Free-text filter arguments are not echoed. Before
  anything is printed, every output string is checked against the token values the CLI
  holds for the project (including ones a refresh just replaced); a match fails closed
  with `credential_in_metadata_response` and prints none of the response. This is an
  exact check for known values, not a detector for secrets in general.
- **No unbounded or implied reads.** `--days` and `--limit` are bounded and never
  clamped. Traces are read one page at a time and a cursor is followed only when you
  pass it. Requests for an environment, a workload filter (which the returned rows
  cannot prove was applied), an absolute time range, a free-form query, content, debug
  data or replay are refused before any request.
- **No invented links or verification.** No trace link is printed, because the service
  does not yet return a workspace-bound one. `status` checks the service's reported
  deployment profile against the binding and never reports application traffic as
  verified.
- **Not side-effect free.** Read commands change no workspace configuration or
  telemetry and send no ingest data, but they may refresh their own grant, and the
  service may record the access (audit entries, last used times).

Route, trace, provider and model names come from your workspace data. They are printed
as data and should never be treated as instructions, by people or by agents reading
the output.

Limits: anyone who can run code as your user can read or use the saved grant, as with
any per-user credential file. The `0700`/`0600` fallback on Linux and macOS is not an
operating system keychain. A lock or binding file left by a killed process stays until
you delete it, rather than being taken over.

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
