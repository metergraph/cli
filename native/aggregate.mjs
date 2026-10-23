// Assemble already tested CI artifacts; this tool never builds or downloads.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { TARGETS, DIGEST, REVISION, binaryFor, exactKeys, argumentsFor } from "./targets.mjs";
const root=path.dirname(fileURLToPath(import.meta.url));
const sha256=bytes=>createHash("sha256").update(bytes).digest("hex");
function stat(file,kind) {const value=fs.lstatSync(file);if(value.isSymbolicLink() || !(kind==="directory"?value.isDirectory():value.isFile()) || (kind!=="directory" && value.nlink!==1)) throw new Error("unsafe artifact entry");return value;}
function listing(dir,expected) {stat(dir,"directory");const names=fs.readdirSync(dir).sort();if(names.join("\0")!==[...expected].sort().join("\0"))throw new Error("unexpected artifact files");}
function json(file) {
  stat(file,"file");const text=fs.readFileSync(file,"utf8");const value=JSON.parse(text);
  // JSON.parse silently accepts repeated object keys. Reject them before
  // trusting an artifact manifest or provenance record.
  const frames=[];
  for(const token of text.match(/"(?:[^"\\]|\\.)*"|[{}\[\],:]/gs) ?? []) {
    if(token==="{")frames.push({object:true,keys:new Set(),key:true});
    else if(token==="[")frames.push({object:false});
    else if(token==="}" || token==="]")frames.pop();
    else if(token==="," && frames.at(-1)?.object)frames.at(-1).key=true;
    else if(token.startsWith('"') && frames.at(-1)?.object && frames.at(-1).key) {
      const frame=frames.at(-1),key=JSON.parse(token);
      if(frame.keys.has(key))throw new Error("duplicate artifact metadata key");
      frame.keys.add(key);frame.key=false;
    }
  }
  return value;
}
export function readArtifact(directory,{revision,sourceSha256}) {
  if(!REVISION.test(revision) || !DIGEST.test(sourceSha256))throw new Error("invalid artifact source identity");
    const dir=path.resolve(directory);listing(dir,["bin","manifest.json","provenance.json"]);
    const provenance=json(path.join(dir,"provenance.json"));
    if(!exactKeys(provenance,["schema","source_revision","source_sha256","target","binary_sha256"]) || provenance.schema!==1 || !TARGETS.includes(provenance.target))throw new Error("invalid artifact provenance");
    const {target}=provenance;const name=binaryFor(target);
    if(provenance.source_revision!==revision || provenance.source_sha256!==sourceSha256 || !DIGEST.test(provenance.binary_sha256))throw new Error("artifact source identity mismatch");
    listing(path.join(dir,"bin"),[name]);const file=path.join(dir,"bin",name);stat(file,"file");
    const bytes=fs.readFileSync(file);const digest=sha256(bytes);
    const manifest=json(path.join(dir,"manifest.json"));
    if(!exactKeys(manifest,["schema","artifacts"]) || manifest.schema!==1 || !exactKeys(manifest.artifacts,[name]) || manifest.artifacts[name]!==digest || provenance.binary_sha256!==digest)throw new Error("artifact digest mismatch");
    return {target,name,binary:bytes,manifest,provenance,digest};
}
export function aggregate({input,revision,output}) {
  if(!REVISION.test(revision))throw new Error("invalid reviewed revision");
  input=path.resolve(input);output=path.resolve(output);stat(input,"directory");
  const source=sha256(fs.readFileSync(path.join(root,"anchored-fs.c")));
  const artifacts=new Map();const folders=fs.readdirSync(input);
  if(folders.length!==TARGETS.length)throw new Error("missing or duplicate native targets");
  for(const folder of folders) {
    const artifact=readArtifact(path.join(input,folder),{revision,sourceSha256:source});
    if(artifacts.has(artifact.target))throw new Error("duplicate native target");
    artifacts.set(artifact.target,{name:artifact.name,bytes:artifact.binary,digest:artifact.digest});
  }
  if(TARGETS.some(target=>!artifacts.has(target)))throw new Error("missing native target");
  // Validate every input before writing any assembled output.
  if(fs.existsSync(output)) {stat(output,"directory");if(fs.readdirSync(output).length)throw new Error("assembly output must be empty");}
  else fs.mkdirSync(output,{recursive:true});
  fs.mkdirSync(path.join(output,"bin"));const manifest={schema:1,artifacts:{}};
  for(const target of TARGETS) {const {name,bytes,digest}=artifacts.get(target);fs.writeFileSync(path.join(output,"bin",name),bytes,{flag:"wx",mode:0o755});fs.chmodSync(path.join(output,"bin",name),0o755);manifest.artifacts[name]=digest;}
  fs.writeFileSync(path.join(output,"manifest.json"),`${JSON.stringify(manifest,null,2)}\n`,{flag:"wx"});
  fs.writeFileSync(path.join(output,"provenance.json"),`${JSON.stringify({schema:1,source_revision:revision,source_sha256:source,targets:[...TARGETS]},null,2)}\n`,{flag:"wx"});
  return manifest;
}
if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  try {const args=argumentsFor(process.argv.slice(2),["--input","--revision","--output"]);aggregate({input:args["--input"],revision:args["--revision"],output:args["--output"]});}
  catch(error) {process.stderr.write(`${error.message}\n`);process.exitCode=1;}
}
