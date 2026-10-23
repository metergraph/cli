# Contributing

```sh
npm test                  # unit tests and CLI subprocess tests against loopback servers
npm run test:package      # npm pack into a temporary directory, clean install, run the installed bin
node bin/metergraph.js --help
node bin/metergraph.js doctor --url http://127.0.0.1:8080 --json
node bin/metergraph.js skill install --client claude --runtime local --project /path/to/project --json
node bin/metergraph.js login --runtime local --url http://127.0.0.1:8080 --project /path/to/project
```

Tests require development OpenSSL on `PATH` (no additional runtime dependency).
The runner generates a one-day localhost/127.0.0.1/::1 TLS identity in private OS
temporary storage, trusts it only in child test processes, and removes its files
when tests finish or fail. No system trust is changed. Run individual tests with
`node test/run-tests.js test/auth-oauth.test.js`; direct fixture servers must run
inside this runner lifecycle. Never commit generated keys or certificates.

The sign in and read command tests run against a synthetic loopback service and a
test-only browser stand-in loaded with `--import`. They prove the protocol, file
handling and output rules, not the real service, a real browser, real workspace
consent or real workspace data. The Windows DPAPI round trip
runs only on the Windows CI runner.

To try a packed artifact without publishing:

```sh
pack_dir="$(mktemp -d)"
package_version="$(node -p "require('./package.json').version")"
npm pack --ignore-scripts --pack-destination "$pack_dir"
npx --yes --package="$pack_dir/metergraph-cli-$package_version.tgz" -- metergraph --version
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

## Public pricing integration

`node test/run-tests.js test/pricing-public.test.js test/pricing.test.js` checks the public
GET/POST contract and the preserved local reference protocol using synthetic
loopback responses. Run `npm run test:package` for the installed CLI.

Public service checks are opt-in: set `PRICING_PUBLIC_ORIGIN` and run
`scripts/pricing-public-smoke.mjs`. Reference core checks use `PRICING_PYTHON`
and `scripts/pricing-smoke.mjs`. Either accepts `PRICING_BIN` for a packed CLI.
See [docs/pricing.md](docs/pricing.md#validation-and-networking) for limitations.
Public history is not supported; reference previews require explicit loopback mode.
