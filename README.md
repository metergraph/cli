# metergraph-cli

[![npm](https://img.shields.io/npm/v/metergraph-cli/next?label=npm%40next)](https://www.npmjs.com/package/metergraph-cli)
[![CI](https://github.com/metergraph/cli/actions/workflows/ci.yml/badge.svg)](https://github.com/metergraph/cli/actions/workflows/ci.yml)
[![License](https://img.shields.io/badge/license-Apache--2.0-blue)](https://github.com/metergraph/cli/blob/main/LICENSE)

Connect a project to [Metergraph](https://www.metergraph.dev/) from the terminal or from
your coding agent. Metergraph learns from your application's LLM traces, benchmarks
models against your real usage and routes each task to the model that clears your
quality bar. This CLI signs a project in, writes its ingest key, installs the Metergraph
skill for Codex, Claude Code or Cursor, proves that a trace arrived, and reads cost,
token and route metadata back. Every command has stable `--json` output and exit codes,
so agents can run it as well as people.

```sh
npx --yes metergraph-cli@next --help
```

This is a preview, published on the `next` npm tag. `latest` is still `0.1.0`, which has
only `doctor` and `skill`. See the [changelog](https://github.com/metergraph/cli/blob/main/CHANGELOG.md).

## Quickstart

**1. Set up the project.** Run this in your project directory. It opens your browser to
sign in and choose a workspace, asks a workspace member to approve an ingest-only key,
writes `METERGRAPH_APP_TOKEN` and `METERGRAPH_INGEST_URL` to a private `.env`, and
installs the skill for your coding agent.

```sh
npx --yes metergraph-cli@next setup --runtime local --client claude
```

Use `--client codex` or `--client cursor` for the other agents.

**2. Run your application once**, instrumented with a Metergraph SDK (see the
[first trace guide](https://www.metergraph.dev/docs/start/first-trace/)). Note the trace
ID or request ID and when the call started and ended.

**3. Prove the trace arrived.** Setup only proves the key works; `verify` checks that this
exact trace is visible in your workspace.

```sh
npx --yes metergraph-cli@next verify --trace-id TRACE_ID \
  --since 2026-01-08T12:00:00Z --until 2026-01-08T12:00:05Z
```

Then read what Metergraph has recorded:

```sh
npx --yes metergraph-cli@next usage --days 7      # calls, errors, cost and tokens per route per day
npx --yes metergraph-cli@next traces --limit 20   # one page of trace metadata
```

To install it globally instead, run `npm install -g metergraph-cli@next`. The command is
`metergraph`. Pin an exact version, such as `metergraph-cli@0.2.0-preview.4`, when a
script must not change with the `next` tag.

## Requirements

| | Supported |
| --- | --- |
| Node.js | 22 and 24 |
| Operating systems | Linux, macOS and Windows, each tested in CI |
| Runtime dependencies | None |
| Service | Hosted Metergraph, or a self-hosted deployment (see [Deployments](#deployments)) |

Sign in needs a service that offers Metadata-only CLI grants and grant revocation; a
service without them is reported as unsupported, and the CLI never falls back to
broader access. `setup` also needs the deployment's ingest bootstrap API and approval by
a workspace member. Sign in needs a browser on the same machine. From SSH sessions,
cloud development environments and CI, `login` and `setup` hand off to a local machine
instead (exit 6).

## Using it with a coding agent

The CLI is built to be run by Codex, Claude Code and Cursor as well as by people:

- **Skill.** `setup` installs the Metergraph skill, which tells the agent how to set up
  and query Metergraph. To install or update only the skill, with no sign in and no
  network access:

  ```sh
  npx --yes metergraph-cli@next skill install --client codex --runtime local
  ```

  A Python equivalent, [`metergraph-skills`](https://github.com/metergraph/cli/blob/main/python/metergraph-skills/README.md), is
  ready for its first PyPI release. Both write the same files and recognise each
  other's installs.
- **Machine output.** Every command takes `--json` and then prints exactly one JSON
  line on stdout and nothing on stderr. All results share one envelope:
  `schema_version`, `command`, `ok`, `outcome`, `exit_code`, `data` and `error`.
  Failures carry a fixed `error.reason` and, where useful, a `data.next_action` that
  tells the agent what to do next.
- **No hidden prompts.** No command reads stdin or asks a question. `--no-browser`
  prints the sign in URL for a person to open instead of launching a browser; with
  `--json`, a step that needs approval exits 6 with a `run_in_terminal` next action.
- **MCP.** Workspace tools for agents are served by the hosted MCP endpoint, not by this
  CLI. See the [MCP server guide](https://www.metergraph.dev/docs/guides/mcp-server/)
  and the [agent access guide](https://www.metergraph.dev/docs/guides/agent-access/).

Suggested `AGENTS.md` or `CLAUDE.md` lines for a project that uses Metergraph:

```md
- Metergraph CLI: `npx --yes metergraph-cli@next <command> --json`. Check exit codes;
  follow `data.next_action` on failure.
- After changing instrumented code, run the app once and confirm the trace with
  `metergraph verify` before reporting that tracing works.
```

## Commands

| Command | What it does | Network |
| --- | --- | --- |
| `setup` | Sign in, choose a workspace, write the ingest key to `.env`, record the repository, install the skill | Yes |
| `verify` | Confirm that one exact trace, by trace ID or request ID, reached the workspace | Yes |
| `usage` | Daily calls, errors, cost, tokens and latency per route | Yes |
| `traces` | One page of trace metadata, with a cursor for the next page | Yes |
| `routes` | Routes with call counts and evaluation contract status | Yes |
| `status` | Whether the project is signed in, and to which workspace | Yes |
| `context` | Workspace details and retention | Yes |
| `capabilities` | What the workspace makes available to this project | Yes |
| `login`, `logout` | Sign a project in or out without the rest of `setup` | Yes |
| `doctor` | Check that a service is reachable, healthy and supported, without credentials | Yes |
| `skill install`, `skill update` | Install or update the Metergraph skill for one agent | No |

`metergraph help COMMAND` lists a command's options. The
[CLI reference](https://github.com/metergraph/cli/blob/main/docs/reference.md) covers every option, what each command reads and
writes, and full JSON examples.

## Exit codes

Exit codes are stable. Changing one is a breaking change. Codes 10 to 17 are not in
`0.1.0`.

| Code | Outcome | Meaning |
| --- | --- | --- |
| 0 | `ok` | Command succeeded. `doctor` does not return this in this preview. For `skill`, the file is in place; discovery is still pending. |
| 1 | `internal_error` | Unexpected failure inside the CLI. |
| 2 | `invalid_input` | Unknown command or argument, or an invalid option value. No request was made. |
| 3 | `authentication_required` | Service is reachable, healthy and supported, and requires authentication. No workspace is connected. |
| 4 | `connection_failed` | The origin could not be reached, the connection failed, or the probe timed out. For `verify`, the deadline expired before any valid answer arrived. A trace that is still pending is exit 11, not 4. |
| 5 | `unhealthy` | The service answered but reported that it is not healthy, or answered with a server error. |
| 6 | `unsupported` | The service answered with a response, deployment profile or status this CLI does not support, or the skill client or runtime cannot use project skill files, or sign in cannot run in this environment, or `--json --no-browser` needs a browser approval it cannot show (`no_browser_requires_terminal`). Nothing was written. |
| 7 | `redirect_rejected` | The service answered with a redirect. Redirects are never followed. |
| 8 | `conflict` | The skill target is not owned by this CLI, was modified, is unsafe, is locked or needs an explicit update, or the project is bound to a different origin or workspace. Nothing was changed. |
| 9 | `filesystem_error` | Project or credential files could not be read or written. Partial changes were rolled back unless the message says otherwise. |
| 10 | `authorization_failed` | Browser authorization did not finish: it was denied, cancelled, timed out or returned an invalid callback. Nothing was saved. |
| 11 | `verification_failed` | The service issued a grant that does not match the requested origin, workspace, client, resource or Metadata scope. Nothing was saved. For `verify`, the exact trace was not confirmed: for example `trace_not_found_within_bounds` when the service kept answering but the trace was not visible before attempts or the deadline ran out. |
| 12 | `login_required` | No usable sign in for this project: none was saved, it expired, was revoked, lost access or could not be refreshed safely. Run login again. |
| 13 | `revocation_unconfirmed` | Local credentials were removed, but the service did not confirm that the grant was revoked. |
| 14 | `capability_unavailable` | The service does not make this read available to the project's Metadata grant. No data was read. |
| 15 | `permission_denied` | The service refused this read for the signed in grant, for example for a missing scope or permission. |
| 16 | `rate_limited` | The service asked the CLI to slow down. Nothing was retried. Try again later. |
| 17 | `cancelled` | A read command was interrupted before it finished. Read commands never change workspace configuration or telemetry. |

## Security and privacy

- **No usage telemetry.** The CLI collects no analytics about how you use it. It talks
  only to the Metergraph origin you point it at.
- **Least access.** Sign in grants only the Metadata scope, `agent:metadata`. The CLI
  never requests Debug or Replay access, never falls back to broader access, and never
  reads retained prompts, responses or other content. It calls no model provider.
- **Credentials.** The sign in grant is stored per user in `~/.config/metergraph`
  (`AppData\Roaming\Metergraph` on Windows), as owner-only files on Linux and macOS and
  encrypted with DPAPI on Windows. The ingest key goes only into the project's private
  `.env`, which `setup` adds to `.gitignore`. No command accepts a credential on the
  command line, in the environment or on stdin, or prints one.
- **Files it writes in your project:** `.env` (from `setup`), the skill file, and
  secret-free state under `.metergraph/` that is safe to commit. The skill installer
  never replaces a file it did not write and has no force option.
- **Network.** Only `GET` requests to fixed paths for reads, no redirects followed,
  bounded response sizes and fixed timeouts. Mistyped arguments are never echoed, since
  they may hold a secret. `--help`, `--version` and `skill` make no network requests.

The [CLI reference](https://github.com/metergraph/cli/blob/main/docs/reference.md) states what each command does and does not do.
Report vulnerabilities privately through
[GitHub private vulnerability reporting](https://github.com/metergraph/cli/security/advisories/new),
not in a public issue, and leave real credentials, tokens and customer data out of the
report. See [SECURITY.md](https://github.com/metergraph/cli/blob/main/SECURITY.md).

## Deployments

`--url ORIGIN` selects the service; the default is `https://app.metergraph.dev`. It
accepts a bare `https://` origin, or `http://` on `localhost`, `127.0.0.1` or `[::1]`.
`setup --deployment` supports the hosted service (`managed`), the commercial
`customer-local` bundle, customer-owned cloud (`byoc`) and the open source server
(`oss`). See [self-hosting](https://www.metergraph.dev/docs/self-host/local/) and the
[setup reference](https://github.com/metergraph/cli/blob/main/docs/reference.md#setup).

## Links

- [Documentation](https://www.metergraph.dev/docs/)
- [CLI reference](https://github.com/metergraph/cli/blob/main/docs/reference.md) and [changelog](https://github.com/metergraph/cli/blob/main/CHANGELOG.md)
- [Issues](https://github.com/metergraph/cli/issues)
- [Contributing](https://github.com/metergraph/cli/blob/main/CONTRIBUTING.md) and [releasing](https://github.com/metergraph/cli/blob/main/RELEASING.md)

## License

Apache-2.0. See [LICENSE](https://github.com/metergraph/cli/blob/main/LICENSE).
