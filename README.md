# metergraph-cli

[![npm](https://img.shields.io/npm/v/metergraph-cli?label=npm)](https://www.npmjs.com/package/metergraph-cli)
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
npx --yes metergraph-cli@latest --help
```

Published on npm as `latest`. See the [changelog](https://github.com/metergraph/cli/blob/main/CHANGELOG.md).

## Quickstart

**1. Set up the project.** Run this in your project directory. It opens your browser to
sign in and choose a workspace, asks a workspace member to approve an ingest-only key
(on the same page as sign in, where the service supports it),
writes `METERGRAPH_APP_TOKEN` and `METERGRAPH_INGEST_URL` to a private `.env`, and
installs the skill for your coding agent.

```sh
npx --yes metergraph-cli@latest setup --runtime local --client claude
```

Use `--client codex` or `--client cursor` for the other agents.

**2. Run your application once**, instrumented with a Metergraph SDK (see the
[first trace guide](https://www.metergraph.dev/docs/start/first-trace/)). Note the trace
ID or request ID and when the call started and ended.

**3. Prove the trace arrived.** Setup only proves the key works; `verify` checks that this
exact trace is visible in your workspace.

```sh
npx --yes metergraph-cli@latest verify --trace-id TRACE_ID \
  --since 2026-01-08T12:00:00Z --until 2026-01-08T12:00:05Z
```

Then read what Metergraph has recorded:

```sh
npx --yes metergraph-cli@latest usage --days 7      # calls, errors, cost and tokens per route per day
npx --yes metergraph-cli@latest usage --group-by route --today   # most expensive route today (UTC)
npx --yes metergraph-cli@latest traces --limit 20   # one page of trace metadata
```

To install it globally instead, run `npm install -g metergraph-cli@latest`. The command is
`metergraph`. Pin an exact version, such as `metergraph-cli@0.2.3`, when a
script must not change with the `latest` tag. Previews use the `next` tag.

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
cloud development environments and CI, `login` and `setup` exit 6 with a structured
`next_action`: a person creates a coding-agent key with Metadata access on the Keys
page and saves it as the secret `METERGRAPH_AGENT_TOKEN`, and the read commands use it
after verifying the origin, workspace, scope and capabilities. Ingest setup still runs
on a local machine.

## Using it with a coding agent

The CLI is built to be run by Codex, Claude Code and Cursor as well as by people:

- **Skill.** `setup` installs the Metergraph skill, which tells the agent how to set up
  and query Metergraph. To install or update only the skill, with no sign in and no
  network access:

  ```sh
  npx --yes metergraph-cli@latest skill install --client codex
  ```

  Python users can run `pip install metergraph-skills` and
  `metergraph-skills install --client codex` instead
  ([details](https://github.com/metergraph/cli/blob/main/python/metergraph-skills/README.md)).
  Both write the same files and recognise each other's installs.
- **Model-swap skills.** `skills install` adds the workflow skills from
  [metergraph/skills](https://github.com/metergraph/skills): choose a workload, choose
  traces and models, define the eval, run the analysis, read the report and rerun,
  all from the agent. Start with `metergraph-model-swap`. In Claude Desktop, add
  the `metergraph/skills` plugin marketplace instead.

  ```sh
  npx --yes metergraph-cli@latest skills install --client claude
  ```

  `--runtime` defaults to `local`. Pass `--runtime cloud` when the client runs in a
  cloud environment with a checkout of the project.

- **Machine output.** Every command takes `--json` and then prints exactly one JSON
  line on stdout and nothing on stderr. All results share one envelope:
  `schema_version`, `command`, `ok`, `outcome`, `exit_code`, `data` and `error`.
  Failures carry a fixed `error.reason` and, where useful, a `data.next_action` that
  tells the agent what to do next.
- **No hidden prompts.** No command reads stdin or asks a question. `--no-browser`
  prints the sign in URL for a person to open instead of launching a browser. With
  `--json`, a step that needs approval exits within seconds with 18
  `action_required` and `data.next_action` set to
  `{"kind": "open_url", "url": "...", "timeout_seconds": N, "message": "..."}`, so an
  agent can show the URL to the person. A background process waits for the approval
  until `--timeout-ms`; afterwards, run the same command again to continue from the
  saved state
  ([details](https://github.com/metergraph/cli/blob/main/docs/reference.md#approval-from-an-agent)).
- **MCP.** Workspace tools for agents are served by the hosted MCP endpoint, not by this
  CLI. See the [MCP server guide](https://www.metergraph.dev/docs/guides/mcp-server/)
  and the [agent access guide](https://www.metergraph.dev/docs/guides/agent-access/).

Suggested `AGENTS.md` or `CLAUDE.md` lines for a project that uses Metergraph:

```md
- Metergraph CLI: `npx --yes metergraph-cli@latest <command> --json`. Check exit codes;
  follow `data.next_action` on failure.
- After changing instrumented code, run the app once and confirm the trace with
  `metergraph verify` before reporting that tracing works.
```

## Commands

| Command | What it does | Network |
| --- | --- | --- |
| `pricing models`, `pricing lookup`, `pricing calculate` (`cost` alias) | Discover models, look up rates and calculate costs through the public API without sign in | Yes |
| `pricing market`, `pricing history` | Current public market board; historical terminal/HTML charts require the local reference adapter ([guide](docs/pricing.md)) | Yes |
| `setup` | Sign in, choose a workspace, write the ingest key to `.env`, record the repository, install the skill | Yes |
| `verify` | Confirm that one exact trace, by trace ID or request ID, reached the workspace | Yes |
| `usage` | Daily calls, errors, cost, tokens and latency per route, or cost grouped by provider, model, route or UTC day with exact filters, rankings and a prior-period comparison; filtered by exact metadata or grouped by one metadata key | Yes |
| `traces` | One page of trace metadata, filtered by route, status or exact metadata, with a cursor for the next page | Yes |
| `routes` | Routes with call counts and evaluation contract status | Yes |
| `status` | Whether the project is signed in, and to which workspace | Yes |
| `context` | Workspace details and retention | Yes |
| `capabilities` | What the workspace makes available to this project | Yes |
| `experiments list`, `estimate`, `start`, `get` | Replay a workload's recent production calls on 1 to 3 other models or settings: price it, start it, poll it and read cost, latency and output statistics per treatment next to production | Yes |
| `login`, `logout` | Sign a project in or out without the rest of `setup` | Yes |
| `doctor` | Check that a service is reachable, healthy and supported, without credentials | Yes |
| `skill install`, `skill update` | Install or update the Metergraph skill for one agent | No |
| `skills install`, `skills update`, `skills list` | Install, update or list the workflow skills, such as the model-swap loop | No |

`metergraph help COMMAND` lists a command's options. The
[CLI reference](https://github.com/metergraph/cli/blob/main/docs/reference.md) covers every option, what each command reads and
writes, and full JSON examples.

## Public pricing preview

```sh
metergraph pricing models --limit 10
metergraph pricing lookup --model gpt-5 --provider openai --region global --json
metergraph pricing calculate --model claude-sonnet-5 --provider anthropic \
  --input-tokens 1000 --cache-read-tokens 800 --output-tokens 200
metergraph pricing market --channel openai-api --limit 5
```

These commands use the public Pricing API without an account or workspace.
`cost` is an alias for `calculate`. Inspect status and missing dimensions: an HTTP
success may still be partial or unpriced. The current market board uses discovery
plus bounded lookups; it does not invent historical prices or returns.

The stock-style history visualization is preserved in explicit local reference mode:

```sh
metergraph pricing history --model openai/gpt-5.6-terra --channel openai-api \
  --api reference --url http://127.0.0.1:8765 --format html > history.html
```

See [the pricing guide](docs/pricing.md) for the API contract, input semantics and
local adapter. The public service does not document a history endpoint. This is
an exploratory preview; supplier pricing coverage and storage claims are not
independently verified by these command tests.

## Exit codes

Exit codes are stable. Changing one is a breaking change. Codes 10 to 18 are not in
`0.1.0`, and codes 19 and 20 are not in `0.2.2` or earlier.

| Code | Outcome | Meaning |
| --- | --- | --- |
| 0 | `ok` | Command succeeded. `doctor` does not return this in this release. For `skill`, the file is in place; discovery is still pending. |
| 1 | `internal_error` | Unexpected failure inside the CLI. |
| 2 | `invalid_input` | Unknown command or argument, or an invalid option value. No request was made. |
| 3 | `authentication_required` | Service is reachable, healthy and supported, and requires authentication. No workspace is connected. |
| 4 | `connection_failed` | The origin could not be reached, the connection failed, or the probe timed out. For `verify`, the deadline expired before any valid answer arrived. A trace that is still pending is exit 11, not 4. |
| 5 | `unhealthy` | The service answered but reported that it is not healthy, or answered with a server error. |
| 6 | `unsupported` | The service answered with a response, deployment profile or status this CLI does not support, or the skill client or runtime cannot use project skill files, or sign in cannot run in this environment. Nothing was written. |
| 7 | `redirect_rejected` | The service answered with a redirect. Redirects are never followed. |
| 8 | `conflict` | The skill target is not owned by this CLI, was modified, is unsafe, is locked or needs an explicit update, or the project is bound to a different origin or workspace. Nothing was changed. |
| 9 | `filesystem_error` | Project or credential files could not be read or written. Partial changes were rolled back unless the message says otherwise. |
| 10 | `authorization_failed` | Browser authorization did not finish: it was denied, cancelled, timed out or returned an invalid callback. Nothing was saved. |
| 11 | `verification_failed` | The service issued a grant that does not match the requested origin, workspace, client, resource or Metadata scope. Nothing was saved. For `verify`, the exact trace was not confirmed: for example `trace_not_found_within_bounds` when the service kept answering but the trace was not visible before attempts or the deadline ran out. |
| 12 | `login_required` | No usable sign in for this project: none was saved, it expired, was revoked, lost access or could not be refreshed safely. Run login again. |
| 13 | `revocation_unconfirmed` | Local credentials were removed, but the service did not confirm that the grant was revoked. |
| 14 | `capability_unavailable` | The service does not make this read available to the project's Metadata grant. No data was read. |
| 15 | `permission_denied` | The service refused this read for the signed in grant, for example for a missing scope or permission. |
| 16 | `rate_limited` | The service asked the CLI to slow down. Try again later. Only setup retries, after a short Retry-After, to keep its approval. |
| 17 | `cancelled` | A read command was interrupted before it finished. Read commands never change workspace configuration or telemetry. |
| 18 | `action_required` | A person must act before the command can finish; `data.next_action` says what to do. `login` and `setup` with `--json --no-browser` exit with this as soon as an approval URL exists (`next_action.kind: "open_url"`), while a background process waits for the approval until `--timeout-ms`. After approval, run the same command again to continue. |
| 19 | `refused` | The service refused an experiment for a stated reason, such as its budget, the daily cap, experiments already running or a model it cannot price; `data.refusal` says which. Nothing was started. |
| 20 | `unconfirmed` | An `experiments start` request reached the service but its result was not confirmed (a timeout, a dropped connection, a server error or an answer that does not match the contract), so an experiment may exist and may run. List experiments before starting again; each start creates one. |

## Security and privacy

- **No usage telemetry.** The CLI collects no analytics about how you use it. It talks
  only to the Metergraph origin you point it at.
- **Least access.** Sign in grants only the Metadata scope, `agent:metadata`. The CLI
  never requests Debug or Replay access, never falls back to broader access, and never
  reads retained prompts, responses or other content. It calls no model provider. The one
  exception is `experiments start`: it uses a coding-agent key a workspace owner created
  with exactly Debug access and Allow analysis starts, refuses a key with any other scope,
  and sends it only with that one start request. The service then replays the sampled calls on the
  chosen providers within its own budget. Every other command refuses such a key.
- **Credentials.** The sign in grant is stored per user in `~/.config/metergraph`
  (`AppData\Roaming\Metergraph` on Windows), as owner-only files on Linux and macOS and
  encrypted with DPAPI on Windows. The ingest key goes only into the project's private
  `.env`, which `setup` adds to `.gitignore`. No command accepts a credential on the
  command line, in the environment or on stdin, or prints one.
- **Files it writes in your project:** `.env` (from `setup`), the skill file, and
  secret-free state under `.metergraph/` that is safe to commit. The skill installer
  never replaces a file it did not write and has no force option.
- **Public pricing.** Pricing reads send no credentials and return public catalog data.
  `--format html` emits a standalone document; it does not launch a browser.
- **Network.** Workspace reads use `GET`; experiments estimate and start use `POST`.
  Public pricing lookup/calculation use unauthenticated `POST` with metadata-only
  inputs. Fixed paths, no redirects followed,
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
`setup --deployment` routes to the hosted service (`managed`), the commercial
`customer-local` bundle, customer-owned cloud (`byoc`) or the open source server
(`oss`). The hosted service and released customer-local bundle are the release
targets; `byoc` and `oss` are not yet verified against a live deployment. See
[self-hosting](https://www.metergraph.dev/docs/self-host/local/) and the
[setup reference](https://github.com/metergraph/cli/blob/main/docs/reference.md#setup).

## Links

- [Documentation](https://www.metergraph.dev/docs/)
- [CLI reference](https://github.com/metergraph/cli/blob/main/docs/reference.md) and [changelog](https://github.com/metergraph/cli/blob/main/CHANGELOG.md)
- [Issues](https://github.com/metergraph/cli/issues)
- [Contributing](https://github.com/metergraph/cli/blob/main/CONTRIBUTING.md) and [releasing](https://github.com/metergraph/cli/blob/main/RELEASING.md)

## License

Apache-2.0. See [LICENSE](https://github.com/metergraph/cli/blob/main/LICENSE).
