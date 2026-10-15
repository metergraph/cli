# Release matrix

This file records, for each coding client, OS and runtime, and deployment, whether
`metergraph-cli` setup is **supported**, **unsupported** or **untested**. Update it
from the parity harness report ([packed client parity](packed-client-parity.md)) for
every release candidate before `latest` moves.

- **Supported**: a live run of a released or release-candidate artifact passed on
  that combination.
- **Unsupported**: the CLI refuses the combination by design and names a next step.
- **Untested**: it may work, but no live run backs it. Do not advertise it as
  supported.

Evidence is labelled by class and the classes are never merged:

| Class | Meaning |
|---|---|
| `synthetic_fixture` | Source tests against the loopback test service in `test/`. |
| `real_deployment` | The installed artifact against a real deployment with real sign-in and consent. No application traffic. |
| `synthetic_application_traffic` | The public Python SDK sends a trace through the key setup wrote, but the model provider is a local mock. No provider call. |
| `real_application_traffic` | A real, approved, provider-billed application call. |
| `client_discovery` | The coding agent itself found and followed the installed skill. |

## Deployments

| Deployment | Status for 0.2.0 | Evidence |
|---|---|---|
| Hosted (`managed`) | Supported on macOS | `real_application_traffic` on the released `0.2.0` from the registry: the agent `setup --json --no-browser` flow, one approved paid call through an AI gateway (13 input and 5 output tokens, under $0.0001), its exact trace verified with `verify --source application` in one attempt (0.66 s, `content_included: false`) and opened in the dashboard filtered to that trace. `real_deployment`: the fresh agent `setup --json --no-browser` flow, rerun, `status` and `logout` on `0.2.0-preview.6` from the registry. `real_deployment` and `synthetic_application_traffic`: every scenario below on `0.2.0-preview.5` from the registry, with a person's browser approvals. Earlier `real_application_traffic`: one paid call on `0.2.0-preview.1`, fixes rerun on `preview.2` |
| Customer-local, released signed bundle | Supported on macOS | `real_deployment` and `synthetic_application_traffic`: signed bundle `v0.2.104`, every scenario below (19 of 19), on `0.2.0-preview.6` from the registry. Earlier: `v0.2.96` and `v0.2.104` on `0.2.0-preview.5` and on a tarball packed from `main` |
| Customer-owned cloud (`byoc`) | Untested | `synthetic_fixture` only. No reachable operator-provisioned deployment was available |
| Open source server (`oss`) | Untested | `synthetic_fixture` only. Setup hands ingest configuration to the operator |

## Clients, OS and runtime

The `--client` flag only chooses where the skill is installed. The setup protocol is
the same for all three clients. Rows say what was run with each one.

| Client | OS / runtime | Hosted | Customer-local | Skill found by the agent |
|---|---|---|---|---|
| Claude Code | macOS 27 arm64, Node 24, npm 11 | Supported | Supported | Supported (`client_discovery`, Claude Code 2.1.295 on `0.2.0-preview.5`) |
| Codex | macOS 27 arm64, Node 24, npm 11 | Supported | Supported | Supported (`client_discovery`, Codex 0.154.0 on `0.2.0-preview.5`) |
| Cursor | macOS 27 arm64, Node 24, npm 11 | Supported | Supported | Untested for 0.2.0. Skill file placement verified only |
| Any | Linux (Debian 12, Node 22 and 24, arm64 and amd64 containers) | Untested past sign-in. Install, skill install and cancelled sign-in pass | Untested | Untested |
| Any | Windows, Node 22 and 24 | Untested live. `synthetic_fixture` passes in CI | Untested. The bundle needs WSL | Untested |
| Any | Node 22 or 24 on macOS, Linux or Windows | `synthetic_fixture` passes in CI for every row | | |
| Any | Cloud or no-shell agent runtime, remote SSH, CI | **Unsupported**. Setup hands off to the customer's machine and creates no tunnel. Metadata reads with an existing key are [pending](#pending-release-checks) | **Unsupported**, same handoff | |
| Claude Desktop | | **Unsupported** for `setup`. `skills install --client claude-desktop` points to the plugin marketplace | | |

## Setup scenarios

Both columns are from `0.2.0-preview.5` installed from the registry on macOS 27
arm64, Node 24.7.0, npm 11.5.1, using the three clients' skill paths. Customer-local
ran against `v0.2.96` and `v0.2.104` with automated approvals, and the packed
`main` CLI ran against `v0.2.104` as well. Hosted ran against production with
the approvals done in the person's own signed-in browser.

