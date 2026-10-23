# metergraph CLI reference

Full reference for the `metergraph` command. For installation, the quickstart and
exit codes, see the [README](../README.md). Every command also prints its options with
`metergraph help COMMAND`, and `metergraph --help --json` returns the command list and
exit code table in machine-readable form.

Sign in needs a Metergraph service that offers Metadata CLI grants and grant
revocation. A service without them is reported as unsupported, and the CLI never falls
back to broader access. The read commands need a project signed in with `login` or
`setup`. `setup` also needs the deployment's ingest bootstrap API and browser approval
by a workspace member.

- [Command summary](#command-summary)
- [doctor](#doctor)
- [skill install and skill update](#skill-install-and-skill-update)
- [skills install, update and list](#skills-install-update-and-list)
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
metergraph skill install --client CLIENT [--runtime RUNTIME] [--project DIR] [--json]
metergraph skill update --client CLIENT [--runtime RUNTIME] [--project DIR] [--json]
metergraph help skills [--json]
metergraph skills install --client CLIENT [--runtime RUNTIME] [--project DIR] [--json]
metergraph skills update --client CLIENT [--runtime RUNTIME] [--project DIR] [--json]
metergraph skills list [--project DIR] [--json]
metergraph help login [--json]
metergraph login --runtime local [--url ORIGIN] [--workspace SLUG] [--role metadata|debug] [--allow-evaluation-writes] [--allow-evaluation-previews] [--allow-analysis-starts] [--project DIR] [--config-dir DIR] [--timeout-ms N] [--signup] [--no-browser] [--reconnect] [--json]
metergraph logout [--project DIR] [--config-dir DIR] [--json]
metergraph setup --runtime local (--client codex|claude|cursor | --skip-skill) [--deployment managed|customer-local|byoc|oss] [--url ORIGIN] [--workspace UUID] [--confirm-prerequisites] [--agent-token-file FILE] [--project DIR] [--config-dir DIR] [--env-file .env] [--timeout-ms N] [--signup] [--reconnect] [--no-browser] [--repair] [--json]
metergraph status [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph context [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph capabilities [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph usage [--days N | --today | --since TIME [--until TIME]] [--group-by DIMS] [--route NAME]... [--provider NAME]... [--model NAME]... [--environment NAME]... [--sort ORDER] [--compare previous|previous-same-time] [--limit N] [--metadata KEY=VALUE]... [--metadata-json JSON] [--group-by-metadata KEY] [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph routes [--limit N] [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph traces [--days N] [--limit N] [--route NAME] [--status success|error] [--metadata KEY=VALUE]... [--metadata-json JSON] [--cursor CURSOR] [--project DIR] [--config-dir DIR] [--timeout-ms N] [--json]
metergraph verify (--trace-id ID | --request-id ID) --since TIME --until TIME [--source application|synthetic|demo|import|unspecified] [--days N] [--timeout-ms N] [--poll-ms N] [--max-attempts N] [--open] [--no-browser] [--project DIR] [--config-dir DIR] [--json]
metergraph experiments list [--workload ID] [--limit N] [--project DIR] [--config-dir DIR] [--timeout-ms N] [--url ORIGIN] [--workspace SLUG] [--agent-token-file PATH] [--json]
metergraph experiments estimate --workload ID --treatment SPEC [--treatment SPEC]... [--last-n N] [--sample-model MODEL] [--track PATH]... [read options] [--json]
metergraph experiments start --workload ID --treatment SPEC [--treatment SPEC]... [--last-n N] [--sample-model MODEL] [--track PATH]... [--agent-token-file PATH] [read options] [--json]
metergraph experiments get --id UUID [read options] [--json]
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
the best result this release can report: the service is reachable, but this CLI holds
no credentials, so `authenticated` is always `false` and `workspace` is always `null`.
A reachable service is not a working workspace connection. To connect an application,
follow the [connection guide](https://www.metergraph.dev/docs/guides/agent-access/).

`doctor` never opens a browser, never prompts and never reads stdin, so it is safe in
scripts and CI.

### skill install and skill update

`skill install` copies the Metergraph skill bundled with this CLI into one client's
native project skill directory. `--client` is required, so the command never guesses
which client loads the skill. `--runtime` defaults to `local`, the runtime `setup`
installs the skill for; pass `--runtime cloud` when the client runs in a cloud checkout.

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
| `--runtime RUNTIME` | `local` | `local` when the client runs on this machine, `cloud` when it runs in a cloud environment with a shell and a checkout of the project. Recorded, not detected. |
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

### skills install, update and list

`skills install` copies the Metergraph workflow skills bundled with this CLI into one
client's project skill directory, one folder per skill. They come from
[metergraph/skills](https://github.com/metergraph/skills) at the commit pinned in
`skills-source.json`, and cover investigation and model swap: choose a
workload, choose traces and models, define the eval, run the analysis, summarize the
report and rerun. Start with the `metergraph-model-swap` skill. The pack also has
`metergraph-local-bundle`, which verifies and starts the signed customer-local bundle
on the person's own machine before `setup --deployment customer-local`. The setup skill,
`metergraph`, is not part of the pack; `skill install` installs it.

`--client`, `--runtime` and `--project` work as for `skill install`. For each bundled
skill it writes, and nothing else:

1. `<client dir>/skills/<name>/SKILL.md`, for example
   `.claude/skills/metergraph-model-swap/SKILL.md`.
2. `.metergraph/skills/<name>.json`, that skill's ownership receipt, in the same shape
   as `.metergraph/skill-installations.json`. The lock is
   `.metergraph/skills/<name>.lock`.

Each skill follows the ownership rules of `skill install` on its own: an unowned or
edited skill is never replaced, and a conflict on one skill does not stop or roll
back the others. The command exits with the first failure's code, and
`data.skills[].status` says what happened to each skill (`installed`, `updated`,
`reused` or `failed` with a `reason`). `update` replaces older revisions this CLI
installed and also installs skills added to the pack since.

`skills list` takes only `--project`. It reports each bundled skill's revision and,
for each client, whether it is `installed`, `outdated`, `modified`, `missing`,
`not_owned` or `not_installed`. It never writes and takes no lock.

`--client claude-desktop` exits 6 with `client_not_supported` and writes nothing. Its
`next_action` has `kind: "plugin_marketplace"`: in Claude Desktop, open Customize →
Plugins → Add marketplace and enter `metergraph/skills`, or upload a skill zip from the
repository's latest release under Customize → Skills. `--client chatgpt` and
`--runtime cloud-no-shell` get the connection guide, as for `skill install`.

The skills are verified before anything is written: `assets/skills/manifest.json`
lists each skill's SHA-256, and the manifest's own hash is pinned in the code. A
mismatch exits 1 with `bundled_skill_invalid`.

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
| `--runtime RUNTIME` | required | Where this terminal runs, not which Metergraph service you sign in to. `local`: your own machine, where the browser runs; use it for the hosted service too. `cloud` and `cloud-no-shell`: a remote cloud sandbox, which gets a handoff to the [connection guide](https://www.metergraph.dev/docs/guides/agent-access/) with exit code 6. |
| `--url ORIGIN` | `https://app.metergraph.dev` | Bare origin only, see [Safe origins](#safe-origins). |
| `--workspace SLUG` | none | The workspace you expect, by its slug (on its Settings page, and in `metergraph context`) or its name; an ID also works. A service that advertises `metergraph_workspace_hint_supported` gets it as `workspace_hint` and offers approval for that one workspace; where the name matches none or several of your workspaces, the consent page says so and sign in exits 2 (`workspace_hint_unknown` or `workspace_hint_ambiguous`, next action `use_workspace_slug`). Without that support, a name exits 6 (`workspace_name_unsupported`) before the browser opens, and a slug is checked after sign in. Sign in fails unless the browser grants this workspace (exit 11, `workspace_mismatch`). The match is strict, because anyone who owns a workspace chooses its name: text shaped like a slug (lower-case letters, digits and hyphens) matches only the slug, and other text only the exact name, ignoring case. Without it, the workspace you choose in the browser is used after the service confirms it. |
| `--role ROLE` | `metadata` | `metadata`: the Metadata scope (`agent:metadata`). `debug`: the Debug role (`agent:read`), with the workflow permissions the options below add. Replay is never asked for. The read commands, `tools` and `status` then use the grant, and `status` and `login --json` report it in `data.access`. Rerunning with another role or other permissions than the saved grant signs in again for the same workspace and replaces it. |
| `--allow-evaluation-writes` | off | With `--role debug`: Allow evaluation writes (`agent:eval-write`). Only a workspace owner can approve a workflow permission. Without `--role debug`, exits 2 with `permission_needs_debug` before any request. |
| `--allow-evaluation-previews` | off | With `--role debug`: Allow evaluation previews (`agent:eval-preview`). |
| `--allow-analysis-starts` | off | With `--role debug`: Allow analysis starts (`agent:analysis-run`), which replays captured prompts on model providers and spends money. |
| `--project DIR` | current directory | Existing project directory to bind. |
| `--config-dir DIR` | see below | Private per-user directory for the saved grant. |
| `--timeout-ms N` | `300000` | How long to wait for the browser, 1000 to 900000. |
| `--signup` | off | Start at the hosted sign up page, which returns to the same authorization request. Managed service only; other profiles exit 6. |
| `--no-browser` | off | Print the authorization URL on stderr for you to open on this machine, then wait. With `--json`, a rerun that needs no approval succeeds; one that needs approval exits at once with 18 `action_required` and an `open_url` next action, while a background process waits for the approval. See [Approval from an agent](#approval-from-an-agent). |
| `--reconnect` | off | Allow replacing a binding to a different origin or workspace. |
| `--json` | off | Print exactly one JSON line on stdout and nothing on stderr. |

What `login` does, in order:

1. Refuses cloud runtimes, SSH sessions, cloud development environments and CI (by the
   presence of variables such as `SSH_CONNECTION`, `CODESPACES` or `CI`; values are
   never read into output) before any request, listener or file write, with a
   `use_agent_key` next action (see [Where the agent runs](#where-the-agent-runs)). A
   local container (`/.dockerenv`, `/run/.containerenv`, `REMOTE_CONTAINERS`,
   `DEVCONTAINER` or `container`, with no remote marker) is not treated as remote.
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

Run by a person at a terminal (stdin and stdout both terminals, no `--json`, no
`CI`), setup asks for what its flags leave out instead of failing: where Metergraph
runs, the address and workspace of a non-hosted installation, whether its
prerequisites are done, and which client gets the skill. It assumes `--runtime
local`, offers a bundle answering on `http://localhost:8080` as the default (a
remote session is not probed, so it sends no request before its handoff), and
resumes a project's saved route without asking about it. Flags already given are
never asked for. The answers become ordinary flags, and setup prints the full
command (`Running: metergraph setup ...`) before running it, so it can be rerun
without questions. A command that does not parse is not printed: its error never
echoes the refused value. Ctrl-C or Ctrl-D at a question exits with 17 `cancelled` and
changes nothing. An agent or script never gets a question: it keeps the flag errors
and the handoffs below.

If the bundle is not running yet, setup returns the `complete_prerequisite` handoff
below. The `metergraph-local-bundle` skill from `skills install` walks a coding agent
through downloading, verifying and starting it first; the CLI itself provisions nothing.

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
off to a local machine, with no implicit tunnel or credential forwarding. A
session with SSH, cloud workspace or CI markers is refused as
`run_on_local_machine` before any request is sent or the agent token file is
read. Its next action names the local command and, under `metadata_reads`, the
`use_agent_key` steps for Metadata reads from the remote environment.

The hosted service and the released customer-local bundle are the release
targets. The `byoc` and `oss` routes are implemented and covered by synthetic
tests, but have not been verified against a live deployment.

A non-hosted handoff has `data.status: "operator_handoff"`,
`data.pending_prerequisites` listing every prerequisite not yet confirmed, and
`data.next_action` set to
`{"kind": "...", "prerequisite": null | "...", "url": "...", "message": "..."}`.
`message` is fixed guidance for that kind or prerequisite. Without `--json`,
setup prints each pending prerequisite with its guidance. The kinds are:

| `kind` | When |
|---|---|
| `complete_prerequisite` | A prerequisite is not confirmed, or a customer-local origin is unreachable (`prerequisite: "bundle_started_verified"`) |
| `check_private_network` | A BYOC origin is unreachable |
| `run_on_customer_machine` | The runtime or session is not the customer's machine |
| `use_https_origin` | BYOC was given a non-HTTPS origin |
| `oss_operator_handoff` | An OSS step only the server operator can complete |
| `connection_guide` | Profile mismatch, redirect or another service response |
| `platform_credential_handoff`, `fix_credential_file`, `use_metadata_only_credential` | The `--agent-token-file` cannot be used |

The prerequisites each deployment needs confirmed are:

| Deployment | Prerequisites |
|---|---|
| `customer-local` | `released_signed_bundle`, `registry_invitation`, `bundle_started_verified`, `local_admin_configured`, `metadata_agent_credential` |
| `byoc` | `operator_provisioning`, `private_network_reachability`, `identity_membership_configured`, `metadata_agent_credential` |
| `oss` | `server_distribution_installed`, `deployment_discovery_supported`, `metadata_scope_supported`, `ingestion_tokens_configured`, `agent_read_tokens_configured`, `metadata_agent_credential` |

Each deployment keeps its credentials apart. The customer-local registry pull
credential is only for pulling the bundle's images, and setup never reads it.
The local admin signs in only in the browser. The ingest key comes only from
setup's single-use redemption and is written only to the env file. A separate
`--agent-token-file` token is read from its private file and sent only to
`/v1/agent/workspace` and `/v1/agent/capabilities`, before any sign in. It is
never written anywhere, and setup stops if it grants content, replay or any
access beyond Metadata. For OSS, `MG_TOKENS` ingestion tokens and
`MG_AGENT_TOKENS` read tokens stay with the operator: setup verifies only the
read token and never issues or writes an OSS ingest token.

Setup gives the agent Metadata access only. A successful customer-local setup
also returns `data.agent_access`, saying how the bundle gives the agent more
without a sign in:

```json
{
  "role": "metadata",
  "offer": {
    "kind": "bundle_agent_key",
    "run_in": "bundle_directory",
    "command": "./bin/agent-key create --write-to ~/.config/metergraph/agent.env --role debug --allow-evaluation-writes --allow-evaluation-previews --allow-analysis-starts",
    "requires_person_approval": true,
    "keys_page_url": "http://localhost:8080/#api-keys",
    "message": "..."
  }
}
```

`bin/agent-key` ships in the bundle. It issues a coding-agent key attributed to
the local admin, shows what each grant allows and asks to confirm (outside a
terminal it needs `--yes`), and writes the key only to the named private file,
never printing it. The command text is fixed in this CLI, never taken from the
service. An agent relays the offer and runs the command only after the person
agrees to that access; a bundle without `bin/agent-key` uses `keys_page_url`
instead. At a terminal, setup asks instead. The person types the bundle directory
(nothing in the current project is offered as a default), which must hold
`bin/start`, `docker-compose.yml` and the release manifest. Setup runs that
bundle's `bin/agent-key` only if the person owns it and nobody else can change
it, and only after naming its full path and asking. `bin/agent-key` then asks
for its own confirmation, and setup prints how to load the key and add the MCP
server for the chosen client. On Windows, where the bundle runs inside WSL, setup
prints the command to run there instead of asking. A hosted setup has no `agent_access`.

A rerun of customer-local or BYOC setup can omit `--deployment`, `--url`,
`--workspace` and `--confirm-prerequisites`, as a hosted rerun does. Setup then
resumes the route saved in `.metergraph/setup.json`, and checks the live
profile and sign in again. A rerun cannot move the project to another
deployment, origin or workspace: those stop with a conflict or a handoff, and
nothing is changed.

If the project has no usable Metadata sign in, `setup` opens the deployment's
browser sign in and workspace choice. `--signup` starts at hosted sign up;
`--workspace UUID` requires that exact workspace. An existing binding to a
different origin or workspace requires explicit `--reconnect`. The selected
deployment must advertise `metergraph.cli-setup/v1` on its own origin. Its setup
metadata may name a pre-registered CLI client in `metergraph_cli_client_id`, which
setup then uses for ingest approval instead of registering a new client. Setup
refuses reconnecting an existing ingest family to another workspace; its
original workspace must be restored before that family can be reused. An env
file that already holds a `METERGRAPH_APP_TOKEN` this setup did not issue stops
with `existing_ingest_key_unowned` before any sign in, so the refusal costs no
approval. Setup checks the env file and Git state, then opens the deployment's consent page. An
owner or member of the verified workspace approves an ingest-only key. The CLI
redeems the single-use receipt, writes `METERGRAPH_APP_TOKEN` and
`METERGRAPH_INGEST_URL` into `.env`, checks the new key with the service, and
acknowledges delivery. It then installs the bundled skill for `codex`, `claude`
or `cursor`. Use `--skip-skill` only if you intentionally want to install it
later. Neither sign in nor setup requests Debug or Replay access. The browser
page shows the workspace and the consequence of approval. A signed-in browser
on another workspace must switch in Metergraph and rerun; the CLI does not
switch it automatically.

When setup has to sign in for a first setup, and the service's setup discovery
reports `login_ingest_setup_supported: true`, the sign-in consent page also
asks to create the ingest key, so the person approves once. The page names
both effects. The approval returns two separate credentials: the Metadata
sign-in grant, and a single-use ingest receipt bound to a new setup family,
each with its own PKCE verifier. Setup redeems the receipt exactly as above.
Signing out does not revoke the ingest key, and revoking the key does not sign
the CLI out. A service without that field, a project that is already signed
in, `--repair` and a replacement after a lost response all use the separate
ingest-only approval.

The service may limit how many ingest keys setup can issue: per person and per
workspace each minute, and a cap on a workspace's active CLI setup keys. When
redemption is refused with `429` and a `Retry-After` of at most 60 seconds,
setup waits and redeems the same approval again, up to two times, so the
person does not approve twice. If the budget stays exhausted, setup exits
`rate_limited` (16) with reason `setup_rate_limited` and a `retry_later` next
action carrying `retry_after_seconds`. At the cap, setup exits `conflict` (8)
with reason `setup_key_limit` and a `revoke_keys` next action whose `url` is
the Keys page. Neither refusal issues a key or writes `.env`.

A foreground run reports a refusal directly and records nothing, so the run
after the person waits or revokes keys proceeds. With `--json --no-browser`
the background waiter meets the redemption after the command has exited, so
the waiter alone records what it is doing in `.metergraph/setup-refusal.json`
(the family, the waiter's process, the approval it came from and a reason;
never a credential). As soon as it receives an approval it records that it is
redeeming; a rerun while that process is alive exits `conflict`
(`setup_in_progress`) with a `retry_later` next action instead of asking for
another approval. That applies only to the saved family, or before any
setup state is saved; a second waiter never replaces a live one's record
unless it wins the setup state for its own redemption. If the service
refuses the redemption, the waiter records
the refusal, and the next run reports it: a rate refusal until its retry
time, a key-limit refusal once. Any successful run, including one that reuses
a verified key, removes the record, and a record for another family, an
already delivered family, a dead process or past its expiry is ignored and
removed. Because the file is in the project, a record can delay setup by at
most the time this CLI writes it for (ten minutes while redeeming, five for a
rate refusal); one that claims longer is ignored and removed. Older CLIs
ignore the file.

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
browser. Under `--json`, a rerun that needs no approval (a working saved key)
still succeeds, and one that needs approval announces its URL as described in
[Approval from an agent](#approval-from-an-agent). Non-hosted operator handoffs
carry their own deployment `next_action`; every other setup result has
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

### Where the agent runs

`login`, `setup` and the read commands classify where they run, report it as
`data.environment`, and give one recommended sequence for each:

| `environment` | How it is recognized | Recommended sequence |
| --- | --- | --- |
| `local_shell` | No marker below | `metergraph setup --runtime local --client C --json --no-browser`, rerun after each approval, then `metergraph status --json`. For an existing workspace, `metergraph login --runtime local --workspace SLUG --json --no-browser`. |
| `local_container` | `/.dockerenv`, `/run/.containerenv`, `REMOTE_CONTAINERS`, `DEVCONTAINER` or `container` | As `local_shell`. The browser must reach the container's loopback callback (a forwarded port). If it cannot, use a Metadata key as below; `browser_unavailable` names that `alternative`. |
| `ssh_session` | `SSH_CONNECTION`, `SSH_CLIENT` or `SSH_TTY` | A Metadata key (below). `login` exits 6 `ssh_session` and `setup` exits 6 `run_on_local_machine`, each with a structured next action. |
| `cloud_workspace` | `CODESPACES`, `GITPOD_WORKSPACE_ID` or `CLOUD_SHELL` | A Metadata key. `login` exits 6 `cloud_workspace`. |
| `ci` | `CI` | A Metadata key stored as a CI secret. `login` exits 6 `ci_environment`. |

Remote markers win over container markers. Only the presence of a variable or file is
checked; no value is read into output.

The `use_agent_key` next action is the handoff a person completes on their own device:

```json
{
  "kind": "use_agent_key",
  "environment": "ssh_session",
  "credential_env": "METERGRAPH_AGENT_TOKEN",
  "origin": "https://app.metergraph.dev",
  "person_steps": [
    { "action": "sign_up_or_sign_in", "url": "https://app.metergraph.dev/v1/auth/signup?return_to=%2F%23api-keys" },
    { "action": "create_metadata_key", "url": "https://app.metergraph.dev/#api-keys" },
    { "action": "store_secret", "name": "METERGRAPH_AGENT_TOKEN" }
  ],
  "then_run": ["metergraph status --json", "metergraph usage --json"],
  "message": "...",
  "alternative": { "kind": "run_on_local_machine", "command": "metergraph login --runtime local" },
  "url": "https://www.metergraph.dev/docs/guides/agent-access/"
}
```

The person chooses the workspace by creating the key in it. For a deployment other
than the hosted service there is no sign up page: the first step is
`request_invitation`, and `then_run` passes `--url ORIGIN` so the key is only ever
sent to that deployment. On the open-source server the operator provides an
`MG_AGENT_TOKENS` value instead of a Keys page key. `setup`'s `run_on_local_machine`
next action repeats the caller's `--deployment`, `--url`, `--workspace` and
`--client` (or `--skip-skill`) so its `command` runs as given.
The CLI never claims a browser step happened: the next run verifies the result with
the service.

### Read commands

The read commands use the grant `login` saved for this project or, where there is none
on this machine, a coding-agent key with Metadata access (see
[Reads with a Metadata key](#reads-with-a-metadata-key)). They never open a browser,
never sign in on their own and never request another scope. Each one:

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
| `status` | `GET /healthz` and `GET /v1/deployment` (no credentials, checked as `doctor` does), then the two checks above | `configured`, `reachable`, `healthy`, `authenticated`, the bound (`intended`) and verified (`actual`) workspace, the bound deployment profile and `deployment_profile_verified`, scopes and capability flags, `content_access` (whether the credential could read content through Agent Access; the read commands never do) and `access`: `access.role` (`metadata` or `debug`), `access.permissions` with one boolean per workflow permission (`allow_evaluation_writes`, `allow_evaluation_previews`, `allow_analysis_starts`) and `access.permissions_offered`, which is `false` on a deployment without managed evaluations (customer-owned AWS, the open-source server) and `null` when the capabilities were not read. Writing and testing evaluations and starting analyses need the Debug role with all three permissions; when the credential lacks any of them on a deployment that offers them, the text output says how to grant them there. A `/v1/deployment` profile that differs from the binding exits 11 with `profile_mismatch` before the grant is used. `application_traffic_verified` is always `false`: a signed in project, existing data or a configured SDK does not prove that your application sends traffic. |
| `context` | the two checks above | Workspace ID, slug, name and creation time, Metadata retention days, whether the workspace captures content (never included here) and the access scope. |
| `capabilities` | the two checks above | Each known agent capability with `available`, `privacy_class`, `required_scope` and flags, and the service's bounds. Privacy class descriptions are not printed. |
| `usage` | `GET /v1/agent/usage?days=N&limit=N[&metadata=]` | Daily rows per route: calls, errors, cost, tokens and latency (latency may be `null`), the window, evidence completeness, warning codes and totals of the returned rows. |
| `usage` (grouped) | `GET /v1/agent/usage/aggregates?group_by=...&(days= or since=&until=)&limit=[&route=&provider=&model=&environment=&metadata=]` (one `group_by` per dimension) | Groups by provider, model, route, UTC day or one metadata key with calls, errors, cost, cost per call, tokens and labelled latency, totals over every matching call, the UTC window, coverage, pricing and attribution, and an optional prior-period comparison (see [Grouped usage and cost questions](#grouped-usage-and-cost-questions)). |
| `routes` | `GET /v1/agent/routes` | Route name, calls, replay eligible calls, evaluation contract version and hash, and whether a description or contract exists. |
| `traces` | `GET /v1/agent/traces?days=N&limit=N[&route=&status=&metadata=&cursor=]` | One page of trace metadata: IDs, name, status, times, span count, tokens, cost (may be `null`), routes, providers and models, plus `next_cursor`. |

Bounds and honesty rules:

- `--days` is 1 to 90 (default 7) and `--limit` 1 to 200 (default 50, or 20 for
  `traces`). Values outside these ranges exit 2. A value above the service's own
  advertised `max_days` or `max_rows` exits 6 with `exceeds_service_bounds`; it is never
  reduced silently.
- `usage` and `traces` report `truncated` and `complete`. Totals are sums of the
  returned rows only; when `complete` is `false` they are not workspace totals. An
  empty window is a successful result with `empty: true`.
- When the service reports them, `usage` and `traces` also carry `coverage`,
  `pricing` and `attribution`, and `usage` carries `population_totals`. An older
  service omits them: the fields are `null` and the `coverage_not_reported` notice is
  set. The existing fields keep their meaning.
  - `coverage.completeness` is `complete`, `partial` or `unknown`, with sorted
    `reasons` such as `row_limit`, `page_unread`, `window_clamped`,
    `retention_clipped`, `ingestion_pending`, `ingestion_failed`,
    `ingestion_unverified` or `evidence_missing`. `requested_window` and
    `effective_window` show what was asked and what was read, `as_of` when, and
    `filters_applied` which filters applied (names only, never values).
    `complete` is `true` only when the evidence is complete, nothing was truncated
    and coverage is `complete`. The CLI never reports a better completeness than
    the reasons allow, and an unrecognized reason makes it at least `unknown`.
  - `population_totals` covers every matching call in the window, whatever
    `--limit` returned. `totals` remains the sum of the returned rows.
  - `pricing.cost` is `exact` only when every call is priced. `zero_cost_calls` were
    priced at zero; `unpriced_calls` have no price; `unknown_calls` cannot be told
    apart from either. Otherwise cost is a `lower_bound` and the
    `pricing_lower_bound` notice is set. Each usage row and trace carries its own
    `pricing`.
  - A trace `cost_usd` is the whole-trace total and is `null` when no call in it is
    priced. `mixed_providers` and `mixed_models` mark traces that span more than
    one, and `attribution.per_provider_exact` is always `false` for traces: a trace
    total is never split by provider. Usage rows are attributed per call. When a
    `--route` or `--status` filter selected calls rather than whole traces,
    `attribution.cost_basis` is `matching_calls` and each row's cost, pricing and
    flags cover only its matching calls.
  - A final `traces` page without `next_cursor` is still `complete: false` when the
    service reports any other reason, for example pending ingestion.
  - The evidence must describe the document it arrives in, or the read exits 11
    with `usage_response_invalid` or `traces_response_invalid`. Coverage must
    match the returned rows, limit, truncation, cursor and requested days, and
    pricing must account for every call in its row, trace or window. A traces
    document must report trace-level, whole-trace attribution.
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
  before any request, except `--environment`, `--since` and `--until` on `usage`, which
  send them to the grouped usage read. The other reads have no environment selector or
  absolute time range, and these commands never read content or replay. `--workload`
  is refused by this CLI version because the returned trace rows do not show which
  workload they belong to, so a filtered page could not be verified.
- A capability the service does not offer to this grant exits 14 without a read. A
  refused read exits 15 (`insufficient_scope` or `forbidden`), rate limiting exits 16
  with `retry_after_seconds` when the service sends a whole number of seconds, and a
  token refused during the read exits 12. Nothing is retried. Ctrl+C exits 17.

#### Metadata filters and grouping

Metadata is the string dictionary your application attaches to calls with the SDK's
tags (for example `metergraph.tags(prompt_id="reply-v3")` or
`mg.withTags({ prompt_id: "reply-v3" }, ...)`). `usage` and `traces` can filter on it,
and `usage` can group by one key.

- `--metadata KEY=VALUE` keeps only calls whose metadata has exactly that value. It is
  case-sensitive and opaque: nothing is trimmed, case folded or split on a prefix, so
  `queue:job/Run-1` matches only itself. Repeat it for up to 5 keys; a call must
  match all of them. The argument splits at the first `=`, so a value may contain `=`.
- `KEY=` matches only calls where the key is present with an empty value. A call
  without the key never matches any filter.
- `--metadata-json '{"a=b":"v"}'` gives the same filters as one JSON object, for a key
  that contains `=`. It cannot be combined with `--metadata`. Duplicate keys and
  non-string values exit 2.
- Keys are 1 to 200 characters without control or formatting characters (keys are
  printed back), and values at most 1,000. The whole request query, measured as it is
  sent, must fit in 2,048 characters, or the command exits 2 with `query_too_long`
  before any request. Keys that look like
  credentials (ending in `api_key`, `token`, `secret`, `password`, `auth` and similar)
  are refused with exit 2, and the service refuses them too.
- The CLI sends the filters as one JSON object in the `metadata` query parameter.
  Trace and usage rows do not carry metadata, so the service must echo exactly the
  requested pairs in its coverage evidence (`coverage.filters.metadata`). A service
  that does not echo them exits 6 with `metadata_filter_unsupported`; a different
  echo exits 11 with `metadata_filter_mismatch`. Filter values are never printed
  back; only the keys and how many were applied (`filters.metadata`), and
  `coverage.filters_applied.metadata` says whether any applied.
- On `traces`, a metadata filter selects spans, like `--route`, so a trace's totals
  cover its matching spans.

`--group-by metadata.KEY` (or `--group-by-metadata KEY`, the same dimension and the
way to give a key that contains a comma) groups by one metadata key through grouped
usage; see [Grouped usage and cost questions](#grouped-usage-and-cost-questions). A
route is not a prompt: one route usually carries several prompt IDs, so
`metergraph usage --group-by metadata.prompt_id` is how to split a route's cost by
prompt, and `--group-by route,metadata.prompt_id` shows which prompts ran on each
route. The key is sent whole as its own `group_by` parameter, so commas and dots in it
survive. Each metadata group has `metadata_key`, `metadata_value` and `has_value`. Calls
without the key, or with a non-string value or one over 1,000 characters, form a group
with `metadata_value: null` and `has_value: false`, shown as `(no value)`, and the
notice `metadata_values_missing` is set; the coverage reasons `metadata_key_missing`
and `metadata_value_ineligible` name them without lowering completeness.
`result.metadata_groups` accounts for every call: `listed_with_value`, then
`unlisted.other_values` (values past `--limit`, with a group count),
`unlisted.missing_key` and `unlisted.ineligible_value`, which add up to
`totals.calls` exactly, and `unattributed`, the calls and cost no value of the key
accounts for. Human output prints both lines. A response whose buckets do not add up
is refused (exit 11). A service without the `usage_aggregates` capability exits 14.
When the service warns `metadata_key_mostly_missing` (calls without a usable value
hold at least half of the window's calls or cost), the notice
`metadata_key_mostly_missing` is set. When no call has the key at all, human output
says so in one line and suggests checking the key's spelling.
Like every grouped read, a metadata grouping is refused when its rows are not highest
cost first, when it returns fewer than `min(limit, matched)` rows (the read has no
cursor), or when the listed calls, errors, tokens or cost exceed the totals (or,
untruncated, do not equal them).

In human output, notices that repeat a printed line are left out: the Coverage line
replaces the incomplete-evidence and truncation notices, the Pricing line replaces the
lower-bound notice, the Window line replaces the partial-day notice, the metadata
attribution lines replace the missing-values notice, the comparison lines replace the
comparison notices, and service warning codes are printed once on a `Service warnings`
line. `--json` keeps every notice token.

```sh
metergraph usage --days 7 --group-by metadata.prompt_id --json
metergraph usage --metadata workflow_id=wf-2041 --json
metergraph traces --route support-reply --metadata prompt_id=reply-v3 --limit 5 --json
```

#### Grouped usage and cost questions

`usage` reads grouped usage when it is given `--group-by`, `--route`, `--provider`,
`--model`, `--environment`, `--today`, `--since`, `--until`, `--sort` or `--compare`.
The service groups calls (spans) by any ordered subset of `provider`, `model`, `route`
and `day` (default `provider,model`), so a trace that used two providers adds each
call's cost to that call's provider. The same read is the MCP tool
`metergraph_get_usage_aggregates`; both return one document. It needs the
`usage_aggregates` capability. A deployment without it exits 14 with
`usage_aggregates_unavailable` and a `next_action` of kind `use_supported_read` that
names the route-by-day read (`metergraph usage --days 7 --json`), which still works
there. Nothing is read.

| Question | Command |
| --- | --- |
| Most expensive route today | `metergraph usage --group-by route --today` |
| Spend with one provider | `metergraph usage --group-by provider --provider NAME --days 7` |
| Spend by model | `metergraph usage --group-by model --days 7` |
| One route's daily trend | `metergraph usage --route NAME --group-by day --days 14` |
| Cost by a prompt metadata key | `metergraph usage --group-by metadata.prompt_id --days 7` |
| Today against yesterday | `metergraph usage --group-by route --today --compare previous` |

Windows are UTC. In grouped usage, `--days N` is the current UTC day so far and the N - 1
whole UTC days before it, ending at the request time (`window.kind: "utc_days"`); plain
`usage --days N` instead reads the last N x 24 hours, rolling and not aligned to UTC days
(`window.kind: "rolling"`, `aligned_to_utc_days: false`), and its text output says so; `--today` is `--days 1`. `--since` (inclusive)
and `--until` (exclusive, default now) take a UTC date (`YYYY-MM-DD`, 00:00 UTC) or an
ISO 8601 timestamp with `Z` or an offset; a timestamp without one exits 2, so a local
time is never read as UTC. A window spans at most 90 days. `result.window` echoes
`since`, `until`, `timezone: "UTC"`, `preset`, `until_is_request_time`, `hours` and
`partial_days`, the UTC days the window covers only in part, and `kind` (`utc_days` or
`explicit`). A `day` group in
`partial_days` has `partial_day: true`, and the `current_day_partial` notice is set
when the window ends part way through today. A window, grouping or filter the service
did not apply as asked exits 11 (`window_mismatch`, `group_by_mismatch`,
`filter_mismatch`).

Filters are exact. `--route`, `--provider` and `--model` may each be repeated up to 20
times; `(unrouted)` and `(unknown)` select calls without a route, provider or model.
`--environment` may be repeated; a grant restricted to some environments reads only
those and sets `environment_restricted_key`. The service must echo every filter in
`coverage.filters`. Filter values are not printed back, only how many applied.
`--metadata` on grouped usage needs a service that echoes it in
`coverage.filters.metadata`; one that does not exits 6 with
`metadata_filter_unsupported`, and nothing is printed.

Each item has its group fields, `rank`, `calls`, `error_calls`, `error_rate`,
`cost_usd`, `cost_per_call_usd` (`cost_usd / calls`), input, output, cache read, cache
write and reasoning tokens, `latency` and its own `pricing`. `latency.avg_ms` is the
mean over the `latency.samples` calls that reported latency. `latency.p95_ms` is
estimated from a fixed latency histogram of the group's own calls
(`p95_method: "histogram_estimate"`), never an exact percentile and never a maximum or
mean of daily values; text output labels it `P95_MS_EST`. `totals` (`scope:
"population"`) cover every call the window and filters match, whatever `--limit` is.

`--sort` orders the groups: `cost` (default), `cost-per-call`, `calls`, `errors`,
`avg-latency`, `p95-latency` or `day` (oldest first, the default for
`--group-by day`). The service returns the `--limit` highest-cost groups. When more
groups matched (`truncated: true`, `coverage.rows.matched` above `rows`, the
`groups_truncated` notice), a ranking by anything but cost covers only the listed
groups: `sort.complete` is `false`, the `ranking_partial` notice is set and
`next_action` (`raise_limit`) names the `--limit` that lists every group, or asks for a
narrower read when that is over 200.

`--compare previous` reads the period before as a second request and adds
`result.comparison`: the prior window, totals, coverage and pricing, the change in cost
and calls overall and per group, and `hours` for both windows. For `--days N` the
prior period is the N whole UTC days before the current window, so a window that ends
part way through today is shorter than its prior period:
`partial_day_compared_with_full` is `true`, the `partial_day_comparison` notice is
set, and `next_action` (`compare_like_for_like`) gives the equal-length prior window.
`--compare previous-same-time` uses that window: the prior period up to the same
elapsed time. A group absent from a window whose groups are all listed is zero there;
absent from a cut window it is `null` (unknown), and `comparison.complete` is `false`.
Notices from the prior read are prefixed `prior_`. `--compare` cannot be combined with
`--group-by day`, since a day is never in both windows.

The service bounds each read in time and size. A read stopped at its time budget exits
5 with `temporarily_unavailable`, `retry_after_seconds` from the service and a
`next_action` of kind `retry_later`; a response over the size budget (the service's
413 or the CLI's own 1 MiB bound) exits 6 with `response_too_large` and a
`narrow_read` next action. Nothing is retried.

The tests replay documents the service returned over HTTP for one synthetic dataset
in a real PostgreSQL database, recorded with the MCP tool's document for the same
arguments (`test/fixtures/usage-aggregates/parity.json`); for each, the CLI's totals,
groups and window match the service's.

```sh
metergraph usage --group-by route --today --json
metergraph usage --route support-reply --group-by day --days 14
metergraph usage --group-by provider,model --days 30 --sort cost-per-call --limit 200
metergraph usage --group-by route --since 2026-01-01 --until 2026-01-08 --compare previous
```

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
`evidence_incomplete`, `routes_truncated_locally`, `unsafe_text_omitted`,
`trace_links_unavailable`, `coverage_partial`, `coverage_unknown`,
`coverage_not_reported`, `pricing_lower_bound`, `mixed_provider_traces`,
`unpriced_traces`, `groups_truncated`, `ranking_partial`, `current_day_partial`,
`partial_day_comparison`, `comparison_incomplete` or `environment_restricted_key`.

#### Reads with a Metadata key

For an agent where browser sign in cannot finish, a person creates a coding-agent key
with Metadata access on the deployment's Keys page and gives it to the agent's
environment as a secret. The CLI reads it only from:

- `METERGRAPH_AGENT_TOKEN`, used when this project has no saved sign in on this machine;
- `--agent-token-file PATH`, a private file checked like `setup`'s agent token file
  (an absolute path with no symbolic link, a regular file owned by you with mode 0600
  and one link, in a directory only you can write, holding one key). It is used even
  when a saved sign in exists.

A key is never accepted as an argument or on stdin, never written to a file and never
printed. When a saved sign in exists and `METERGRAPH_AGENT_TOKEN` is set, the saved
sign in is used and the notice `agent_key_not_used` says so.

| Option or variable | Meaning |
| --- | --- |
| `--url ORIGIN` / `METERGRAPH_URL` | Where the key is sent for an unbound project. Default `https://app.metergraph.dev`. A bound project's origin must match, or the command exits 8 `bound_to_other_origin` with no request. Because `.metergraph/project.json` is repository content, a key is sent to a non-hosted origin it names only when this machine holds a sign in for that origin or `--url` / `METERGRAPH_URL` confirms it; otherwise exit 8 `agent_key_origin_unconfirmed` (`confirm_origin`) with no request. |
| `--workspace SLUG` | The workspace the key must be for, by its slug or name (or ID), checked against the workspace the service reports for the key (exit 11 `workspace_context_mismatch` otherwise). A bound project pins its own. Without either, the key's own workspace is verified and used, with the notice `workspace_not_pinned`. |

Before any read, in order and under one `--timeout-ms` deadline:

1. A key in `METERGRAPH_AGENT_TOKEN` must be one token with no label, spaces or extra
   lines (exit 2 `agent_token_malformed`, with no request).
2. `GET /v1/deployment` with no credential must report a supported profile, and the
   bound profile when there is a binding. A key file is opened only after this.
3. `GET /v1/agent/workspace` and `GET /v1/agent/capabilities` with the key must show
   the Metadata role (exactly `agent:metadata`, with no content capability offered) or
   the Debug role with any workflow permissions (`agent:read` with any of
   `agent:eval-write`, `agent:eval-preview` and `agent:analysis-run`), the same profile and the pinned workspace. A key with
   `agent:replay`, or one mixing Metadata with other scopes, is refused. With either
   access, the read commands send only their Metadata requests. The full model-swap
   workflow requires the Debug role with all three permissions: Allow evaluation
   writes, Allow evaluation previews and Allow analysis starts.

| Result | Exit | `next_action.kind` |
| --- | --- | --- |
| Key unknown, expired or revoked (401), also when revoked before the read | 12 `agent_key_rejected` | `replace_agent_key` |
| Key valid but without Metadata access, such as an ingest key (403) | 15 `agent_key_insufficient_scope` | `replace_agent_key` |
| Key with Replay access, or with scopes this CLI does not use | 11 `scope_mismatch` | `use_metadata_only_key` |
| Key for another workspace | 11 `workspace_context_mismatch` | `use_workspace_key` |
| Key file not private or missing | 9 `agent_token_file_*` | `fix_agent_key` |

Output reports `credential` as `agent_key` or `oauth_grant`. With no saved sign in and
no key, reads exit 12 `not_signed_in` with `use_agent_key` in SSH sessions, cloud
workspaces and CI, and with `login` (and the key handoff as its `alternative`)
elsewhere.

### experiments

An experiment replays a workload's last 10 to 40 replayable production calls (default
20) on 1 to 3 treatments, each a provider, a model and optional settings, and compares
each treatment with what production returned on the same calls. The service samples the
calls, prices the replays from its model catalog, refuses an experiment above its budget
(per experiment and per workspace per day, at most two running at once) and runs it.
The experiments feature may be off for a deployment; then every action exits 14
(`capability_unavailable`) and nothing is sent.

```sh
metergraph experiments estimate --workload summarizeTicket \
  --treatment openai/gpt-6-luna,label=Luna,max_tokens=400 \
  --treatment anthropic/claude-haiku-4-5,temperature=0.2 --track '$.priority' --json
metergraph experiments start --workload summarizeTicket \
  --treatment openai/gpt-6-luna,label=Luna,max_tokens=400 \
  --treatment anthropic/claude-haiku-4-5,temperature=0.2 --track '$.priority' \
  --agent-token-file ~/.config/metergraph/start-key --json
metergraph experiments get --id 3f2b8c1d-4e5f-4a6b-8c7d-9e0f1a2b3c4d --json
```

- `--treatment PROVIDER/MODEL[,label=NAME][,temperature=0..2][,max_tokens=1..32000][,reasoning_effort=EFFORT]`
  names one treatment. The model may itself contain `/`. Settings left out follow
  production. Labels are unique and never `control`.
- `estimate` (`POST /v1/agent/experiments/estimate`) writes and spends nothing. Its
  result echoes the request the service read, with default labels filled in, the sample
  size and production models seen, the estimate per treatment against the budget and
  the daily cap, `blocking_reasons`, and whether this credential holds the start grant.
  `next_action.kind` is `start_experiment`, or `change_experiment` when a start would be
  refused.
- `start` (`POST /v1/agent/experiments`, 202) takes the same arguments, so it starts
  exactly what was priced. Each call creates a new experiment, so a start that succeeded
  is never retried. Its `next_action` is `poll_experiment` with the `get` command, which
  reads with a Metadata key or the project's sign in. The start request has its own
  `--timeout-ms` deadline after the key checks. When it may have reached the service but
  its result was not confirmed (a timeout or dropped connection after it was sent, a
  server error, or a 202 whose answer does not match the contract), the command exits 20
  (`unconfirmed`) with `next_action.kind: "check_before_retry"`: list experiments before
  starting again. A start the service recorded but could not launch exits 5
  (`unhealthy`, `experiment_launch_failed`) with the failed experiment in `data.result`.
- `get` (`GET /v1/agent/experiments/UUID`) is the status and, once cases finish, the
  built-in statistics: per treatment and for production, cases, errors, cost per call,
  p50 latency, output tokens and output length, JSON parse rate, same top-level keys as
  production, empty or refused rate and cut-off rate, plus production over exactly the
  cases each treatment returned on. They show differences and never judge them. While
  `terminal` is false, `next_action` is `poll_experiment` with `poll_after_seconds`;
  then it is `open_experiment` with the dashboard link.
- `list` (`GET /v1/agent/experiments?workload_id=&limit=`) is the newest experiments,
  optionally for one workload.

`list`, `estimate` and `get` are read commands: they use the project's saved Metadata
grant or a coding-agent key exactly as `usage` does, and the service's Metadata documents
never carry an input, an output or a tracked field's value. Those are in the dashboard,
and in the service's separate content tool for a Debug credential, which this CLI never
calls. Every field printed is validated; the service's refusal messages are not printed.

`start` needs a coding-agent key with Debug access (`agent:read`) and the Allow analysis
starts grant (`agent:analysis-run`), which only a workspace owner can grant on the Keys
page. It comes from `--agent-token-file` or `METERGRAPH_AGENT_TOKEN`, never a saved sign
in. Before the start, the service's workspace document must show `agent:read` and
`agent:analysis-run`, optionally with the other workflow permissions (a
key that also holds Replay, Metadata or ingest is refused), for the expected workspace and
profile, and its
capabilities document must offer `experiment_start`. Only then is the
one `POST` sent with the key. Without such a key the command exits 15
(`permission_denied`, `experiment_start_key_required` or `experiment_start_not_granted`)
and sends nothing to the experiments endpoints. A refusal by the service, for example
`over_budget`, `daily_budget_exhausted`, `experiments_in_progress`, `route_unpriced` or
`no_replayable_calls`, exits 19 (`refused`) with the code, reason and any budget figures
in `data.refusal`.

### tools

```sh
metergraph tools list [--name TOOL] [read options] [--json]
metergraph tools call TOOL [--args JSON | --args-file PATH] [--yes] [read options] [--json]
```

Every Agent Access tool the service offers this credential, through its MCP endpoint
(`POST /v1/agent/mcp`, JSON-RPC `tools/list` and `tools/call`), as an MCP client calls
it. The credential, origin and workspace are chosen and verified exactly as for the read
commands (a saved sign in or a coding-agent key with the Metadata or Debug role; Replay is
refused). The service decides which tools the credential sees: a Metadata credential gets
the Metadata tools, the Debug role adds trace content and evaluation reads, and Allow
evaluation writes, Allow evaluation previews and Allow analysis starts add the tools they
name.

- `list` sends `tools/list`. Each tool has `name`, `title`, `description`,
  `input_schema` (the service's JSON schema), `read_only`, `open_world` and
  `needs_confirmation`. `--name` shows one tool.
- `call` sends `tools/list`, then one `tools/call` with the arguments from `--args` or the
  file `--args-file` names: one JSON object, up to 1 MiB, never stdin. The tool's
  structured result is in `data.result.result`.
- A tool the service does not annotate `readOnlyHint: true`, or annotates
  `openWorldHint: true` (it calls a model provider), has `needs_confirmation: true` and
  runs only with `--yes`. Without it the command exits 18 (`action_required`,
  `confirmation_required`) and calls nothing. A tool listed without annotations, as by an
  older service, needs `--yes`. Pass `--yes` only after the person has approved that exact
  call.

| Result | Exit | `next_action.kind` |
| --- | --- | --- |
| The tool is not offered to this credential | 14 `tool_unavailable` | `list_tools` |
| `--yes` missing for a tool that needs it | 18 `confirmation_required` | `confirm_tool_call` |
| The tool refused the call (`isError`), or rejected its arguments | 19 `tool_error` or `tool_rejected`, with `data.tool_error` | `fix_tool_arguments` |
| A call that needs `--yes` reached the service but its answer was lost | 20 `tool_call_unconfirmed` | `check_before_retry` |
| `--args` or the file is not one JSON object | 2 `args_invalid` | none |

The result and `data.tool_error` are the service's JSON. Before printing, the output is
checked for the credential, as for every command, and C1 control and bidirectional
characters are escaped as `\uXXXX`.

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
      "revision": "sha256-0946db53f827",
      "sha256": "0946db53f82739da9ef2c44501b06b2734786be88fc3d30c84854b034462a8b4"
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
    "environment": "local_shell",
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
  `next_action` is `null` or a handoff such as `use_agent_key`, `reconnect` or
  `no_browser`. `environment` is one of the kinds in
  [Where the agent runs](#where-the-agent-runs), or `declared_cloud` for
  `--runtime cloud`. With `--json --no-browser`, a sign in that needs approval returns
  `action_required` with `status: "approval_pending"` and an `open_url` next action;
  see [Approval from an agent](#approval-from-an-agent).
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

### Approval from an agent

A coding agent usually runs commands without a terminal, so it cannot read a URL
from stderr. Its shell tool usually shows output only after a command exits, so it
cannot read a URL from a command that is still waiting, either. With `--json
--no-browser`, a `login` or `setup` step that needs a person to approve in a browser
therefore exits within seconds with the URL:

```json
{
  "schema_version": 1,
  "command": "setup",
  "ok": false,
  "outcome": "action_required",
  "exit_code": 18,
  "data": {
    "status": "login_pending",
    "application_traffic_verified": false,
    "receipt": null,
    "next_action": {
      "kind": "open_url",
      "url": "https://metergraph.example.com/v1/oauth/authorize?response_type=code&client_id=...&redirect_uri=http%3A%2F%2F127.0.0.1%3A49152%2Fcallback&scope=agent%3Ametadata&state=...&code_challenge=...&code_challenge_method=S256&resource=...",
      "timeout_seconds": 300,
      "message": "Show this URL to the person now and ask them to open it in a browser on this machine to sign in with Metadata access. A background process waits up to 300 seconds for their approval. After they approve, run the same command again to continue."
    }
  },
  "error": {
    "code": "action_required",
    "reason": "browser_approval_required",
    "message": "A person must approve in a browser. Open data.next_action.url on this machine; a background process waits for the approval until the timeout. After approval, run the same command again to continue."
  }
}
```

- The agent shows `next_action.url` to the person, who opens it in a browser on the
  same machine. The URL redirects to the CLI's `127.0.0.1` listener. The URL is the
  authorization request only: public client ID, loopback redirect, state and PKCE
  challenge. It never holds a token, code, verifier or ingest key.
- The approval comes back to a loopback listener. So when the command needs approval
  under `--json --no-browser`, it runs as a detached background process, which the
  command starts with the same arguments and no credential. The command prints that
  process's one JSON line and exits at once. The background process keeps listening
  until approval, denial or `--timeout-ms`, saves what the approval completed, and
  exits. It prints nothing and holds none of the agent shell's output, so the agent's
  command returns at once. A step that needs no approval runs as before and prints
  its usual result.
- After the person approves, the agent runs the same command again. The rerun resumes
  from the saved sign in and setup state. A rerun before approval announces a fresh
  URL; the earlier one keeps working until its own timeout.
- One run announces at most one URL. `setup` on a project that is not signed in
  needs one approval when the service supports the combined sign-in approval, so an
  agent runs it twice: sign in and key approval together (`status:
  "login_pending"`), then a rerun that needs no approval and returns
  `ready_for_instrumentation`. Against a service without it, setup needs two
  approvals, so an agent runs it three times: sign in (`status: "login_pending"`),
  ingest-only setup approval (`status: "approval_pending"`, with the `receipt`), then
  the rerun.
- A denied approval, or one that times out, saves nothing. The rerun announces a fresh URL.

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

## What experiments start does and does not do

- It is the only command that changes a workspace: it records one experiment, which the
  service then runs by sending the sampled calls' captured prompts to each treatment's
  provider through its AI gateway, within the budget the service owns.
- It never uses a saved sign in, never requests a scope, and never uses its key for any
  other request. Read commands, `experiments list`, `estimate` and `get` among them,
  accept keys with the Metadata or Debug role and send only Metadata requests.
  Replay access is refused.
- It never retries a start, and never reads the experiment's inputs or outputs.

## What the read commands do not do

- They never sign in, open a browser, create a grant or change the project binding.
  The only file they may write is the saved grant, when a refresh rotates it.
- They never request `agent:read` or `agent:replay`, never read retained content,
  evidence or replays, and never call a model provider.
- They make only `GET` requests to the read endpoints (a grant refresh, when needed, is
  a `POST`, and `experiments estimate` sends its request as a `POST` that writes nothing). They send no ingest data and change no evaluations, provider
  settings, workspace configuration or telemetry. The service may still record the
  access, for example audit entries and the grant's last used time.
- They never print a token the CLI holds, even inside an otherwise valid name.
- They never follow a cursor or page on their own, and never widen a request: an
  unsupported option, an out of range value or a capability the grant lacks fails
  instead.
- They accept no credential on the command line or on stdin. A coding-agent key comes
  only from `METERGRAPH_AGENT_TOKEN` or a private `--agent-token-file`, and is never
  written or printed.
