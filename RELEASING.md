# Releasing

The source of truth is the public repository
[github.com/metergraph/cli](https://github.com/metergraph/cli), licensed Apache-2.0.
`0.2.0-preview.4` is published on the `next` npm tag; `latest` remains on
`0.1.0`. The hosted service supports sign in, Metadata reads and ingest bootstrap.
Subsequent releases must pass the checks below before publication.

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

## Exact revision rule

npm provenance records the commit that triggered the workflow (`GITHUB_SHA`) as the
source of the package. To keep that statement true, the workflow only releases that
commit:

- `commit_sha` must be the full 40 character SHA of the current head of `main`, and it
  must equal `GITHUB_SHA` for the run. Older commits on `main` are rejected even though
  they are ancestors of `main`.
- Both the validate job and the publish job check out that commit and confirm it.
- If `main` moves after you copy the SHA, the run fails. Start a new run with the new
  head. To release an older state, land it on `main` first.

## Bundled skill rule

The npm package and `metergraph-skills` bundle the setup skill from
[metergraph/skills](https://github.com/metergraph/skills) at the commit in
`skills-source.json`. The same file is served at https://www.metergraph.dev/SKILL.md.
Release only when all three are the same file. Both release workflows run
`node scripts/sync-skill.mjs --check-release`, which fails the release when either
bundle differs from the pinned commit or the website serves a different file. When it
fails, update the website (or this repository's pin) first; do not release around it.

## First package bootstrap (completed for 0.1.0)

npm trusted publishing is configured on a package that already exists, so the very
first version could not come from this workflow. The steps below describe the
completed bootstrap of `0.1.0`; they are not part of subsequent releases. No npm
token or secret is stored here.

1. Confirm the intended npm maintainer accounts and that `metergraph-cli` is
   available. The first approved publish establishes package ownership.
2. Run the `Release CLI` workflow with `publish` false. Download the
   `metergraph-cli-release` artifact and check its SHA-256 against the run summary.
3. From a maintainer machine with npm two-factor authentication, publish that exact
   tarball manually using `npm publish /path/to/metergraph-cli-0.1.0.tgz --access public
   --tag next --provenance=false --ignore-scripts`. This bootstrap version has no
   provenance attestation. Use a new version for the first trusted release.
4. Configure trusted publishing as described below.

## Trusted publishing

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

## Release configuration

Before an automated publish, confirm the following settings are still in place:

- the [trusted publisher](#trusted-publishing) matches this repository and workflow;
- the `npm-release` environment has required reviewers;
- the repository variable `METERGRAPH_CLI_PUBLISH_ENABLED` is `true`.

Until all of these are done, leave `publish` false.

## After a release

After each release, confirm from a clean machine, replacing `VERSION`:

```sh
npx --yes metergraph-cli@VERSION --version --json
npx --yes metergraph-cli@VERSION doctor --json
npm view metergraph-cli@VERSION dist.attestations
```

Releases from the workflow should show a provenance attestation that names
`metergraph/cli` and the released commit. The bootstrap version will not.

## Python packages

The Python packages in `python/` are released to PyPI by a separate manual workflow,
`release-pypi.yml`. See [Releasing to PyPI](python/README.md#releasing-to-pypi).
