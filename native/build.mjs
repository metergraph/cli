// Development/release build only. Package consumers never run a compiler.
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { TARGETS, DIGEST, REVISION, binaryFor, exactKeys, argumentsFor } from "./targets.mjs";
const root = path.dirname(fileURLToPath(import.meta.url));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
function directory(dir) {
  fs.mkdirSync(dir, {recursive:true});
  if (!fs.lstatSync(dir).isDirectory() || fs.lstatSync(dir).isSymbolicLink()) throw new Error("unsafe build output");
}
export function build({output, revision, target = `${process.platform}-${process.arch}`} = {}) {
  if (!TARGETS.includes(target) || target !== `${process.platform}-${process.arch}`) throw new Error("unsupported build host");
  if (revision === undefined) {
    revision = process.env.GITHUB_SHA;
    if (revision === undefined) {
      const git = spawnSync("git", ["rev-parse", "HEAD"], {cwd:root, encoding:"utf8"});
      if (git.status !== 0) throw new Error("source revision unavailable");
      revision = git.stdout.trim();
    }
  }
  if (!REVISION.test(revision)) throw new Error("invalid source revision");
  const provenanceOutput = output !== undefined;
  output = path.resolve(output ?? root); directory(output); directory(path.join(output,"bin"));
  const manifestPath = path.join(output,"manifest.json");
  let artifacts = {};
  if (fs.existsSync(manifestPath)) {
    if (!fs.lstatSync(manifestPath).isFile() || fs.lstatSync(manifestPath).isSymbolicLink()) throw new Error("unsafe build manifest");
    const previous = JSON.parse(fs.readFileSync(manifestPath,"utf8"));
    if (!exactKeys(previous,["schema","artifacts"]) || previous.schema !== 1 || !exactKeys(previous.artifacts,Object.keys(previous.artifacts ?? {}))) throw new Error("invalid build manifest");
    for (const [name,digest] of Object.entries(previous.artifacts)) {
      if (!TARGETS.some(value=>binaryFor(value)===name) || !DIGEST.test(digest)) throw new Error("unknown build artifact");
      const file=path.join(output,"bin",name);const stat=fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || sha256(fs.readFileSync(file)) !== digest) throw new Error("existing artifact integrity failed");
      artifacts[name]=digest;
    }
  }
  const name = binaryFor(target); const temporary = path.join(output,"bin",`.build-${randomBytes(12).toString("hex")}`);
  try {
    const result = spawnSync("clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", path.join(root,"anchored-fs.c"), "-o",temporary], {stdio:"inherit"});
    if (result.status !== 0) throw new Error("native compilation failed");
    fs.chmodSync(temporary,0o755);
    const digest = sha256(fs.readFileSync(temporary)); fs.renameSync(temporary,path.join(output,"bin",name)); artifacts[name]=digest;
    const ordered = Object.fromEntries(Object.entries(artifacts).sort(([a],[b])=>a.localeCompare(b)));
    fs.writeFileSync(manifestPath,`${JSON.stringify({schema:1,artifacts:ordered},null,2)}\n`);
    if (provenanceOutput) fs.writeFileSync(path.join(output,"provenance.json"),`${JSON.stringify({schema:1,source_revision:revision,source_sha256:sha256(fs.readFileSync(path.join(root,"anchored-fs.c"))),target,binary_sha256:digest},null,2)}\n`);
    return {target,digest};
  } finally {try {fs.unlinkSync(temporary);} catch(error) {if(error.code!=="ENOENT")throw error;} }
}
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {const args=argumentsFor(process.argv.slice(2),[],["--output","--revision"]);build({output:args["--output"],revision:args["--revision"]});}
  catch(error) {process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