| Scenario | Customer-local | Hosted |
|---|---|---|
| Fresh setup, per client | Pass. `ok`, `.env` created 0600 and git-ignored, skill bytes match the bundle. Two approvals | Pass, same checks |
| Rerun | Pass. `env: unchanged`, `skill: reused`, files byte-identical, no approval | Pass |
| Rerun with `--json --no-browser` | Pass. `ok` with no approval | Pass |
| Fresh `--json --no-browser` (how an agent sets up) | `preview.6` and `main`: pass. Three runs: exit 18 `action_required` with an `open_url` for sign-in, then for the ingest key, then `ready_for_instrumentation`. Nothing is written before the first approval; 3.4 s with the approvals automated. `preview.5`: pass on the older contract, exit 6 `no_browser_requires_terminal` with nothing written | `preview.6`: pass. Exit 18 with an `open_url` for sign-in in 2.2 s with nothing written in the project, then for the ingest key in 1.1 s; after both approvals `.env` is 0600 and git-ignored and the skill is `e7fc4eb7a22e`. The next run returns `ready_for_instrumentation` with `env: unchanged`, `skill: reused` in 1.4 s, `status` reports `managed` verified with `agent:metadata` only, and `logout` is `accepted`, then `status` exits 12 `login_required`. `preview.5`: pass on the older contract |
| Existing `.env` with other values | Pass. Values kept, ingest values added | Pass |
| Existing `.env` with a key setup did not issue | Pass. Exit 8 `existing_ingest_key_unowned`, `.env` byte-identical. `preview.6` refuses before sign-in with no approval; `preview.5` needed one | `preview.5`: pass, one approval before the refusal |
| Wrong `--workspace` on a set-up project | Pass. Exit 8 `setup_binding_changed`, nothing changed, no approval | Pass |
| Wrong `--workspace` on a fresh project | Pass. Exit 11 `workspace_mismatch` after one approval, nothing saved | Not run: hosted sign-in uses the browser's active workspace |
| Modified skill file | Pass. Exit 8, `credential_ready_skill_pending`, edit kept, `.env` unchanged; rerun after restoring passes | Pass |
| Interrupted approval (SIGINT) | Pass. `authorization_failed` / `cancelled`, nothing saved, `status` is `login_required` | Pass |
| Denied approval | Pass. `authorization_failed` / `access_denied`, nothing saved | Pass |
| SDK trace and exact `verify` | Pass (`synthetic_application_traffic`). One processed trace, `content_included: false`, workspace-bound link | `0.2.0`: pass (`real_application_traffic`). One paid chat completion (13 input, 5 output tokens) found on the first attempt in 0.66 s, `content_included: false`, workspace-bound link; the dashboard opened on the exact trace with the gateway's request ID. Earlier: `synthetic_application_traffic` on `preview.5` |
| Dashboard view of the link | Pass. Opens filtered to the exact trace | Pass on the earlier paid trace. Not repeated in this run |
| `verify` timeout, 3000 ms | Pass. Exit 11 `trace_not_found_within_bounds` in 3.1 s | Pass |
| Grant revoked on the server but still saved locally | Pass. `status` and `verify` exit 12 `login_required` / `access_revoked`, no credential printed | Pass |
| Ingest key revoked on the server, `setup --repair` | Untested | Untested |
| Denied npm registry access | Untested | Untested |
| Fresh image pull with a customer's pull-only registry credential | Untested. Runs used images already cached on the machine | Not applicable |
| `logout` | Pass. `revocation: accepted`; `verify` then `login_required` | Pass |

## Baseline

The first setup-duration baseline for customer-local, on `0.2.0-preview.5` from the
registry. It counts from command start to receipt, with the approvals automated:

- Fresh setup: 2.6 to 3.5 s. Two approvals: sign-in consent, then ingest-key
  consent. A person does both by hand, so a person's time is longer.
- Rerun: under 0.2 s, no approval.
- Bundle start, `bin/start` from a verified signed bundle with cached images: 25 s.

No comparison with other tools is claimed. Hosted setup took 10 to 16 s including a
person's approvals in the earlier hosted runs. The latest hosted run's setup times
measure the assisted approvals, not the CLI, so they are not a baseline. Its rerun
took under 1 s with no approval.

On the released `0.2.0`, hosted setup through the agent flow took three runs of 1.2 s,
0.7 s and 0.9 s of CLI time, plus two approvals in a person's browser.

## Skill discovery

