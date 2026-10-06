# metergraph-cli

The Metergraph command line tool. This is a **development preview** (version 0.1.0).

Install the preview channel with npm or run it directly:

```sh
npx --yes metergraph-cli@next --help
npx --yes metergraph-cli@next doctor --json
npm install -g metergraph-cli@next
```

The installed command is `metergraph`. Pin `metergraph-cli@0.1.0` when you need
this exact preview. Authentication and hosted setup are not included yet.

This preview does two things:

- `doctor` checks whether a Metergraph service is reachable, healthy and supported.
- `skill install` and `skill update` copy the Metergraph agent skill bundled with the
  CLI into one coding agent's project skill directory.

It does not sign in or connect a workspace, and it does not query workspace
telemetry or send application data. Sign in, workspace binding and hosted setup commands are planned as separate
follow-up releases and are not part of this package yet.

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
```

`--help`, `--version` and the `skill` commands work offline and make no network
requests.

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

## Exit codes

Exit codes are stable. Changing one is a breaking change.

| Code | Outcome | Meaning |
| --- | --- | --- |
| 0 | `ok` | Command succeeded. `doctor` does not return this in this preview. For `skill`, the file is in place; discovery is still pending. |
| 1 | `internal_error` | Unexpected failure inside the CLI. |
| 2 | `invalid_input` | Unknown command or argument, or an invalid option value. No request was made. |
| 3 | `authentication_required` | Service is reachable, healthy and supported, and requires authentication. No workspace is connected. |
| 4 | `connection_failed` | The origin could not be reached, the connection failed, or the probe timed out. |
| 5 | `unhealthy` | The service answered but reported that it is not healthy, or answered with a server error. |
| 6 | `unsupported` | The service answered with a response, deployment profile or status this CLI does not support, or the skill client or runtime cannot use project skill files. Nothing was written. |
| 7 | `redirect_rejected` | The service answered with a redirect. Redirects are never followed. |
| 8 | `conflict` | The skill target is not owned by this CLI, was modified, is unsafe, is locked or needs an explicit update. Nothing was changed. |
| 9 | `filesystem_error` | Project files could not be read or written. Partial changes were rolled back unless the message says otherwise. |

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

Without `--json`, results are printed as text on stdout and usage errors go to stderr.

## Safe origins

`--url` accepts only a bare origin, with an optional trailing slash:

- `https://` origins on any host, for example `https://metergraph.example.com`.
- `http://` only for `localhost`, `127.0.0.1` and `[::1]`, with an optional port.

Usernames, passwords, paths, queries and fragments are rejected before any request is
made. Invalid values and unknown arguments are not printed back, because a mistyped
argument can contain a credential. An accepted origin is printed in the output and sent
to the network, so do not put secrets in a hostname. See [SECURITY.md](SECURITY.md).

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

## Development

```sh
npm test                  # unit tests and CLI subprocess tests against loopback servers
npm run test:package      # npm pack into a temporary directory, clean install, run the installed bin
node bin/metergraph.js --help
node bin/metergraph.js doctor --url http://127.0.0.1:8080 --json
node bin/metergraph.js skill install --client claude --runtime local --project /path/to/project --json
```

To try a packed artifact without publishing:

```sh
npm pack --pack-destination "$(mktemp -d)"
npx --yes --package=/path/to/metergraph-cli-0.1.0.tgz -- metergraph --version
```

Do not commit tarballs or other generated files.

## Releasing

The source of truth is the public repository
[github.com/metergraph/cli](https://github.com/metergraph/cli), licensed Apache-2.0.
The first preview uses the `next` npm tag. Subsequent releases must pass the
checks below before publication.

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

See [SECURITY.md](SECURITY.md).

## License

Apache-2.0. See [LICENSE](LICENSE).
