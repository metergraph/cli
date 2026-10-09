# metergraph-skills

Installs the Metergraph agent skill into a project, so Codex, Claude Code or
Cursor can load it. This is the Python equivalent of `metergraph skill` in the
npm CLI ([`metergraph-cli`](https://www.npmjs.com/package/metergraph-cli)).

This package does not sign in, connect a workspace, configure MCP or make any
network request. For those, use the npm CLI: `npx metergraph-cli@next`. The
Python SDK for instrumenting an application is a different package,
[`metergraph`](https://pypi.org/project/metergraph/).

## Install the skill

```sh
pip install metergraph-skills
metergraph-skills install --client claude
```

Run it in the project directory, or pass `--project DIR`.

| Option | Values |
| --- | --- |
| `--client` | `codex`, `claude`, `cursor` |
| `--runtime` | `local` (default), `cloud` |
| `--project` | Project directory. Default: the current directory. |
| `--json` | Print one JSON line on stdout. |

The skill is written to the client's project skill directory:

| Client | Path |
| --- | --- |
| Codex | `.agents/skills/metergraph/SKILL.md` |
| Claude Code | `.claude/skills/metergraph/SKILL.md` |
| Cursor | `.cursor/skills/metergraph/SKILL.md` |

An ownership receipt is written to `.metergraph/skill-installations.json`. It
holds no secrets. No other file is touched. Restart the client afterwards; the
skill is not discovered until the client loads it.

Use `metergraph-skills update` to replace an older revision installed by
Metergraph. A skill file that Metergraph did not install, or that was edited
after it was installed, is never replaced.

## Same files as the npm CLI

`metergraph-skills` and `metergraph skill` write the same paths and the same
receipt. A skill installed by one is recognised and updated by the other. The
bundled `SKILL.md` is byte-identical to the one in the npm package and to
<https://www.metergraph.dev/SKILL.md> for the same revision, and its SHA-256
is checked before anything is written.

To copy the file yourself, `metergraph-skills path` prints the directory that
holds the bundled `SKILL.md` and `manifest.json`.

## More Metergraph skills

The setup skill comes from [metergraph/skills](https://github.com/metergraph/skills),
the source for every Metergraph agent skill, at a pinned commit. That repository
also has the model-swap skills: choose a workload, choose traces and models,
define the eval, run the analysis, read the report and rerun. This package installs
only the setup skill. For the others, use `npx skills add metergraph/skills`,
`npx --yes metergraph-cli@next skills install --client claude --runtime local`, or
the `metergraph/skills` plugin marketplace in Claude Code and Claude Desktop.

## Exit codes

| Code | Outcome |
| --- | --- |
| 0 | `ok` |
| 1 | `internal_error`: the bundled skill failed its integrity check |
| 2 | `invalid_input` |
| 6 | `unsupported`: the client or runtime cannot load project skill files |
| 8 | `conflict`: an existing file was not replaced |
| 9 | `filesystem_error` |

## License

Apache-2.0. Source: <https://github.com/metergraph/cli>.
