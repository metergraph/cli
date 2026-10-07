# metergraph-cli

The Metergraph command line tool. This checkout is a **development preview**, version
`0.2.0-preview.0`, which has not been published.

Install the released preview channel with npm or run it directly:

```sh
npx --yes metergraph-cli@next --help
npx --yes metergraph-cli@next doctor --json
npm install -g metergraph-cli@next
```

The installed command is `metergraph`. Pin `metergraph-cli@0.1.0` for that exact preview.

**Availability:**

- The published package, `metergraph-cli@0.1.0`, contains only `doctor` and
  `skill install` / `skill update`. It has no sign in commands.
- `login` and `logout`, described below, exist only in this checkout. They are an
  upcoming preview: run them from a checkout or a locally packed tarball (see
  [Development](#development)). Do not expect them from `npx metergraph-cli` until a
  release that includes them is announced.
- They also need a Metergraph service that offers Metadata-only CLI sign in and grant
  revocation. A service without them is reported as unsupported, and the CLI never
  falls back to broader access.
- The read commands `status`, `context`, `capabilities`, `usage`, `routes` and `traces`
  also exist only in this checkout and are part of the same unpublished upcoming preview.
  They need a project signed in with `login`.
- `setup` also exists only in this checkout. It requires the deployment's separate
  ingest bootstrap API and browser approval by a member of the bound workspace.

This development preview does five things:

- `doctor` checks whether a Metergraph service is reachable, healthy and supported.
- `skill install` and `skill update` copy the Metergraph agent skill bundled with the
  CLI into one coding agent's project skill directory.
- `login` and `logout` (checkout only) sign a project in to one workspace through your
  browser with a delegated, Metadata-only grant, and sign it out again.
- The read commands (checkout only) use that grant to read bounded workspace Metadata:
  connection status, workspace context, capabilities, daily usage, routes and one page
  of trace metadata.
- `setup` (checkout only) asks for ingest-only browser approval, then writes a private
  project env file and confirms that the key was delivered.

It does not read retained content, replay traces, call model providers or send
application data. Setup does not prove that the application sent a trace.

## Requirements

| | Supported |
| --- | --- |
| Node.js | 22 and 24 |
| Operating systems | Linux, macOS and Windows (each in the CI matrix) |
| Runtime dependencies | None |

## Commands

```sh
metergraph --help [--json]
metergraph help doctor [--json]
metergraph --version [--json]
metergraph doctor [--url ORIGIN] [--timeout-ms N] [--json]
metergraph help skill [--json]
metergraph skill install --client CLIENT --runtime RUNTIME [--project DIR] [--json]
metergraph skill update --client CLIENT --runtime RUNTIME [--project DIR] [--json]
metergraph help login [--json]
metergraph login --runtime local [--url ORIGIN] [--workspace UUID] [--project DIR] [--config-dir DIR] [--timeout-ms N] [--signup] [--no-browser] [--reconnect] [--json]
metergraph logout [--project DIR] [--config-dir DIR] [--json]
metergraph setup --runtime local [--project DIR] [--config-dir DIR] [--env-file .env] [--timeout-ms N] [--no-browser] [--repair] [--json]
metergraph status [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph context [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph capabilities [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph usage [--days N] [--limit N] [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph routes [--limit N] [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph traces [--days N] [--limit N] [--route NAME] [--status success|error] [--cursor CURSOR] [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
```

`--help`, `--version` and the `skill` commands work offline and make no network
requests. `login`, `logout`, `setup` and the read commands are not in the published `0.1.0`
package.

### doctor

`doctor` sends three unauthenticated, read-only `GET` requests to one origin, in order,
and stops at the first problem:

1. `/healthz` must answer `200` with the JSON body `{"ok": true}`.
2. `/v1/deployment` must answer `200` with a JSON `deployment_profile` this CLI supports.
3. `/v1/agent/capabilities` must answer `401` with a `WWW-Authenticate: Bearer` challenge.

Options:

| Option | Default | Notes |
| --- | --- | --- |
| `--url ORIGIN` | `https://app.metergraph.dev` | Bare origin only, see [Safe origins](#safe-origins). |
| `--timeout-ms N` | `5000` | Whole number from 100 to 30000. Covers the whole probe, not each request. |
| `--json` | off | Print exactly one JSON line on stdout and nothing on stderr. |

A healthy, supported service exits with code **3, `authentication_required`**. That is
the best result this preview can report: the service is reachable, but this CLI holds
no credentials, so `authenticated` is always `false` and `workspace` is always `null`.
A reachable service is not a working workspace connection. To connect an application,
follow the [connection guide](https://www.metergraph.dev/docs/guides/agent-access/).

`doctor` never opens a browser, never prompts and never reads stdin, so it is safe in
scripts and CI.

### skill install and skill update

`skill install` copies the Metergraph skill bundled with this CLI into one client's
native project skill directory. Both `--client` and `--runtime` are required, so the
command never guesses where the skill will be used.

| `--client` | Client | Skill file written | Client documentation |
| --- | --- | --- | --- |
| `codex` | Codex | `.agents/skills/metergraph/SKILL.md` | [Build skills](https://learn.chatgpt.com/docs/build-skills) |
| `claude` | Claude Code | `.claude/skills/metergraph/SKILL.md` | [Skills](https://code.claude.com/docs/en/skills) |
| `cursor` | Cursor | `.cursor/skills/metergraph/SKILL.md` | [Skills](https://cursor.com/docs/skills) |

Each client has its own directory, so installing for several clients never makes one
overwrite another.

| Option | Default | Notes |
| --- | --- | --- |
| `--client CLIENT` | required | `codex`, `claude` or `cursor`. |
| `--runtime RUNTIME` | required | `local` when the client runs on this machine, `cloud` when it runs in a cloud environment with a shell and a checkout of the project. Recorded, not detected. |
| `--project DIR` | current directory | Must be an existing directory. Symbolic links in this path are resolved once; nothing below it is followed. |
| `--json` | off | Print exactly one JSON line on stdout and nothing on stderr. |

What it writes, and nothing else:

1. The skill file in the table above, plus any of its missing parent directories.
2. `.metergraph/skill-installations.json`, a small ownership receipt. For each client it
   records the relative skill path, the skill name, the source revision and SHA-256,
   and the runtimes requested. It contains no credentials, user names or absolute
   paths, so it is safe to commit.

Ownership rules:

- `install` never replaces a skill it did not install, even one with identical bytes.
- Running `install` again on an unchanged skill it installed changes nothing.
- A skill it installed that was edited since is never overwritten, by `install` or by
  `update`. Restore or remove the file first.
- `update` is the only way to replace an older revision this CLI installed. There is no
  force option.
- A skill file this CLI installed that has gone missing is written again.
- Symbolic links and other non-regular entries on the skill or receipt path are
  refused.
- Files are written to an exclusive temporary file and renamed into place, under a lock
  file, `.metergraph/skill-installations.lock`. The receipt is written only after the
  skill file, and a failed receipt write puts the skill file back as it was. If the
  process is killed between the two writes, the skill is left without a receipt entry,
  so later runs refuse to touch it, and the lock stays until you delete it.
- It never changes client settings, MCP configuration, `AGENTS.md`, `CLAUDE.md` or any
  other file, and keeps the permissions of a file it replaces.

`--runtime cloud` writes the same project file. A cloud client sees it only through
its own checkout of the project, so commit the file if you installed it elsewhere.
Writing a skill file in a cloud checkout does not connect MCP, sign in or copy anything
from your own machine. Local skills do not sync to desktop or cloud apps on their own.

Clients and runtimes that cannot load project skill files get a pointer to the
[connection guide](https://www.metergraph.dev/docs/guides/agent-access/) with exit code
6, and nothing is written: `--client claude-desktop`, `--client chatgpt` and
`--runtime cloud-no-shell` (a cloud runtime without a shell or project checkout).

A successful run exits `0` with `discovery: "pending"` and `authenticated: false`.
Writing the file does not prove that a client has loaded it. Start or reload the client
in the project and check that it lists the `metergraph` skill. The skill itself is
instructions for the agent; it holds no credentials and does not connect a workspace.

#### Bundled skill source

`assets/skill/SKILL.md` is a byte-for-byte copy of the public skill at
<https://www.metergraph.dev/SKILL.md>. The source has no version number of its own, so
`assets/skill/manifest.json` records its source URL, size and SHA-256, and a revision
derived from that hash (`sha256-` followed by the first 12 hex digits). The package
version is not the skill version. At runtime the CLI checks the bundled file against a
hash pinned in its code and in the manifest, and refuses to write anything if either
does not match. It never downloads the skill or runs a remote script. A new skill
revision ships only in a new CLI release; `skill update` then upgrades projects that
hold an unchanged earlier revision.

### login and logout (checkout only, unreleased)

`login` binds a project directory to one Metergraph workspace. Your browser does the
sign in, sign up, invitation and workspace consent on the service's own pages and
keeps its own session. The CLI receives only a delegated OAuth grant limited to the
Metadata scope, `agent:metadata`, checks it with the service and saves it privately.

```sh
metergraph login --runtime local --url https://metergraph.example.com
metergraph logout
```

| Option | Default | Notes |
| --- | --- | --- |
| `--runtime RUNTIME` | required | `local`: the browser runs on this machine. `cloud` and `cloud-no-shell` get a handoff to the [connection guide](https://www.metergraph.dev/docs/guides/agent-access/) with exit code 6. |
| `--url ORIGIN` | `https://app.metergraph.dev` | Bare origin only, see [Safe origins](#safe-origins). |
| `--workspace UUID` | none | The workspace you expect. Sign in fails unless the browser grants exactly this one. Without it, the workspace you choose in the browser is used after the service confirms it. |
| `--project DIR` | current directory | Existing project directory to bind. |
| `--config-dir DIR` | see below | Private per-user directory for the saved grant. |
| `--timeout-ms N` | `300000` | How long to wait for the browser, 1000 to 900000. |
| `--signup` | off | Start at the hosted sign up page, which returns to the same authorization request. Managed service only; other profiles exit 6. |
| `--no-browser` | off | Print the authorization URL on stderr for you to open on this machine, then wait. Not with `--json`. |
| `--reconnect` | off | Allow replacing a binding to a different origin or workspace. |
| `--json` | off | Print exactly one JSON line on stdout and nothing on stderr. |

What `login` does, in order:

1. Refuses cloud runtimes, SSH sessions, cloud development environments and CI (by the
   presence of variables such as `SSH_CONNECTION`, `CODESPACES` or `CI`; values are
   never read into output) before any request, listener or file write.
2. Reads the project binding. A project bound to another origin or workspace is refused
   with exit code 8 unless you pass `--reconnect`. A project that is already signed in
   and still verified is left as it is, with no browser and no new client.
3. Runs the same checks as `doctor`, then reads the service's OAuth metadata from the
   same origin. Every endpoint must be a fixed path on that origin, and the service must
   offer `agent:metadata`, PKCE with `S256`, public clients and revocation.
4. Registers a public client named `Metergraph CLI` for one loopback redirect,
   `http://127.0.0.1:PORT/callback` on an ephemeral port, creates a random state and
   PKCE verifier, and arms the callback listener and its timeout before the browser
   opens.
5. Opens the authorization URL with the operating system's launcher (no shell). The
   listener accepts one `GET` with the exact host, path and state. Other requests get a
   fixed page and do not end the wait.
6. Exchanges the code and accepts only a Bearer grant for exactly `agent:metadata` whose
   claims name this issuer, resource, client and one workspace. The claims are a sanity
   check; the CLI does not verify token signatures.
7. Asks the service, with the new token, for `/v1/agent/workspace` and
   `/v1/agent/capabilities`. The workspace ID, its provenance and the token must agree,
   the deployment profile must match step 3, the access scopes must be exactly
   `agent:metadata`, and content, evidence and replay capabilities must be unavailable.
   Nothing else is read.
8. Saves the grant in the config directory and writes `.metergraph/project.json`.

Once the token response has been validated and holds a usable refresh token, a grant
the CLI decides not to keep (a workspace other than the one expected or bound, failed
verification, cancellation) is sent to the revocation endpoint before the command
exits. If the grant cannot be saved or the binding cannot be written, the saved grant
is removed, revocation is requested the same way, and the command exits 9. This is best
effort: the service may not answer or may not confirm, and the CLI does not retry. A
token response that fails validation is dropped without a revocation request, because
the CLI cannot safely use anything in it; a server-side grant may remain active until it
expires or is revoked from the service.

The config directory is `--config-dir`, else `METERGRAPH_CONFIG_DIR` (an absolute
path), else `~/.config/metergraph` on Linux and macOS or `AppData\Roaming\Metergraph` in
your Windows profile. It holds `credentials/SLOT.json`:

- On Linux and macOS the directories must be `0700` and the file `0600`, all owned by
  you. Existing paths with other permissions, other owners or symbolic links are
  refused and never changed.
- On Windows the grant is encrypted with DPAPI for the current user before it is
  written. File permissions alone are not relied on there.

`.metergraph/project.json` holds the origin, workspace ID, deployment profile and the
name of the credential slot. It holds no token, user name or absolute path, so it is
safe to commit. Other files in `.metergraph`, such as the skill receipt, are kept.

Access tokens near expiry are refreshed once, under a lock, and the new refresh token
is saved before it is used. If a refresh request may have reached the service but its
result was not saved (a timeout after sending, a dropped connection, a server error or
an unusable answer), the old refresh token is never sent again: the next use asks you
to run `login` again. A revoked grant or lost workspace access fails closed with exit
code 12.

`logout` asks the service to revoke the project's grant through its revocation
endpoint, then removes the saved grant and `.metergraph/project.json`. Other credential
slots and project files are kept. A `200` from the service means it accepted the
revocation request. If it does not answer `200`, local sign out still happens and the
command exits 13 with `revocation: "unconfirmed"`. A project that is not signed in
exits 0 without any request.

### setup (checkout only, unreleased)

Sign in to the intended workspace first, then run:

```sh
metergraph setup --runtime local --project /path/to/project
```

The bound deployment must advertise `metergraph.cli-setup/v1` on its own origin.
`setup` verifies the saved Metadata session, checks the env file and Git state,
then opens the deployment's consent page. An owner or member of the exact bound
workspace approves an ingest-only key. The CLI redeems the single-use receipt,
writes `METERGRAPH_APP_TOKEN` and `METERGRAPH_INGEST_URL` into `.env`, checks the
new key with the service, and acknowledges delivery. It never asks for Debug or
Replay access. The browser page shows the workspace and the consequence of the
approval. A signed-in browser on another workspace must switch in Metergraph
and rerun; the CLI does not switch it automatically.

The env file must be a project-relative `.env`, `.env.<name>` or `<name>.env`
(`--env-file` selects another). The writer refuses tracked files, links,
ambiguous dotenv syntax and unsafe paths. It adds a project `.gitignore` rule
when needed and makes the env file private; Windows uses a user-only ACL.
The env token is never printed, read from argv or stdin, or copied to the
project's setup state file. An already working key is checked and reused without
another browser approval.

`.metergraph/setup.json` holds a family UUID, its current key ID and fixed state,
but no credential. It is written before approval. If the redemption response is
lost, a rerun asks for a new browser approval to replace only that family's
pending key; the old receipt is not retried. If an acknowledged key no longer
verifies, use `--repair` to explicitly approve replacement of that exact key.
An unsafe or changed state file is refused. If the earlier approval never
reached redemption, rerun the command; the `create` intent is still safe.

Success means the key was delivered and the project is ready to instrument.
It does **not** mean application traffic has arrived. Run your application and
verify one exact trace afterward. This checkout and the matching server slice
are development work; neither their availability on a deployed service nor a
published package has been established by these local tests.

### Read commands (checkout only, unreleased)

The read commands use the grant `login` saved for this project. They never open a
browser, never sign in on their own and never request another scope. Each one:

- reads `.metergraph/project.json` and the saved grant, and refreshes the grant at most
  once, under the same lock and rules as `login` (an interrupted refresh is never
  retried with a possibly used token);
- asks the service for `/v1/agent/workspace` and `/v1/agent/capabilities` and checks,
  as `login` does, that the workspace, deployment profile and `agent:metadata` scope
  still match the binding and that content, evidence and replay are unavailable;
- sends only `GET` requests to fixed paths on the bound origin, follows no redirects and
  reads at most 1 MiB of a response;
- runs every request, including a refresh and any wait for another command that is
  refreshing the same grant, within one total `--timeout-ms` deadline (1000 to 60000,
  default 15000), which is never reset per request or page. A deadline exits 4
  (`timeout`) and Ctrl+C exits 17, also while waiting for that lock; a lock held by
  another process is never removed or taken over;
- prints only fields it validated. Unknown response fields are ignored and never named.
  A metadata row that holds a field such as `prompt`, `messages`, `tool_calls` or
  `access_token` is refused as a whole (exit 11). Names that contain control or
  formatting characters are shown as `null`. Service warning and error text is not
  printed. If any printed value, such as a workspace name, route name, cursor or
  provenance source, contains a token the CLI holds for this project, nothing is
  printed and the command exits 11 with `credential_in_metadata_response`.

Read commands do not change workspace configuration or telemetry, send no ingest data
and call no model provider. They are not side-effect free on the service: a command may
refresh its own saved grant, and the service may update its audit records and last used
times for the grant.

| Command | Request | What it prints |
| --- | --- | --- |
| `status` | `GET /healthz` and `GET /v1/deployment` (no credentials, checked as `doctor` does), then the two checks above | `configured`, `reachable`, `healthy`, `authenticated`, the bound (`intended`) and verified (`actual`) workspace, the bound deployment profile and `deployment_profile_verified`, scopes and capability flags. A `/v1/deployment` profile that differs from the binding exits 11 with `profile_mismatch` before the grant is used. `application_traffic_verified` is always `false`: a signed in project, existing data or a configured SDK does not prove that your application sends traffic. |
| `context` | the two checks above | Workspace ID, slug, name and creation time, Metadata retention days, whether the workspace captures content (never included here) and the access scope. |
| `capabilities` | the two checks above | Each known agent capability with `available`, `privacy_class`, `required_scope` and flags, and the service's bounds. Privacy class descriptions are not printed. |
| `usage` | `GET /v1/agent/usage?days=N&limit=N` | Daily rows per route: calls, errors, cost, tokens and latency (latency may be `null`), the window, evidence completeness, warning codes and totals of the returned rows. |
| `routes` | `GET /v1/agent/routes` | Route name, calls, replay eligible calls, evaluation contract version and hash, and whether a description or contract exists. |
| `traces` | `GET /v1/agent/traces?days=N&limit=N[&route=&status=&cursor=]` | One page of trace metadata: IDs, name, status, times, span count, tokens, cost (may be `null`), routes, providers and models, plus `next_cursor`. |

Bounds and honesty rules:

- `--days` is 1 to 90 (default 7) and `--limit` 1 to 200 (default 50, or 20 for
  `traces`). Values outside these ranges exit 2. A value above the service's own
  advertised `max_days` or `max_rows` exits 6 with `exceeds_service_bounds`; it is never
  reduced silently.
- `usage` and `traces` report `truncated` and `complete`. Totals are sums of the
  returned rows only; when `complete` is `false` they are not workspace totals. An
  empty window is a successful result with `empty: true`.
- `GET /v1/agent/routes` takes no limit or window. The CLI validates every returned row,
  keeps the first `--limit`, and reports `server_rows`, `truncated` and
  `truncation: "local"`. Route descriptions, constraints and evaluation contract bodies
  are never printed; `omitted_fields` lists them.
- `traces` fetches exactly one page. When more exist it returns `next_cursor`; pass it
  back with `--cursor` to read the next page. The cursor is opaque and at most 512
  printable characters. A page whose `limit` differs from the request, or rows that do
  not match `--status` or `--route`, exit 11. Free-text filter values are not printed
  back.
- No trace links are printed. The service does not yet return a workspace-bound link,
  so each trace has `link: null` and the page has
  `link_status: "server_link_unavailable"`.
- `--environment`, `--workload`, `--since`, `--until`, `--sql`, `--query`, `--content`,
  `--include-content`, `--debug` and `--replay` are recognized and refused with exit 6
  before any request. The agent access contract has no environment selector or
  absolute time range, and these commands never read content or replay. `--workload`
  is refused by this CLI version because the returned trace rows do not show which
  workload they belong to, so a filtered page could not be verified.
- A capability the service does not offer to this grant exits 14 without a read. A
  refused read exits 15 (`insufficient_scope` or `forbidden`), rate limiting exits 16
  with `retry_after_seconds` when the service sends a whole number of seconds, and a
  token refused during the read exits 12. Nothing is retried. Ctrl+C exits 17.

A successful `usage`, shortened:

```json
{
  "schema_version": 1,
  "command": "usage",
  "ok": true,
  "outcome": "ok",
  "exit_code": 0,
  "data": {
    "origin": "https://metergraph.example.com",
    "workspace": { "id": "0b5c7c1e-1a2b-4c3d-8e4f-5a6b7c8d9e01" },
    "deployment_profile": "managed",
    "authenticated": true,
    "scopes": ["agent:metadata"],
    "result": {
      "provenance": {
        "deployment_profile": "managed",
        "workspace_id": "0b5c7c1e-1a2b-4c3d-8e4f-5a6b7c8d9e01",
        "generated_at": "2026-01-08T12:00:00Z",
        "source": "example-source"
      },
      "window": { "days": 7, "since": "2026-01-01T12:00:00Z", "until": "2026-01-08T12:00:00Z" },
      "evidence": { "sources": ["telemetry"], "rows": 1, "complete": true },
      "warnings": [],
      "content_included": false,
      "truncated": false,
      "complete": true,
      "empty": false,
      "rows": 1,
      "items": [
        {
          "date": "2026-01-02",
          "route": "checkout-summary",
          "calls": 40,
          "error_calls": 2,
          "cost_usd": 0.0125,
          "input_tokens": 12000,
          "output_tokens": 3400,
          "avg_latency_ms": 820,
          "p95_latency_ms": null
        }
      ],
      "totals": {
        "scope": "returned_rows",
        "complete": true,
        "calls": 40,
        "error_calls": 2,
        "cost_usd": 0.0125,
        "input_tokens": 12000,
        "output_tokens": 3400
      }
    },
    "retry_after_seconds": null,
    "notices": [],
    "next_action": null
  },
  "error": null
}
```

On failure `result` is `null`, `authenticated` says whether the grant was verified
before the failure, and `notices` lists fixed tokens such as `rows_truncated`,
`evidence_incomplete`, `routes_truncated_locally`, `unsafe_text_omitted` or
`trace_links_unavailable`.

## Exit codes

Exit codes are stable. Changing one is a breaking change. Codes 10 to 17 exist only in
this checkout.

| Code | Outcome | Meaning |
| --- | --- | --- |
| 0 | `ok` | Command succeeded. `doctor` does not return this in this preview. For `skill`, the file is in place; discovery is still pending. |
| 1 | `internal_error` | Unexpected failure inside the CLI. |
| 2 | `invalid_input` | Unknown command or argument, or an invalid option value. No request was made. |
| 3 | `authentication_required` | Service is reachable, healthy and supported, and requires authentication. No workspace is connected. |
| 4 | `connection_failed` | The origin could not be reached, the connection failed, or the probe timed out. |
| 5 | `unhealthy` | The service answered but reported that it is not healthy, or answered with a server error. |
| 6 | `unsupported` | The service answered with a response, deployment profile or status this CLI does not support, or the skill client or runtime cannot use project skill files, or sign in cannot run in this environment. Nothing was written. |
| 7 | `redirect_rejected` | The service answered with a redirect. Redirects are never followed. |
| 8 | `conflict` | The skill target is not owned by this CLI, was modified, is unsafe, is locked or needs an explicit update, or the project is bound to a different origin or workspace. Nothing was changed. |
| 9 | `filesystem_error` | Project or credential files could not be read or written. Partial changes were rolled back unless the message says otherwise. |
| 10 | `authorization_failed` | Browser authorization did not finish: it was denied, cancelled, timed out or returned an invalid callback. Nothing was saved. |
| 11 | `verification_failed` | The service issued a grant that does not match the requested origin, workspace, client, resource or Metadata scope. Nothing was saved. |
| 12 | `login_required` | No usable sign in for this project: none was saved, it expired, was revoked, lost access or could not be refreshed safely. Run login again. |
| 13 | `revocation_unconfirmed` | Local credentials were removed, but the service did not confirm that the grant was revoked. |
| 14 | `capability_unavailable` | The service does not make this read available to the project's Metadata grant. No data was read. |
| 15 | `permission_denied` | The service refused this read for the signed in grant, for example for a missing scope or permission. |
| 16 | `rate_limited` | The service asked the CLI to slow down. Nothing was retried. Try again later. |
| 17 | `cancelled` | A read command was interrupted before it finished. Read commands never change workspace configuration or telemetry. |

## JSON output

With `--json`, every command prints one line with the same top-level keys:

```json
{
  "schema_version": 1,
  "command": "doctor",
  "ok": false,
  "outcome": "authentication_required",
  "exit_code": 3,
  "data": {
    "origin": "https://app.metergraph.dev",
    "reachable": true,
    "healthy": true,
    "deployment_profile": "managed",
    "profile_status": "supported",
    "authentication_required": true,
    "authenticated": false,
    "workspace": null,
    "checks": [
      { "name": "health", "path": "/healthz", "result": "pass", "http_status": 200, "reason": null },
      { "name": "deployment", "path": "/v1/deployment", "result": "pass", "http_status": 200, "reason": null },
      { "name": "capabilities", "path": "/v1/agent/capabilities", "result": "pass", "http_status": 401, "reason": "bearer_token_required" }
    ],
    "next_action": { "kind": "connection_guide", "url": "https://www.metergraph.dev/docs/guides/agent-access/" }
  },
  "error": {
    "code": "authentication_required",
    "reason": "bearer_token_required",
    "message": "The service is reachable and supported, and it requires authentication. No workspace is connected."
  }
}
```

(Shown formatted here. The CLI prints it on a single line.)

- `ok` is `true` only when `outcome` is `ok`. When `ok` is `false`, `error.code` equals
  `outcome` and `error.reason` is a fixed token such as `timeout`, `invalid_url`,
  `unrecognized_profile` or `response_too_large`.
- `profile_status` is `supported`, `unrecognized`, `unavailable` (the server has no
  `/v1/deployment` endpoint) or `unknown` (not checked).
- Checks that did not run have `result: "skipped"`.
- `--help --json` includes the command list and the exit code table.

A successful `skill install`:

```json
{
  "schema_version": 1,
  "command": "skill install",
  "ok": true,
  "outcome": "ok",
  "exit_code": 0,
  "data": {
    "client": "claude",
    "runtime": "local",
    "path": ".claude/skills/metergraph/SKILL.md",
    "status": "installed",
    "source": {
      "name": "metergraph",
      "revision": "sha256-90f7d8d78a5b",
      "sha256": "90f7d8d78a5b0b7a57436f194222f0c73310b0b04201c297c8fbf0b00ad6bb3f"
    },
    "discovery": "pending",
    "authenticated": false,
    "next_action": {
      "kind": "reload_client",
      "message": "Start or restart Claude Code in this project, then confirm that it lists the metergraph skill."
    }
  },
  "error": null
}
```

- `status` is `installed`, `updated` or `reused` (already in place, nothing rewritten).
- `path` is always relative to the project. Absolute paths are never printed.
- On failure `status` and `discovery` are `null`, and `error.reason` is a fixed token
  such as `not_owned`, `modified`, `update_required`, `not_installed`, `unsafe_path`,
  `receipt_invalid`, `locked`, `invalid_project`, `client_not_supported`,
  `write_failed` or `bundled_skill_invalid`.

A successful `login` (checkout only):

```json
{
  "schema_version": 1,
  "command": "login",
  "ok": true,
  "outcome": "ok",
  "exit_code": 0,
  "data": {
    "origin": "https://metergraph.example.com",
    "runtime": "local",
    "deployment_profile": "managed",
    "workspace": { "id": "0b5c7c1e-1a2b-4c3d-8e4f-5a6b7c8d9e01" },
    "scopes": ["agent:metadata"],
    "authenticated": true,
    "configured": true,
    "status": "signed_in",
    "binding": ".metergraph/project.json",
    "credential_protection": "owner_only_file",
    "previous_grant_revocation": null,
    "next_action": {
      "kind": "connected",
      "message": "This project is signed in with Metadata access. Run \"metergraph logout\" to sign out."
    }
  },
  "error": null
}
```

- `status` is `signed_in`, `reused` (already signed in and verified, nothing changed)
  or `reconnected` (a new grant replaced the previous one; `previous_grant_revocation`
  is then `accepted`, `unconfirmed` or `not_attempted`).
- `credential_protection` is `owner_only_file` or `dpapi`.
- On failure `authenticated` and `configured` are `false`, `scopes` is empty, and
  `next_action` is `null` or a handoff such as `connection_guide`, `reconnect`,
  `run_in_terminal` or `no_browser`.
- The schema version `1` is the version of this CLI's own JSON output. It is unrelated
  to the service's agent access contract version, `metergraph.agent-access/v1`.
- `login` and `logout` never print tokens, the authorization code, the PKCE verifier,
  user names, email addresses, workspace names, absolute paths or server text. The
  read commands never print tokens, email addresses, absolute paths or server error
  text either; `context` prints the workspace slug and name, and the read commands
  print validated route, trace, provider and model names, as described above.

`logout` prints `local_credentials` (`removed` or `none`), `binding` (`removed`,
`kept` or `none`) and `revocation` (`accepted`, `unconfirmed` or `not_attempted`).

Without `--json`, results are printed as text on stdout and usage errors go to stderr.
`login` prints progress lines, and with `--no-browser` the authorization URL, on
stderr.

## Safe origins

`--url` accepts only a bare origin, with an optional trailing slash:

- `https://` origins on any host, for example `https://metergraph.example.com`.
- `http://` only for `localhost`, `127.0.0.1` and `[::1]`, with an optional port.

Usernames, passwords, paths, queries and fragments are rejected before any request is
made. Invalid values and unknown arguments are not printed back, because a mistyped
argument can contain a credential. An accepted origin is printed in the output and sent
to the network, so do not put secrets in a hostname. See [Security](#security).

## Deployment profiles

The CLI recognizes these `deployment_profile` values: `local`, `managed` and
`byoc-core`. Managed staging uses the `managed` profile. Any other value is reported as `unsupported` and is not echoed. A server
without `/v1/deployment`, such as a self-hosted open source server, is reported as
`unsupported` with `profile_status: "unavailable"` until a dedicated adapter ships. The
CLI never assumes such a server is hosted.

## What doctor does not do

- It reads no credentials from environment variables, files, arguments or cookies, and
  sends no `Authorization` or `Cookie` header.
- It follows no redirects.
- It reads at most 32 KiB of any response body and stops at the `--timeout-ms` limit.
- It never prints response bodies, response headers, authentication challenges,
  server-supplied URLs or error text from the network stack.
- It makes no model provider calls, sends no usage data and reads no stored traces.

## What skill install does not do

- It makes no network requests and no model provider calls. The skill comes from this
  package, not from a download.
- It does not sign in, store credentials, configure MCP or edit client settings.
- It does not claim a client has loaded the skill. `discovery` stays `pending`.
- It never prints file contents, absolute paths or raw error text.

## What login does not do

- It never asks for Debug (`agent:read`) or Replay (`agent:replay`) access, and never
  falls back to them when the service does not offer `agent:metadata`.
- It never copies browser cookies or the browser's sign in.
- It does not create an application ingest key, and no manual API key is required. The
  service records the grant as an OAuth connection on its own side; that connection
  can only use `agent:metadata`, is separate from any API or ingest key you manage, and
  is what `logout` asks the service to revoke.
- It reads no telemetry, retained content or traces, and makes no model provider calls.
- It sends the grant only to the origin it came from, follows no redirects and reads
  bounded responses within fixed time limits.
- It accepts no credential on the command line, in the environment or on stdin.

## What the read commands do not do

- They never sign in, open a browser, create a grant or change the project binding.
  The only file they may write is the saved grant, when a refresh rotates it.
- They never request `agent:read` or `agent:replay`, never read retained content,
  evidence or replays, and never call a model provider.
- They make only `GET` requests to the read endpoints (a grant refresh, when needed, is
  the only `POST`). They send no ingest data and change no evaluations, provider
  settings, workspace configuration or telemetry. The service may still record the
  access, for example audit entries and the grant's last used time.
- They never print a token the CLI holds, even inside an otherwise valid name.
- They never follow a cursor or page on their own, and never widen a request: an
  unsupported option, an out of range value or a capability the grant lacks fails
  instead.
- They accept no credential on the command line, in the environment or on stdin.

## Development

```sh
npm test                  # unit tests and CLI subprocess tests against loopback servers
npm run test:package      # npm pack into a temporary directory, clean install, run the installed bin
node bin/metergraph.js --help
node bin/metergraph.js doctor --url http://127.0.0.1:8080 --json
node bin/metergraph.js skill install --client claude --runtime local --project /path/to/project --json
node bin/metergraph.js login --runtime local --url http://127.0.0.1:8080 --project /path/to/project
```

The sign in and read command tests run against a synthetic loopback service and a
test-only browser stand-in loaded with `--import`. They prove the protocol, file
handling and output rules, not the real service, a real browser, real workspace
consent or real workspace data. The Windows DPAPI round trip
runs only on the Windows CI runner.

To try a packed artifact without publishing:

```sh
npm pack --pack-destination "$(mktemp -d)"
npx --yes --package=/path/to/metergraph-cli-0.2.0-preview.0.tgz -- metergraph --version
```

Do not commit tarballs or other generated files.

## Releasing

The source of truth is the public repository
[github.com/metergraph/cli](https://github.com/metergraph/cli), licensed Apache-2.0.
The first preview uses the `next` npm tag. `0.1.0` is the only published version.
This checkout's `0.2.0-preview.0` is not published and must not be published until
the service side of sign in and the Metadata read endpoints are released. Subsequent releases must pass the checks
below before publication.

Releases are manual. The `Release CLI` workflow (`.github/workflows/release.yml`) runs
only when a maintainer starts it from `main`. It does not run on tags, pushes or a
schedule. It:

1. checks that `commit_sha` equals the commit the run started from (see
   [Exact revision rule](#exact-revision-rule)), that it is on `main`, and that
   `version` equals `package.json`;
2. asks the npm registry for that exact version and continues only on a `404`. An
   existing version, any other status or a network failure stops the run;
3. runs `npm test` and `npm run test:package` at that commit;
4. packs the tarball and records its SHA-256;
5. only if `publish` is true, waits for approval on the `npm-release` environment,
   checks out the same commit again, verifies the checksum and runs
   `npm publish --provenance` for that exact tarball.

Leave `publish` false for a dry run that validates and packs without publishing.

### Exact revision rule

npm provenance records the commit that triggered the workflow (`GITHUB_SHA`) as the
source of the package. To keep that statement true, the workflow only releases that
commit:

- `commit_sha` must be the full 40 character SHA of the current head of `main`, and it
  must equal `GITHUB_SHA` for the run. Older commits on `main` are rejected even though
  they are ancestors of `main`.
- Both the validate job and the publish job check out that commit and confirm it.
- If `main` moves after you copy the SHA, the run fails. Start a new run with the new
  head. To release an older state, land it on `main` first.

### First package bootstrap

npm trusted publishing is configured on a package that already exists, so the very
first version cannot come from this workflow. Creating the package is a one time,
human step that a Metergraph maintainer must approve and perform. Nothing in this
repository automates it, and no npm token or secret is stored here.

1. Confirm the intended npm maintainer accounts and that `metergraph-cli` is
   available. The first approved publish establishes package ownership.
2. Run the `Release CLI` workflow with `publish` false. Download the
   `metergraph-cli-release` artifact and check its SHA-256 against the run summary.
3. From a maintainer machine with npm two-factor authentication, publish that exact
   tarball manually using `npm publish /path/to/metergraph-cli-0.1.0.tgz --access public
   --tag next --provenance=false --ignore-scripts`. This bootstrap version has no
   provenance attestation. Use a new version for the first trusted release.
4. Configure trusted publishing as described below.

### Trusted publishing

After the package exists, follow the official npm guide,
[Trusted publishing for npm packages](https://docs.npmjs.com/trusted-publishers/), and
add a GitHub Actions trusted publisher with exactly these values:

| Field | Value |
| --- | --- |
| Organization or user | `metergraph` |
| Repository | `cli` |
| Workflow filename | `release.yml` |
| Environment name | `npm-release` |

Trusted publishing requires npm 11.5.1 or newer. The publish job checks this before it
publishes. After the trusted publisher works, consider restricting the package to
trusted publishing so that long lived tokens cannot publish it.

### Remaining maintainer setup

The source repository and license are settled. Before any automated release, a
maintainer still has to:

- complete the [first package bootstrap](#first-package-bootstrap);
- configure the [trusted publisher](#trusted-publishing);
- create the `npm-release` environment with required reviewers;
- set the repository variable `METERGRAPH_CLI_PUBLISH_ENABLED` to `true`.

Until all of these are done, leave `publish` false.

### After a release

After each release, confirm from a clean machine, replacing `VERSION`:

```sh
npx --yes metergraph-cli@VERSION --version --json
npx --yes metergraph-cli@VERSION doctor --json
npm view metergraph-cli@VERSION dist.attestations
```

Releases from the workflow should show a provenance attestation that names
`metergraph/cli` and the released commit. The bootstrap version will not.

## Security

Report security issues privately through
[GitHub private vulnerability reporting](https://github.com/metergraph/cli/security/advisories/new)
for `metergraph/cli`. Do not open a public issue, and do not include real credentials,
tokens or customer data in a report. The security policy and the CLI's security
properties are in `SECURITY.md` in the
[source repository](https://github.com/metergraph/cli); it is not shipped in the npm
package.

## License

Apache-2.0. See [LICENSE](LICENSE).
