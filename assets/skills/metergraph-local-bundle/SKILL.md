---
name: metergraph-local-bundle
description: Verify and start the signed Metergraph customer-local bundle on a person's own machine, preserve existing local data and secrets, then hand over to metergraph setup. Use when customer-local setup reports that the bundle_started_verified prerequisite is incomplete or when installing the commercial local bundle from a public release.
---

# Start the signed customer-local bundle

Stand up the released bundle only on the person's own machine, then run
`metergraph setup`. The CLI does not provision it, and
`--confirm-prerequisites` records confirmation rather than installing anything.

Keep registry, admin and database secrets out of chat, command arguments and
output. Never read or print `.env` values, `~/.docker/config.json`,
`docker compose config` output or container environment from `docker inspect`.
Do not configure model-provider keys.

## Stop in remote runtimes

Before changing anything, determine where the agent executes. Check only
whether these variables exist, never their values:

```sh
for name in SSH_CONNECTION SSH_CLIENT SSH_TTY CODESPACES GITPOD_WORKSPACE_ID CLOUD_SHELL CI; do
  if printenv "$name" >/dev/null 2>&1; then printf '%s is set\n' "$name"; fi
done
```

If any is set, or this is otherwise a hosted/cloud runtime, download, verify,
extract and start nothing. Prefer an installed `metergraph` whose `--help`
lists `setup`; otherwise state that the fallback fetches the preview CLI and
use `npx --yes metergraph-cli@next` as the prefix. Run only:

```sh
metergraph setup --runtime cloud --deployment customer-local --url http://localhost:8080 --workspace 11111111-1111-4111-8111-111111111111 --skip-skill --json
```

Relay its `data.next_action.kind: "run_on_customer_machine"` handoff and tell
the person to run this skill on their own machine. The placeholder workspace is
intentional: the runtime check refuses before making a request or writing a
file. When an SSH, cloud or CI marker is set, even `--runtime local` is refused
with reason `run_on_local_machine` and the same handoff. Valid runtimes are
`local`, `cloud` and `cloud-no-shell`. Never expose localhost to the remote
session.

## Preflight and reuse

Ask for the coding client and bundle version. Default to the newest version at
https://www.metergraph.dev/docs/releases/ and record its `v`-prefixed value.
Record the application repository directory to return to for setup. Run:

```sh
docker info >/dev/null
docker compose version
cosign version
curl -fsS http://localhost:8080/v1/deployment
lsof -nP -iTCP:8080 -sTCP:LISTEN
```

Docker with Compose must be running and `cosign` installed. If the deployment
endpoint returns the `local` profile, reuse that stack and download nothing.
Find its bundle directory using only the Compose working-directory label:

```sh
container_id="$(docker ps --filter publish=8080 --format '{{.ID}}' | head -n 1)"
bundle_dir="$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$container_id")"
(cd "$bundle_dir" && ./bin/status)
```

Do not inspect container environment. Read the workspace ID from the
`workspace` check and skip to **Run setup**. If the directory cannot be found,
ask for the workspace ID from Settings. If nothing listens on 8080, continue.
If anything else owns it, stop and ask; never stop or reconfigure it.

Use `~/metergraph/<version>` and set
`bundle_dir="$HOME/metergraph/$version/local"`. If it contains `.env`, reuse
that existing installation: never overwrite, delete or read the file, and
never extract over `local/`. Continue at **Log in and start**. Otherwise check:

```sh
docker volume inspect local_pgdata >/dev/null 2>&1
```

Because the extracted directory and Compose project are `local`, an existing
volume is `local_pgdata`. If it exists without the matching `local/.env`, stop
and ask for the prior bundle/configuration. Postgres fixed its password when
the volume was created; a new `.env` can cause `password authentication failed`.
Never remove the volume, delete `.env` or use `down --volumes`.

## Download and verify

Require a fresh, empty version directory. Before creating it, tell the person
the directory and four public files that will be written. No account is needed.
Set `version` to the recorded version and run:

```sh
release_dir="$HOME/metergraph/$version"; mkdir -p "$release_dir"; cd "$release_dir"
archive="metergraph-customer-local-$version.tar.gz"
base="https://www.metergraph.dev/releases/$version"
curl -fsSLO "$base/$archive"
curl -fsSLO "$base/metergraph-byoc-release.json"
curl -fsSLO "$base/metergraph-byoc-release.json.sig"
curl -fsSLO "$base/metergraph-byoc-release.json.pem"
```

Do not list, extract or run archive contents. Open the per-version release page
and run its complete `cosign verify-blob` command exactly as published. Its
certificate identity regexp must be anchored at both ends and identify the
published `byoc-release.yml` workflow on `refs/heads/main` or a `v` tag. Refuse
an absent or unanchored identity, `.*`, `--insecure-ignore-tlog` or a similar
bypass. Do not substitute an identity from memory.

If cosign fails, stop: "The manifest signature did not verify. Do not extract
or run this bundle." After it succeeds, check signed fields:

```sh
python3 - "$version" "$archive" <<'EOF'
import json, sys
version, archive = sys.argv[1:]
m = json.load(open("metergraph-byoc-release.json"))
required = ("release", "local_bundle", "local_bundle_sha256",
            "local_image_digest", "local_analysis_image_digest")
missing = [key for key in required if not m.get(key)]
if missing: sys.exit("Signed manifest is missing: " + ", ".join(missing))
if m["release"] != version: sys.exit("Signed manifest release mismatch. Do not run it.")
if m["local_bundle"] != archive: sys.exit("Signed archive name mismatch. Do not run it.")
print("Signed manifest release, archive, and image digests are present.")
EOF
```

Then run this digest check, still before any `tar` command:

```sh
python3 - <<'EOF'
import hashlib, json, sys
manifest = json.load(open("metergraph-byoc-release.json"))
name = manifest["local_bundle"]
actual = hashlib.sha256(open(name, "rb").read()).hexdigest()
if actual != manifest["local_bundle_sha256"]:
    sys.exit(f"{name} does not match the signed manifest. Do not run it.")
print(f"{name} matches the signed manifest.")
EOF
```

Stop on failure. After both checks pass, list and validate archive paths:

```sh
tar -tzf "$archive"
python3 - "$archive" <<'EOF'
from pathlib import PurePosixPath
import sys, tarfile
bad = []
with tarfile.open(sys.argv[1], "r:gz") as bundle:
    for member in bundle.getmembers():
        path = PurePosixPath(member.name)
        if path.is_absolute() or not path.parts or path.parts[0] != "local" or ".." in path.parts:
            bad.append(member.name)
if bad: sys.exit("Unsafe archive paths; do not extract: " + ", ".join(bad[:10]))
print("Every archive entry is beneath local/ with a safe relative path.")
EOF
```

Only now tell the person extraction will create `local/`, then run:

```sh
tar xzf "$archive"
mv metergraph-byoc-release.json* local/
cd local
```

## Configure without exposing passwords

Reuse an existing `.env` unchanged. For a new installation, state that a
mode-0600 file with random admin/database passwords and empty provider keys
will be created. Confirm `local_pgdata` did not exist, then run:

```sh
umask 077; cp .env.example .env; chmod 600 .env
python3 - <<'EOF'
from pathlib import Path
import secrets
path = Path(".env")
keys = ("METERGRAPH_LOCAL_ADMIN_PASSWORD", "METERGRAPH_DB_PASSWORD")
values = {key: secrets.token_urlsafe(24) for key in keys}
lines, found = path.read_text().splitlines(), set()
for i, line in enumerate(lines):
    for key in keys:
        if line.startswith(key + "="):
            lines[i], found = key + "=" + values[key], found | {key}
if found != set(keys): raise SystemExit("Password keys missing from .env.example")
path.write_text("\n".join(lines) + "\n")
print("Set random values for: " + ", ".join(keys))
EOF
```

Do not display, source or parse `.env`. Leave `AI_GATEWAY_API_KEY`,
`FIREWORKS_API_KEY`, `ANTHROPIC_API_KEY`, `OPENAI_API_KEY` and `GOOGLE_API_KEY`
empty.

## Log in and start

Stop for the person to log in to the registry in their own terminal. They use
the pull-only invitation values, never chat or an agent-visible command:

```sh
echo "$METERGRAPH_PULL_TOKEN" | docker login ghcr.io -u "$METERGRAPH_PULL_USER" --password-stdin
```

Wait for confirmation only; never read Docker's credential file. State that
`./bin/start` will re-verify the manifest and both image digests, pull by digest,
start containers, and on a new database send one synthetic demo trace labeled
`environment=local-demo`. Then run:

```sh
./bin/start
./bin/status
```

An image-pull failure usually means login is missing or expired. On other
failure, read only the log named by `./bin/start` and `./bin/status`; never read
rendered Compose configuration or container environment. On password
authentication failure with `local_pgdata`, stop and ask for its matching
`.env`. Never delete data. Read the workspace ID and suggested command from the
status JSON's `workspace` check. The service listens only on localhost:8080.

## Run setup

Return to the application repository. Prefer installed `metergraph` only when
its help lists `setup`; otherwise state that `npx --yes metergraph-cli@next`
fetches the preview CLI and use it as the prefix. Run with `--json`:

```sh
metergraph setup --runtime local --deployment customer-local --url http://localhost:8080 --workspace 11111111-1111-4111-8111-111111111111 --confirm-prerequisites --client <client> --json
```

Replace the example UUID and client only. Setup writes an ingest key to the
application `.env`, installs the skill and requests Metadata access only; never
print that file. Setup opens the deployment's browser consent page and waits;
the person signs in as the local admin and completes two approvals. If the
browser cannot open, follow the `metergraph` skill's guidance for handing the
person the approval URL. Continue until `data.status` is `ok`. For
`operator_handoff`, relay `data.next_action.kind` (`complete_prerequisite`,
`run_on_customer_machine`, `connection_guide`, or other); never report a
handoff as success.

The agent never runs a command that reads `.env`. To see the admin login without
printing it, the person runs these no-output pipelines themselves, one at a
time, in their own terminal or in Claude Code with the `!` prefix. Fill in the
absolute bundle directory for them; their shell does not have `bundle_dir`:

```sh
sed -n 's/^METERGRAPH_LOCAL_ADMIN_EMAIL=//p' ~/metergraph/<version>/local/.env | pbcopy
sed -n 's/^METERGRAPH_LOCAL_ADMIN_PASSWORD=//p' ~/metergraph/<version>/local/.env | pbcopy
```

They may instead use their own editor. Never use `cat`, `grep` or any other
command that prints `.env`, particularly with `!`, because `!` output lands in
the transcript. A new configuration keeps `admin@example.com` as the email.

## Recovery and stopping

| State | Action |
| --- | --- |
| Signature, manifest, digest or path check fails | Stop; extract and run nothing |
| Port 8080 belongs to something else | Stop and ask; do not alter it |
| Registry pull is denied | Person repeats private login; never request the token |
| Existing `.env` | Reuse unchanged; never regenerate passwords |
| `local_pgdata` lacks its matching `.env` | Stop and find prior configuration; never remove it |
| Startup fails | Use status and only the named log; preserve secrets and data |
| Setup returns a handoff | Relay exact status/next action; do not report success |

To stop later, follow the bundle README's `stop`. Prefer it over `down`, which
loses raw payloads in local object storage. Never use `down --volumes`.
