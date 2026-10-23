// CI-only: install one artifact from this workflow's reviewed source revision
// into an ephemeral checkout for source and packed-package execution tests.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { readArtifact } from "./aggregate.mjs";
import { argumentsFor } from "./targets.mjs";

const root = path.dirname(fileURLToPath(import.meta.url));
const args = argumentsFor(process.argv.slice(2), ["--input", "--revision"]);
const sourceSha256 = createHash("sha256").update(fs.readFileSync(path.join(root, "anchored-fs.c"))).digest("hex");
const artifact = readArtifact(args["--input"], { revision: args["--revision"], sourceSha256 });
if (artifact.target !== `${process.platform}-${process.arch}`) throw new Error("artifact does not match the execution host");
// Validation precedes mutation. Retain only the selected target in this
// disposable checkout so package allowlist checks see exactly these bytes.
fs.rmSync(path.join(root, "bin"), { recursive: true, force: true });
fs.mkdirSync(path.join(root, "bin"));
fs.writeFileSync(path.join(root, "bin", artifact.name), artifact.binary, { flag: "wx", mode: 0o755 });
fs.chmodSync(path.join(root, "bin", artifact.name), 0o755);
fs.writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(artifact.manifest, null, 2)}\n`);