Each agent ran headless in a project where `setup` had installed the skill:
Claude Code with only read tools, and Codex in its read-only sandbox. Each got two
prompts:

1. Which skills are available, and from which `SKILL.md` path.
2. Which variables setup wrote and where, and the command the skill gives for
   confirming one exact trace.

| Agent | Found the project skill | Followed it |
|---|---|---|
| Claude Code | Yes. `metergraph` at `.claude/skills/metergraph/SKILL.md` | Yes. Named `METERGRAPH_APP_TOKEN` and `METERGRAPH_INGEST_URL` in `.env`, and `metergraph verify` with its `npx` fallback. It did not open `.env` |
| Codex | Yes. `metergraph` at `.agents/skills/metergraph/SKILL.md` | Yes, the same answers |

Neither agent printed a credential. Neither could give the full `verify` flags,
because the skill names the command without them.

## Still open before 0.2.0 is called fully verified

- Cursor finding and following the skill. It is untested for 0.2.0.
- Hosted and customer-local runs on Linux and Windows hosts.
- Revoked ingest key repair, denied npm registry access, and a fresh image pull
  with a customer's pull-only registry credential.
- `byoc` and `oss` against live deployments.

## Pending release checks

`0.2.2` is the first version that carries both journeys. Through `0.2.1`, `usage`
takes only `--days` and `--limit`, and the read commands accept only a project's
saved sign-in grant. Every parity report lists both journeys in `not_checked`
until the harness has scenarios for them. Each row stays **Pending** until a live
run of the published package passes; a packed tarball, source tests or an API
call outside the CLI do not count. Exact flags, outcomes and reasons are recorded
from the released help when the row is run.

Both journeys need a service that offers them. A service release that predates
grouped usage, the metadata filter echo and the combined setup approval does not
advertise them. Against it, `usage` with grouping exits 14 `capability_unavailable`
(`usage_aggregates_unavailable`) and points to `usage --days 7`, metadata filters
exit `metadata_filter_unsupported`, and a first `setup` keeps two approvals.

### Run plan for the published `0.2.2`

Run from the registry (`--package metergraph-cli@0.2.2`) on macOS with an approved
test workspace. Rows not listed stay Pending.

| Journey | Rows | Against | Needs |
|---|---|---|---|
| Remote key | Remote markers with no key or grant; a local container; key supplied privately; key never disclosed | Hosted, with a service release that offers the key reads | A Metadata key a person creates on the Keys page, held in a 0600 file or the environment |
| Remote key | Key for another workspace, revoked, or missing a scope | Hosted | A second workspace's key, and a key the person revokes after the first row |
| Usage | Every question row from most expensive route today through parity with the agent API, except a capability the deployment lacks | Hosted, with a service release that offers grouped usage | A Metadata grant or key on a workspace with recent traffic |
| Usage | A capability the deployment lacks | A customer-local bundle that predates grouped usage | The bundle's own administrator approvals |
| Both | Skill discovery rows | The hosted projects above | Approval for the bounded agent prompts |

