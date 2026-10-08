# Python packages

| Directory | PyPI name | Contents |
| --- | --- | --- |
| `metergraph-skills/` | `metergraph-skills` | Installs the Metergraph agent skill into a project. See its [README](metergraph-skills/README.md). |
| `placeholders/metergraph-cli/` | `metergraph-cli` | Name held by Metergraph. Points to the npm CLI. |
| `placeholders/metergraph-mcp/` | `metergraph-mcp` | Name held by Metergraph. Points to the hosted MCP guide. |
| `placeholders/metergraph-skill/` | `metergraph-skill` | Name held by Metergraph. Points to `metergraph-skills`. |
| `placeholders/metergraph-agent/` | `metergraph-agent` | Name held by Metergraph. Points to `metergraph-skills` and `metergraph`. |
| `placeholders/metergraph-agents/` | `metergraph-agents` | Name held by Metergraph. Points to `metergraph-skills` and `metergraph`. |

The placeholders contain no functionality. They exist so that nobody else can
register a confusable Metergraph name. `metergraph-relay` is not needed: PyPI
rejects new names that differ from an existing project, here
`metergraphrelay`, only by `-`, `_` or `.`.

`metergraph-skills` bundles a copy of `assets/skill/SKILL.md` and
`assets/skill/manifest.json`. When the npm CLI's skill changes, copy both files
into `metergraph-skills/src/metergraph_skills/skill/`, update `PINNED_SHA256`
in `bundle.py`, and release a new version of both packages. CI fails while the
copies differ.

Run the tests with `python -m unittest discover -s python/metergraph-skills/tests`.

## Releasing to PyPI

Releases are manual. The `Release Python package` workflow
(`.github/workflows/release-pypi.yml`) runs only when a maintainer starts it
from `main` and picks one package. It follows the same
[exact revision rule](../RELEASING.md#exact-revision-rule) as the npm release. It:

1. checks that `commit_sha` equals the commit the run started from, that it is on
   `main`, and that `version` equals the package's `pyproject.toml`;
2. asks PyPI for that exact version and continues only on a `404`;
3. installs the hash-pinned build tools in `requirements-build.txt`, runs the tests,
   builds the wheel and sdist, and checks their contents with
   `scripts/check_python_dist.py`;
4. installs the wheel into a clean virtual environment and runs it;
5. only if `publish` is true, waits for approval on the `pypi-release`
   environment, verifies the checksums and publishes with PyPI trusted publishing
   and digital attestations.

Leave `publish` false for a dry run. No PyPI token is stored anywhere.

### Trusted publishers

Each project needs a trusted publisher on PyPI before its first release. For a
name that does not exist yet, add a *pending publisher* from the PyPI account
that should own the project, under **Your account → Publishing**. Use these
values for every package in the table above:

| Field | Value |
| --- | --- |
| PyPI project name | the package name, for example `metergraph-skills` |
| Owner | `metergraph` |
| Repository name | `cli` |
| Workflow name | `release-pypi.yml` |
| Environment name | `pypi-release` |

A pending publisher does not reserve the name. The project is created, and the
name held, by the first successful publish from this workflow. Until then
anyone can register it.

### Release configuration

Before a publish, confirm the following settings are in place:

- a trusted publisher, or pending publisher, exists for the package;
- the `pypi-release` environment has required reviewers;
- the repository variable `METERGRAPH_PYPI_PUBLISH_ENABLED` is `true`.
