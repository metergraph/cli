# Directory capability helper

`anchored-fs.c` is a first-party filesystem helper used only through inherited
anonymous pipes. It retains directory descriptors and traverses each basename
with `openat(O_DIRECTORY | O_NOFOLLOW)`. Mutation uses `mkdirat`, `renameat`,
`linkat`, and `unlinkat` relative to retained parents. Reads and permission
changes use opened descriptors. Requests and responses are limited to 2 MiB;
paths, contents, and errors are not logged. Secrets never appear in arguments.

`src/anchored-fs.js` verifies the selected shipped binary against `manifest.json`
before starting it. Missing artifacts, altered bytes, unsupported open modes,
and unavailable synchronous pipes fail closed. It never downloads a helper or
runs a compiler. `node native/build.mjs` is a developer/release-only build.

## Current verification matrix

| Target | Artifact | Verification |
| --- | --- | --- |
| macOS arm64 | shipped in `bin/` | local Node 24 tests |
| macOS x64 | absent | refuses secure filesystem operations |
| Linux arm64/x64 | absent | refuses secure filesystem operations |
| Windows arm64/x64 | absent | refuses secure filesystem operations |

This is not a completed multi-platform release. Windows requires a separate
handle-relative implementation and restrictive DACL creation before token bytes
are written; POSIX operations are not emulated through Windows pathname APIs.
Node 22, Linux, and Windows execution remain release verification gates.

## Producing the platform bundle

The `Verify native helpers` workflow builds macOS arm64/x64 and Linux arm64/x64
on their own hosted runners. Each executable runs the source and packed-package
tests before upload. Separate jobs download the same executable and run both
suites on Node 22 and 24. The packed-package test runs installation with an empty
tool search path, proving consumers need no compiler or download tool. Windows
jobs run platform-independent tests and explicit no-write refusals; they do not
claim functional Windows installation support.

Each single-target artifact contains only `bin/<allowlisted-name>`,
`manifest.json`, and `provenance.json`. Provenance names the exact source commit,
the C source hash, target, and executable hash. Assembly waits for every platform
and runtime test to pass, verifies an exact four-target allowlist and all hashes,
and refuses unknown files, links, duplicate JSON keys, missing/duplicate targets,
or another source revision before writing output. Only the completed
`native-helper-bundle` artifact is eligible for a release import.

Maintainers import artifacts from the reviewed workflow run and exact commit;
building alone does not establish platform support. After importing the verified
executables and manifest, rerun the ordinary CI and packed-package matrix against
the final release commit. Neither npm installation nor the runtime invokes these
development scripts. Linux artifacts are built on Ubuntu 22.04; compatibility
with older libc versions is not claimed.

The helper checks retained ancestry before pathname mutations. A stale ancestry
fails with `ESTALE`; explicit rollback mode still addresses retained parents.
Removal of an exclusively created temporary file, lock, or directory checks
its original owned identity; subsequent read-only observations cannot adopt an
attacker's replacement for cleanup. Final promoted files use the latest observed
identity so application compare-and-swap can accept a legitimate cross-process
refresh on its next transaction.
This protects descriptor containment across directory substitution. Existing
application locks and compare-and-swap checks remain necessary for transaction
semantics. POSIX `renameat` does not provide an atomic content-compare-and-replace
primitive, so concurrent same-user leaf changes between comparison and replacement
remain a separate limitation; this helper must not be described as providing
kernel-enforced compare-and-swap.

The protocol uses an operation byte, argument count, and big-endian length-prefixed
UTF-8 arguments, followed by an optional raw file-content payload. Replies carry
an errno and length-prefixed payload. Helper errors expose only fixed errno
names. The adapter deliberately permits only read, existing read/write, and
exclusive create opens. Every open includes `O_NOFOLLOW | O_NONBLOCK`; FIFOs and
other nonregular entries are refused without blocking. Numeric descriptor IDs
are private to this helper, represented as negative values in JavaScript.

The helper ignores SIGINT, SIGTERM, and SIGHUP so terminal process-group signals
cannot interrupt JavaScript transaction cleanup. Closing its inherited stdin
ends the helper; explicit adapter shutdown uses SIGKILL. Each helper is bounded
to 8,192 directory handles, file IDs, and observed entries; exhaustion refuses
operations instead of releasing or reopening pinned capabilities.