Not in this plan: an expired key (no way to make one expire on demand),
signup and invitation (they need a new person's account), and Linux and
Windows hosts.

#### Run of 2026-10-15

`metergraph-cli@0.2.2` from the registry on macOS, against the hosted service, in a
new test workspace. Traffic was 33 synthetic calls (3 routes, 2 models, 3 failures,
`prompt_id` and `workflow_name` tags) captured by the published `metergraph` SDK
from an OpenAI client pointed at a local mock server, so no provider was called.
Remote sessions were marked with `SSH_CONNECTION`. Manual steps: 4 (sign up and
approve setup, create the Metadata key, save it to a 0600 file, revoke it).
Still Pending: a capability the deployment lacks, signup and invitation reruns,
and both skill discovery rows.

### Metadata reads from a remote agent session with an existing key

The agent runs in a session the CLI identifies as remote (SSH, a cloud
workspace or CI). It has a private Metadata key that a person created, and no
saved sign-in grant.

| Check | Expected result | Evidence class | Status |
|---|---|---|---|
| Remote markers present, no key, no grant | `login` and the read commands return a precise remote reason with a `use_agent_key` next action, and `setup` returns `run_on_local_machine`. No browser flow is claimed from a URL alone. Nothing written | `real_deployment` | Pass (0.2.2): SSH markers; `login` exit 6 `ssh_session`, `status`, `usage`, `routes` and `traces` exit 12 `not_signed_in`, all with `use_agent_key`; `setup` exit 6 `run_on_local_machine`; nothing written |
| A local container without remote markers | Reported as `local_container`, not as a remote session | `real_deployment` | Pass (0.2.2): `status` in a `node:22-slim` Docker container reports `environment: local_container` with a `login` next action |
| Key supplied privately through `METERGRAPH_AGENT_TOKEN` or `--agent-token-file`, never as an argument | The CLI checks origin, workspace, exactly the Metadata scope and no content access before any read, then `status`, `context`, `capabilities`, `usage`, `routes` and `traces` return Metadata only, with `credential` and `environment` in the output | `real_deployment` | Pass (0.2.2): with SSH markers and no grant, `--agent-token-file` (0600) and `METERGRAPH_AGENT_TOKEN` both verify origin, profile and `agent:metadata` with `content_access: false`; `status`, `context`, `capabilities`, `usage` (grouped and route by day), `routes` and `traces` exit 0 with `credential: agent_key` and `environment: ssh_session`. Without `--workspace`, `workspace.match` is null with `workspace_not_pinned`; with it, true |
| Key never disclosed | No key value in argv, stdout, stderr, JSON output, logs or project files | `real_deployment` | Pass (0.2.2): the key was never an argument (an unknown `--token` option exits 2); a scan of every stdout, stderr and JSON output, the project, the config directory and the npm logs found no key value |
| Key for another workspace, expired, revoked or missing a scope | Refused with its own reason before any data is read. No fallback to retained content or replay | `real_deployment` | Partial (0.2.2): `--workspace` for another workspace exits 11 `workspace_context_mismatch` (`use_workspace_key`); an unknown key and a key revoked on the Keys page exit 12 `agent_key_rejected` (`replace_agent_key`); no data read. A second workspace's own key, an expired key and a key with broader scopes were not run |
| Signup, invitation and workspace choice | Each human step returns a `next_action`; rerunning after it shows the verified workspace and the next step, with no duplicate key | `real_deployment` | Pending |
| A coding agent in a remote session follows the skill | It uses the official CLI with the key path and does not write its own API client | `client_discovery` | Pending |

Record the package version, the remote markers present, the number of manual
steps and the verified outcome.

### Usage cost questions

Each question is answered by one documented `usage` command against an approved
test workspace, and its totals are compared with the same server read through
the agent API.

| Question | Expected result | Evidence class | Status |
|---|---|---|---|
| Most expensive route today | Routes ranked by cost over an explicit UTC window | `real_deployment` | Pass (0.2.2): `usage --group-by route --today` ranks 3 routes by cost over the UTC day so far, marked partial |
| Spend with one provider | A provider filter over a bounded window | `real_deployment` | Pass (0.2.2): `usage --group-by provider --provider openai --days 7` |
| Spend by model | Grouped by model | `real_deployment` | Pass (0.2.2): `usage --group-by model --days 7` |
| One route's daily trend | Grouped by UTC day for one route | `real_deployment` | Pass (0.2.2): `usage --route NAME --group-by day --days 14` |
| Cost ranked by a metadata key | Grouped by an eligible metadata key, kept distinct from route | `real_deployment` | Pass (0.2.2): `usage --group-by metadata.prompt_id --days 7` (groups sum to the totals) and `--metadata workflow_name=VALUE` as a filter |
| Comparison with the prior period | Both windows shown in UTC, with a warning when a partial current day is compared with a full prior day | `real_deployment` | Pass (0.2.2): `usage --group-by route --today --compare previous` shows both UTC windows, says "Not like for like" and returns a `compare_like_for_like` next action naming `--compare previous-same-time` |
| Coverage and cost attribution | Shown in text and JSON for every answer above | `real_deployment` | Pass (0.2.2): coverage, pricing (a lower bound with partially priced calls) and per-call attribution in text and JSON for every row above |
| A capability the deployment lacks | Exit 14 `capability_unavailable` or a documented `next_action`, with nothing read | `real_deployment` | Pending |
| Parity with the agent API | Same totals, groups and window as the server read | `real_deployment` | Pass (0.2.2): `metergraph_get_usage_aggregates` with the same key returns the same totals, groups and UTC window for route, model and `metadata.prompt_id`. The CLI names a metadata group `metadata_key`/`metadata_value` where the tool uses `metadata.<key>` |
| A coding agent answers a cost question from the skill | It runs the smallest bounded `usage` read that answers it, and does not attribute a cost change to a commit from a diff alone | `client_discovery` | Pending |

These runs read Metadata only and make no provider call.
