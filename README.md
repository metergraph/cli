# metergraph-cli

The Metergraph command line tool. This is a **development preview** (version 0.1.0).

**Availability:** this package has not been published to npm yet. `npx metergraph-cli`
will not work until a release is announced. Until then, run it from a checkout or from
a locally packed tarball (see [Development](#development)).

This preview does one thing: it checks whether a Metergraph service is reachable,
healthy and supported. It does not sign in, does not connect a workspace and does not
read, write or send any of your data. Setup, sign in and agent skill commands are
planned as separate follow-up releases and are not part of this package yet.

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
```

`--help` and `--version` work offline and make no network requests.

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

## Exit codes

Exit codes are stable. Changing one is a breaking change.

| Code | Outcome | Meaning |
| --- | --- | --- |
| 0 | `ok` | Command succeeded. `doctor` does not return this in this preview. |
| 1 | `internal_error` | Unexpected failure inside the CLI. |
| 2 | `invalid_input` | Unknown command or argument, or an invalid option value. No request was made. |
| 3 | `authentication_required` | Service is reachable, healthy and supported, and requires authentication. No workspace is connected. |
| 4 | `connection_failed` | The origin could not be reached, the connection failed, or the probe timed out. |
| 5 | `unhealthy` | The service answered but reported that it is not healthy, or answered with a server error. |
| 6 | `unsupported` | The service answered with a response, deployment profile or status this CLI does not support. |
| 7 | `redirect_rejected` | The service answered with a redirect. Redirects are never followed. |

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

## Development

```sh
npm test                  # unit tests and CLI subprocess tests against loopback servers
npm run test:package      # npm pack into a temporary directory, clean install, run the installed bin
node bin/metergraph.js --help
node bin/metergraph.js doctor --url http://127.0.0.1:8080 --json
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
No version has been published to npm yet, and no release has been validated from the
registry.

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

No release has happened yet, so the published-artifact check below has never run.
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
