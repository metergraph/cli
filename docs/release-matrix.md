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
| Hosted (`managed`) | Supported on macOS | `real_deployment` and `synthetic_application_traffic`: every scenario below on `0.2.0-preview.5` from the registry, with a person's browser approvals. `real_application_traffic`: one approved paid call, its exact trace verified and viewed (`0.2.0-preview.1`, fixes rerun on `preview.2`) |
| Customer-local, released signed bundle | Supported on macOS | `real_deployment` and `synthetic_application_traffic`: signed bundle `v0.2.96`, every scenario below, on `0.2.0-preview.5` from the registry and packed from source |
| Customer-owned cloud (`byoc`) | Untested | `synthetic_fixture` only. No reachable operator-provisioned deployment was available |
| Open source server (`oss`) | Untested | `synthetic_fixture` only. Setup hands ingest configuration to the operator |

## Clients, OS and runtime

The `--client` flag only chooses where the skill is installed. The setup protocol is
the same for all three clients. Rows say what was run with each one.

| Client | OS / runtime | Hosted | Customer-local | Skill found by the agent |
|---|---|---|---|---|
| Claude Code | macOS 27 arm64, Node 24, npm 11 | Supported | Supported | Checked on `0.2.0-preview.0` only. Rerun on the RC |
| Codex | macOS 27 arm64, Node 24, npm 11 | Supported | Supported | Untested. Skill file placement verified only |
| Cursor | macOS 27 arm64, Node 24, npm 11 | Supported | Supported | Untested. Cursor is not installed on the test machine |
| Any | Linux (Debian 12, Node 22 and 24, arm64 and amd64 containers) | Untested past sign-in. Install, skill install and cancelled sign-in pass | Untested | Untested |
| Any | Windows, Node 22 and 24 | Untested live. `synthetic_fixture` passes in CI | Untested. The bundle needs WSL | Untested |
| Any | Node 22 or 24 on macOS, Linux or Windows | `synthetic_fixture` passes in CI for every row | | |
| Any | Cloud or no-shell agent runtime, remote SSH, CI | **Unsupported**. Setup hands off to the customer's machine and creates no tunnel | **Unsupported**, same handoff | |
| Claude Desktop | | **Unsupported** for `setup`. `skills install --client claude-desktop` points to the plugin marketplace | | |

## Setup scenarios

Both columns are from `0.2.0-preview.5` installed from the registry on macOS 27
arm64, Node 24.7.0, npm 11.5.1, using the three clients' skill paths. Customer-local
ran against `v0.2.96` with automated approvals. Hosted ran against production with
the approvals done in the person's own signed-in browser.

| Scenario | Customer-local | Hosted |
|---|---|---|
| Fresh setup, per client | Pass. `ok`, `.env` created 0600 and git-ignored, skill bytes match the bundle. Two approvals | Pass, same checks |
| Rerun | Pass. `env: unchanged`, `skill: reused`, files byte-identical, no approval | Pass |
| Rerun with `--json --no-browser` | Pass. `ok` with no approval | Pass |
| Fresh `--json --no-browser` | Pass. Exit 6 `no_browser_requires_terminal`, `next_action: run_in_terminal`, nothing written | Pass |
| Existing `.env` with other values | Pass. Values kept, ingest values added | Pass |
| Existing `.env` with a key setup did not issue | Pass. Exit 8 `existing_ingest_key_unowned`, `.env` byte-identical. One sign-in approval happens before the refusal | Pass, same |
| Wrong `--workspace` on a set-up project | Pass. Exit 8 `setup_binding_changed`, nothing changed, no approval | Pass |
| Wrong `--workspace` on a fresh project | Pass. Exit 11 `workspace_mismatch` after one approval, nothing saved | Not run: hosted sign-in uses the browser's active workspace |
| Modified skill file | Pass. Exit 8, `credential_ready_skill_pending`, edit kept, `.env` unchanged; rerun after restoring passes | Pass |
| Interrupted approval (SIGINT) | Pass. `authorization_failed` / `cancelled`, nothing saved, `status` is `login_required` | Pass |
| Denied approval | Pass. `authorization_failed` / `access_denied`, nothing saved | Pass |
| SDK trace and exact `verify` | Pass (`synthetic_application_traffic`). One processed trace, `content_included: false`, workspace-bound link | Pass (`synthetic_application_traffic`, and earlier `real_application_traffic`) |
| Dashboard view of the link | Pass. Opens filtered to the exact trace | Pass on the earlier paid trace. Not repeated in this run |
| `verify` timeout, 3000 ms | Pass. Exit 11 `trace_not_found_within_bounds` in 3.1 s | Pass |
| Grant revoked on the server but still saved locally | Pass. `status` and `verify` exit 12 `login_required` / `access_revoked`, no credential printed | Pass |
| Ingest key revoked on the server, `setup --repair` | Untested | Untested |
| Denied npm registry access | Untested | Untested |
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

## Still open before 0.2.0 is called fully verified

- A coding agent finding and following the installed skill. Rerun it for Claude
  Code, and run it for Codex and Cursor.
- Hosted and customer-local runs on Linux and Windows hosts.
- Revoked ingest key repair, and denied npm registry access.
- `byoc` and `oss` against live deployments.
