# Packed client parity check

`scripts/client-parity.mjs` checks one CLI artifact: a **local tarball**
(`--tarball`) or a **published package** (`--package metergraph-cli@VERSION`,
installed from the registry with an empty npm cache). Its offline part runs
the artifact in fresh projects. It proves
packaged CLI behavior for project skill placement, an unchanged rerun, and
honest sign-in and verification refusals. It does not prove that a coding
agent discovered or followed the skill.

```sh
pack_dir="$(mktemp -d)"
npm pack --json --ignore-scripts --pack-destination "$pack_dir"
node scripts/client-parity.mjs --tarball "$pack_dir/metergraph-cli-0.2.0-preview.5.tgz"
```

The harness requires an absolute tarball path. It installs that tarball with
`npm install --offline --ignore-scripts` into temporary storage, runs the
installed binary with network and DNS calls blocked, and removes the temporary
projects when it finishes. It creates no sign-in grant or project binding.
`npm run test:package` runs the same harness against its freshly packed tarball
in the repository's Node 22/24 and Linux/macOS/Windows CI matrix. That test
uses a tarball path containing spaces and `&` without an `npm_execpath`
environment variable, covering standalone invocation without a command shell.

The single JSON report includes the tarball SHA-256, package and Node versions,
platform, each client's installed skill path and SHA-256, rerun state, status
and exact-trace result, plus the failure matrix. Record the tarball SHA-256
alongside any review or release evidence. Results from one tarball never prove
the bytes published to npm.

| Case | Expected result | What it establishes |
| --- | --- | --- |
| Codex, Claude Code, Cursor local project skill | `installed`, discovery `pending`; rerun `reused` with unchanged skill and receipt hashes | Packaged bytes and safe rerun behavior |
| Unsigned `status` | `login_required`, unauthenticated, application traffic unverified | No false connection or traffic claim |
| Unsigned exact `verify` | `login_required`, no trace data | No fabricated first trace |
| Cloud login and cloud without shell skill | `unsupported` | Explicit runtime handoff |
| Environment, workload and retained content reads | `unsupported` | No broadened read or silent filter loss |
| Verify without exact identity | `invalid_input` | Exact trace is required |

## Live setup journey

`--journey customer-local` or `--journey managed` adds a live run against a real
deployment. It records results in the report's `journey` field, and the
[release matrix](release-matrix.md) is updated from it. For each client it does
a fresh setup. It then runs the rerun, existing env file, wrong workspace,
modified skill, interrupted and denied approval, no-browser, SDK trace with
exact verify and dashboard view, verify timeout, revoked grant and logout
scenarios. Each result is labelled with its evidence class, and the report also
records timings and approval counts.

```sh
node scripts/client-parity.mjs --package metergraph-cli@0.2.0 \
  --journey customer-local --url http://localhost:8080 --workspace <workspace-id> \
  --bundle-manifest /path/to/metergraph-byoc-release.json \
  --python /path/to/venv/bin/python --keep --out report.json
```

- **customer-local** approvals are automated. `scripts/parity/browser-approver.mjs`
  is preloaded into the CLI under test and replaces the browser launcher. It hands
  each URL to a headless Chromium that signs in as the stack's own administrator
  and approves, denies or ignores the request, as the scenario needs.
  Configuration is read from the environment, never from argv:
  - `METERGRAPH_PARITY_ADMIN_ENV`: the bundle's private `.env`. Only the admin
    email and password lines are read.
  - `METERGRAPH_PARITY_PLAYWRIGHT`: an installed `playwright-core`.
  - `METERGRAPH_PARITY_CHROME`: the Chromium executable.

  Use a disposable stack started from a verified signed bundle, with no model
  provider keys in its `.env`.
- **managed** approvals (`--approver person`) open the person's own browser and
  wait for them. Run it only with their consent and an approved test workspace.
  Scenarios that need an automated denial or interruption are skipped.
- The SDK step runs `scripts/parity/sdk_app.py` with the given Python. That
  environment needs the public `metergraph` and `openai` packages. The OpenAI
  client points at a loopback mock inside the harness, so nothing is sent to a
  provider. Setup's two `.env` values are passed to that child process only.
- `--keep` keeps the work directory, including the approval and dashboard
  screenshots and the approver log. The log holds URL paths only.

A journey report holds the deployment origin, a workspace ID and a trace ID.
Keep reports and screenshots in the internal tracker, not in this repository.

## Release acceptance still needed

The report lists the gates it did not check in `not_checked`. A coding agent
finding and following the skill (`live_client_discovery`) and provider-billed
traffic (`application_traffic`) are always in that list. After a release, repeat
installation with the **registry artifact** and compare its bytes/version to
the reviewed source. For each client, confirm actual skill discovery and the
setup flow in a clean environment. Separately verify hosted authentication,
workspace identity, an instrumented application invocation and its exact
processed trace, a workspace-safe viewing link, customer-local signed bundle
behavior, and supported BYOC/OSS routes. Use only an approved test workspace
and credentials for those live checks. A local pack, CLI login, Metadata row,
or synthetic probe alone does not establish application traffic.
