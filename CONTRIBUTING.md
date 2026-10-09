# Contributing

```sh
npm test                  # unit tests and CLI subprocess tests against loopback servers
npm run test:package      # npm pack into a temporary directory, clean install, run the installed bin
node bin/metergraph.js --help
node bin/metergraph.js doctor --url http://127.0.0.1:8080 --json
node bin/metergraph.js skill install --client claude --runtime local --project /path/to/project --json
node bin/metergraph.js login --runtime local --url http://127.0.0.1:8080 --project /path/to/project
```

The sign in and read command tests run against a synthetic loopback service and a
test-only browser stand-in loaded with `--import`. They prove the protocol, file
handling and output rules, not the real service, a real browser, real workspace
consent or real workspace data. The Windows DPAPI round trip
runs only on the Windows CI runner.

To try a packed artifact without publishing:

```sh
npm pack --pack-destination "$(mktemp -d)"
npx --yes --package=/path/to/metergraph-cli-0.2.0-preview.5.tgz -- metergraph --version
```

Do not commit tarballs or other generated files.

## Before you open a pull request

This repository is public. Read [AGENTS.md](AGENTS.md) for what may appear in branch
names, commits, pull requests and fixtures, and run the publication check before
pushing:

```sh
python3 scripts/check_publication.py origin/main
```

The Python packages in `python/` have their own tests:

```sh
python -m unittest discover -s python/metergraph-skills/tests
```

Report security issues privately, as described in [SECURITY.md](SECURITY.md), not in a
public issue. Releases are covered in [RELEASING.md](RELEASING.md).
