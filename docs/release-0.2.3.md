# CLI 0.2.3 release preparation

Prepared on 2026-10-21. Not published. npm currently serves `latest: 0.2.2`
and `next: 0.2.1`; the registry returned 404 for version 0.2.3.

## Changes

- Experiments: `list`, `estimate`, `start` and `get`, with Metadata-only reads,
  a separate start key, budget checks, verified estimates and an unconfirmed-start
  outcome that warns users to check before retrying.
- Public pricing: model discovery, lookup, calculation and a current market board.
  History and HTML exports use the explicit local reference adapter.
- Release-matrix evidence distinguishes synthetic application traffic and records
  missing-scope and API-parity gaps explicitly.

No Python package version or bundled skill pin changes in this release.

## Checks on the prepared source

| Check | Result |
|---|---|
| `npm test` | Pass: 490 passed, 2 platform skips, 0 failures |
| `npm run test:package` | Pass: 15 packed-install and parity tests |
| Python installer suite | Pass: 21 tests run, 1 platform skip |
| `node scripts/sync-skill.mjs --check-release` | Pass: setup and ten workflow skills match the pinned source; the website serves the same setup skill |
| Publication scan against main and whitespace check | Pass |
| `npm pack --ignore-scripts` | Pass: `metergraph-cli-0.2.3.tgz` |
| Packed experiments smoke | Pass: version, estimate, Metadata-key start refusal, start, get, list and start-key read refusal against the synthetic loopback service |

The local tarball SHA-256 is
`505314358c515d776f0c39d8d74a5eb1453ad5925fe4e4b776f752f53dd2614b`.
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
