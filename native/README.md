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
