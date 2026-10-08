# Packed client parity check

This check runs a **local, unpublished tarball** in fresh projects. It proves
packaged CLI behavior for project skill placement, an unchanged rerun, and
honest sign-in and verification refusals. It does not prove that a coding
agent discovered or followed the skill.

```sh
pack_dir="$(mktemp -d)"
npm pack --json --ignore-scripts --pack-destination "$pack_dir"
node scripts/client-parity.mjs --tarball "$pack_dir/metergraph-cli-0.2.0-preview.3.tgz"
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

## Release acceptance still needed

The report explicitly lists its unchecked gates. After a release, repeat
installation with the **registry artifact** and compare its bytes/version to
the reviewed source. For each client, confirm actual skill discovery and the
setup flow in a clean environment. Separately verify hosted authentication,
workspace identity, an instrumented application invocation and its exact
processed trace, a workspace-safe viewing link, customer-local signed bundle
behavior, and supported BYOC/OSS routes. Use only an approved test workspace
and credentials for those live checks. A local pack, CLI login, Metadata row,
or synthetic probe alone does not establish application traffic.
