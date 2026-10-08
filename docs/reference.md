# metergraph CLI reference

Full reference for the `metergraph` command. For installation, the quickstart and
exit codes, see the [README](../README.md). Every command also prints its options with
`metergraph help COMMAND`, and `metergraph --help --json` returns the command list and
exit code table in machine-readable form.

Sign in needs a Metergraph service that offers Metadata-only CLI grants and grant
revocation. A service without them is reported as unsupported, and the CLI never falls
back to broader access. The read commands need a project signed in with `login` or
`setup`. `setup` also needs the deployment's ingest bootstrap API and browser approval
by a workspace member.

- [Command summary](#command-summary)
- [doctor](#doctor)
- [skill install and skill update](#skill-install-and-skill-update)
- [login and logout](#login-and-logout)
- [setup](#setup)
- [Read commands](#read-commands)
- [Exact trace verification](#exact-trace-verification)
- [JSON output](#json-output)
- [Safe origins](#safe-origins)
- [Deployment profiles](#deployment-profiles)
- [What each command does not do](#what-doctor-does-not-do)

## Command summary

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
metergraph setup --runtime local (--client codex|claude|cursor | --skip-skill) [--deployment managed|customer-local|byoc|oss] [--url ORIGIN] [--workspace UUID] [--confirm-prerequisites] [--agent-token-file FILE] [--project DIR] [--config-dir DIR] [--env-file .env] [--timeout-ms N] [--signup] [--reconnect] [--no-browser] [--repair] [--json]
metergraph status [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph context [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph capabilities [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph usage [--days N] [--limit N] [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph routes [--limit N] [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph traces [--days N] [--limit N] [--route NAME] [--status success|error] [--cursor CURSOR] [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph verify (--trace-id ID | --request-id ID) --since TIME --until TIME [--source application|synthetic|demo|import|unspecified] [--days N] [--timeout-ms N] [--poll-ms N] [--max-attempts N] [--open] [--no-browser] [--project DIR] [--config-dir DIR] [--json]
```

`--help`, `--version` and the `skill` commands work offline and make no network
requests. `login`, `logout`, `setup`, `verify` and the read commands are not in the published `0.1.0`
package.

### Exact trace verification

After an application invocation, pass its exact trace ID or request ID and the
invocation start and end timestamps to `verify`. The optional `--source` label is a
caller assertion. A matching Metadata row proves a processed trace is visible in the
bound workspace, but does not independently prove that it came from your application.
The result therefore keeps `application_traffic_verified: false` until a separate
application instrumentation check supplies that evidence. A missing, ambiguous, stale
or wrong-workspace result fails closed. The command neither creates an ingest key nor
sends a test event.

`--open` launches only a server-provided link carrying the exact trace and the
verified workspace ID. The dashboard must check that ID against its signed-in
workspace before displaying traces. Older links without a workspace remain a
manual handoff; a conflicting workspace or unsafe link is refused. The result's
`browser` field is `launcher_started`, `launcher_unavailable`, `not_requested`
(no `--open`), or `suppressed_by_json` / `suppressed_by_no_browser` when `--open`
was given but that flag returned the link instead of launching it.

If `--timeout-ms` expires after the service has answered at least once with a
pending result, `verify` exits 11 `verification_failed` with reason
`trace_not_found_within_bounds`, the same result as running out of
`--max-attempts`: the origin is reachable and the trace is not visible yet. Exit 4
`connection_failed` is kept for transport failures. Its reason is
`verification_timeout` when no valid answer arrived before the deadline. A deadline
while `--open` launches a trace that was already found exits 11 with
`verification_timeout`.

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

`assets/skill/SKILL.md` is a byte-for-byte copy of `skills/metergraph/SKILL.md` in
[metergraph/skills](https://github.com/metergraph/skills), the source of every
Metergraph skill, at the commit pinned in `skills-source.json`. The same file is
published at <https://www.metergraph.dev/SKILL.md>. To take a new revision, run
`node scripts/sync-skill.mjs --from <skills checkout> [--commit SHA]`; it updates both
bundles, both manifests, every pinned hash and the pin. CI runs
`node scripts/sync-skill.mjs --check` and fails if the bundles differ from the pinned
file. The source has no version number of its own, so
`assets/skill/manifest.json` records its source URL, size and SHA-256, and a revision
derived from that hash (`sha256-` followed by the first 12 hex digits). The package
version is not the skill version. At runtime the CLI checks the bundled file against a
hash pinned in its code and in the manifest, and refuses to write anything if either
does not match. It never downloads the skill or runs a remote script. A new skill
revision ships only in a new CLI release; `skill update` then upgrades projects that
hold an unchanged earlier revision.

#### From Python

The same installer is published for Python as
[`metergraph-skills`](../python/metergraph-skills/README.md). It bundles the same
`SKILL.md` and writes the same paths and receipt, so either installer recognises and
updates what the other wrote. `scripts/sync-skill.mjs` updates both copies together;
CI fails while they differ.

### login and logout

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
| `--no-browser` | off | Print the authorization URL on stderr for you to open on this machine, then wait. With `--json`, a rerun that needs no approval succeeds; one that needs approval exits 6 `no_browser_requires_terminal` with a `run_in_terminal` next action. |
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
4. Chooses the OAuth client for a loopback redirect, `http://127.0.0.1:PORT/callback`
   on an ephemeral port. When the service's OAuth metadata names a pre-registered
   Metergraph CLI client in `metergraph_cli_client_id`, the CLI uses that client and
   registers nothing; the service accepts the loopback redirect on any port (RFC 8252
   section 7.3). Otherwise it registers a new public client named `Metergraph CLI` for
   that one redirect, as servers without the field expect. A malformed value stops
   sign in. The CLI then creates a random state and PKCE verifier, and arms the callback
   listener and its timeout before the browser opens.
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
8. Saves the grant in the config directory and writes `.metergraph/project.json`. The
   saved grant keeps the client ID it was issued to, so a grant from a registered client
   still refreshes and revokes after the service starts offering a pre-registered one.

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

### setup

Run setup once from a project directory, choosing the coding client that will use
the skill:

```sh
metergraph setup --runtime local --client codex --project /path/to/project
```

For a customer-local bundle, point setup at its installed origin and exact
workspace:

```sh
metergraph setup --runtime local --deployment customer-local --url http://localhost:8080 --workspace 11111111-1111-4111-8111-111111111111 --confirm-prerequisites --client codex
```

`--confirm-prerequisites` records the operator's attestation that the released
signed bundle, registry invitation, local admin, and separate Metadata access
prerequisites are ready. It is not proof of bundle publication or registry
access. Setup checks the live deployment profile before login. BYOC uses
`--deployment byoc` and an explicit HTTPS private origin; its provisioning,
network, and identity prerequisites remain the operator's work. An optional
`--agent-token-file` can verify a separate Metadata credential for either
route. OSS uses separate `MG_TOKENS` ingestion and `MG_AGENT_TOKENS` read
credentials; `--deployment oss` verifies its Metadata route with a private
agent token file and hands ingest configuration to the operator. It does not
try hosted login or ingest bootstrap against OSS. Remote runtimes are handed
off to a local machine, with no implicit tunnel or credential forwarding.

If the project has no usable Metadata sign in, `setup` opens the deployment's
browser sign in and workspace choice. `--signup` starts at hosted sign up;
`--workspace UUID` requires that exact workspace. An existing binding to a
different origin or workspace requires explicit `--reconnect`. The selected
deployment must advertise `metergraph.cli-setup/v1` on its own origin. Its setup
metadata may name a pre-registered CLI client in `metergraph_cli_client_id`, which
setup then uses for ingest approval instead of registering a new client. Setup
refuses reconnecting an existing ingest family to another workspace; its
original workspace must be restored before that family can be reused. Setup
checks the env file and Git state, then opens the deployment's consent page. An
owner or member of the verified workspace approves an ingest-only key. The CLI
redeems the single-use receipt, writes `METERGRAPH_APP_TOKEN` and
`METERGRAPH_INGEST_URL` into `.env`, checks the new key with the service, and
acknowledges delivery. It then installs the bundled skill for `codex`, `claude`
or `cursor`. Use `--skip-skill` only if you intentionally want to install it
later. Neither sign in nor setup requests Debug or Replay access. The browser
page shows the workspace and the consequence of approval. A signed-in browser
on another workspace must switch in Metergraph and rerun; the CLI does not
switch it automatically.

`METERGRAPH_INGEST_URL` is the deployment's service root. The Python SDK
appends `/v1/ingest` itself. A setup rerun with a verified
key repairs the endpoint value written by the first preview without minting a
new key.

The env file must be a project-relative `.env`, `.env.<name>` or `<name>.env`
(`--env-file` selects another). The writer refuses tracked files, links,
ambiguous dotenv syntax and unsafe paths. It adds a project `.gitignore` rule
when needed and makes the env file private; Windows uses a user-only ACL.
The env token is never printed, read from argv or stdin, or copied to the
project's setup state file. An already working key is checked and reused without
another browser approval.

`.metergraph/setup.json` holds a family UUID, its current key ID and fixed state,
but no credential. It is written before approval. If the redemption response is
lost, a rerun asks for a new browser approval for that same family. The server
resolves the request to creation if no key was issued or replacement of that
family's pending key if one exists; the old receipt is not retried. If an
acknowledged key no longer verifies or its env file was lost, use `--repair`
to explicitly approve replacement of that exact key.
An unsafe or changed state file is refused. If the earlier approval never
reached redemption, rerun the command; the `create` intent is still safe.

The JSON result includes a secret-free `receipt` with the origin, workspace ID,
deployment profile, selected client, and completed and pending steps. A skill
conflict leaves the delivered key in place and reports `credential_ready_skill_pending`;
resolve the skill file conflict and rerun setup without another approval.
With `--no-browser`, setup prints the approval URL on stderr instead of opening a
browser. Under `--json` it cannot show that URL, so a rerun that needs no approval
(a working saved key) still succeeds, and one that needs approval exits 6
`no_browser_requires_terminal` before any approval request or env write, with
`data.next_action` set to `{"kind": "run_in_terminal", "message": "..."}`. The
message is fixed text and holds no URL or credential. Non-hosted operator
handoffs carry their own deployment `next_action`; every other setup result has
`next_action: null`.
Success means the key was delivered and the project is ready to instrument.
It does **not** mean application traffic has arrived. Run your application and
verify one exact trace afterward. The hosted service advertises the setup
contract, but each non-hosted deployment must be checked at its own origin.
Local protocol tests do not prove browser approval or real application traffic.

#### Repository identity

After the key is ready, setup records which repository the project belongs to,
so traces from several repositories in one workspace stay apart. The SDKs read
`METERGRAPH_REPOSITORY`, then the nearest `.metergraph/config.json`:

```json
{
  "version": 2,
  "repository": "example-org/example-app"
}
```

Setup takes `owner/name` from `--repository`, or else from the git `origin`
remote (or the only remote). It writes `.metergraph/config.json` in the project
directory only when no identity exists yet. The file holds no secret; review
and commit it. An identity already set in `METERGRAPH_REPOSITORY` in the env
file, or in a `.metergraph/config.json` in the project or a parent directory, is
kept. If it differs from the remote or `--repository`, setup reports a mismatch
and changes nothing. Setup never rewrites a config file the SDKs cannot use.
Remotes with nested groups are not guessed; pass `--repository OWNER/NAME`.
`--no-repository` records nothing.

The JSON result reports the outcome in `data.repository`: `status` is
`written`, `existing`, `mismatch`, `invalid_config`, `not_inferred`,
`write_failed` or `skipped`, with the `repository`, its `source`
(`git_remote`, `flag`, `config` or `env_file`), the config `path`, and, for a
mismatch, the `expected` value. Only `owner/name` is reported, never a remote
URL. Recording an identity never fails setup.

With an identity configured, the SDKs exchange the ingest key for a
repository-scoped session before sending traces. Without one they keep the
older ingestion path and log that the identity is not configured; capture
continues either way.

Several repositories can send to one workspace. Run `setup` once in each
repository, so each has its own project binding and private `.env`; pass the
same `--workspace UUID` each time to pin the workspace; and give each
repository its own identity.

### Read commands

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
- The `traces` listing prints no trace links; each row has `link: null` and the
  page reports `link_status: "server_link_unavailable"`. Exact-trace
  `verify --open` uses a server link only when it includes the verified
  workspace binding.
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
      "revision": "sha256-0a80fb6effed",
      "sha256": "0a80fb6effed5fada241f2a672f0390d278ccacf9988265f94824dc5e54d8b6c"
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

A successful `login`:

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
to the network, so do not put secrets in a hostname. See [Security](../README.md#security-and-privacy).

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
