# CLI 0.2.3 release preparation

Prepared on 2026-10-21 and updated the same day to include #69. Not published. npm currently serves `latest: 0.2.2`
and `next: 0.2.1`; the registry returned 404 for version 0.2.3.

## Changes

- Experiments: `list`, `estimate`, `start` and `get`, with Metadata-only reads,
  a separate start key, budget checks, verified estimates and an unconfirmed-start
  outcome that warns users to check before retrying.
- Public pricing: model discovery, lookup, calculation and a current market board.
  History and HTML exports use the explicit local reference adapter.
- Release-matrix evidence distinguishes synthetic application traffic and records
  missing-scope and API-parity gaps explicitly.
- Setup at a terminal asks for the flags it is missing, prints the full command
  once it parses, and exits 17 on Ctrl-C or Ctrl-D. With `--json`, a pipe or `CI`
  nothing is asked, and a remote session sends no request before its handoff (#69).
- A successful customer-local setup returns `data.agent_access`, the fixed
  `bin/agent-key` command for giving the agent a Debug key (which reads captured
  prompts and responses) with evaluation and analysis permissions. At a terminal
  setup offers to run the bundle's `bin/agent-key` after the person types the bundle
  directory and confirms the program's full path (#69).

No Python package version or bundled skill pin changes in this release. The
bundled skills stay at `39411ce`, so the bundled `metergraph-local-bundle` skill
does not yet describe `bin/agent-key`; that arrives with the next skills pin.

## Checks on the prepared source

Rerun on the source with #69 merged (main at `e6289bf` plus these notes).

| Check | Result |
|---|---|
| `npm test` | Pass: 514 passed, 2 platform skips, 0 failures |
| `npm run test:package` | Pass: 15 packed-install and parity tests |
| Python installer suite | Pass: 21 tests run, 1 platform skip |
| `node scripts/sync-skill.mjs --check-release` | Pass: setup and ten workflow skills match the pinned source; the website serves the same setup skill |
| Publication scan against main | Pass |
| `npm pack --ignore-scripts` | Pass: `metergraph-cli-0.2.3.tgz` |
| Packed setup smoke | Pass: `--version` is 0.2.3; piped `setup` and `setup --json` exit 2 `missing_runtime` and ask nothing; at a pseudo-terminal, Ctrl-C at the first question exits 17 `cancelled`, and answering the questions against a local bundle prints the full command and stops at the prerequisite handoff with nothing written to the project |
| Packed experiments smoke | Pass at the first preparation (`caef03b`): version, estimate, Metadata-key start refusal, start, get, list and start-key read refusal against the synthetic loopback service. Not rerun; #69 changes no experiments code, and `npm test` covers experiments |

The local tarball SHA-256 is
`838cf3678eb724961ee8c09a4afc2be9aadcac61872305adf41a3e49d3d11d45`.
The release workflow must rebuild and record its own artifact checksum at the
exact approved main commit; this local artifact is preparation evidence only.

## Remaining release gates

- Cross-platform CI must pass on the release PR.
- Merge the release version commit into main, then run `Release CLI` from main
  with `version=0.2.3`, the full current main `commit_sha`, `dist_tag=latest` and
  `publish=false`. The workflow refuses feature branches, so this dry run cannot
  validate the new version before its commit reaches main.
- Live hosted/customer-local experiments acceptance remains Pending in
  [the release matrix](release-matrix.md#experiments). Synthetic CLI tests do not
  establish service deployment or end-to-end customer acceptance. Any provider-billed
  start needs separately approved bounded spend.
- Publication requires a separate maintainer decision and the configured release
  environment approval. No npm publication, dist-tag changes or release tags
  were performed during preparation.
