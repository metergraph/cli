import assert from "node:assert/strict";
import {afterEach,test} from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {createHash} from "node:crypto";
import {aggregate} from "../native/aggregate.mjs";
import {build} from "../native/build.mjs";
import {TARGETS,binaryFor} from "../native/targets.mjs";
const roots=[];const revision="a".repeat(40);
const source=createHash("sha256").update(fs.readFileSync(new URL("../native/anchored-fs.c",import.meta.url))).digest("hex");
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});
function fixture(){const root=fs.mkdtempSync(path.join(os.tmpdir(),"native-build-artifacts-"));roots.push(root);const input=path.join(root,"input"),output=path.join(root,"output");fs.mkdirSync(input);for(const target of [...TARGETS].reverse())artifact(input,target);return{root,input,output};}
function artifact(input,target,folder=target){const dir=path.join(input,folder),bin=path.join(dir,"bin"),name=binaryFor(target),bytes=Buffer.from(`synthetic ${target}`);fs.mkdirSync(bin,{recursive:true});fs.writeFileSync(path.join(bin,name),bytes,{mode:0o644});fs.writeFileSync(path.join(dir,"manifest.json"),JSON.stringify({schema:1,artifacts:{[name]:digest(bytes)}}));fs.writeFileSync(path.join(dir,"provenance.json"),JSON.stringify({schema:1,source_revision:revision,source_sha256:source,target,binary_sha256:digest(bytes)}));return dir;}
function edit(file,callback){const value=JSON.parse(fs.readFileSync(file));callback(value);fs.writeFileSync(file,JSON.stringify(value));}
function run(value){return aggregate({...value,revision});}
test("assembly emits exact target list, deterministic manifest and executable binaries",()=>{const f=fixture();const result=run(f);assert.deepEqual(Object.keys(result.artifacts),TARGETS.map(binaryFor));assert.deepEqual(fs.readdirSync(path.join(f.output,"bin")).sort(),TARGETS.map(binaryFor).sort());for(const name of TARGETS.map(binaryFor)){assert.equal(fs.statSync(path.join(f.output,"bin",name)).mode&0o777,0o755);assert.equal(digest(fs.readFileSync(path.join(f.output,"bin",name))),result.artifacts[name]);}const other=path.join(f.root,"other");aggregate({input:f.input,revision,output:other});assert.equal(fs.readFileSync(path.join(other,"manifest.json"),"utf8"),fs.readFileSync(path.join(f.output,"manifest.json"),"utf8"));});
for(const [label,mutate] of [
  ["missing",f=>fs.rmSync(path.join(f.input,TARGETS[0]),{recursive:true})],
  ["unknown",f=>edit(path.join(f.input,TARGETS[0],"provenance.json"),p=>{p.target="windows-x64";})],
  ["duplicate",f=>{fs.rmSync(path.join(f.input,TARGETS[0]),{recursive:true});artifact(f.input,TARGETS[1],"duplicate");}],
  ["source",f=>edit(path.join(f.input,TARGETS[0],"provenance.json"),p=>{p.source_sha256="b".repeat(64);})],
  ["revision",f=>edit(path.join(f.input,TARGETS[0],"provenance.json"),p=>{p.source_revision="b".repeat(40);})],
  ["provenance digest",f=>edit(path.join(f.input,TARGETS[0],"provenance.json"),p=>{p.binary_sha256="b".repeat(64);})],
  ["manifest digest",f=>edit(path.join(f.input,TARGETS[0],"manifest.json"),p=>{p.artifacts[binaryFor(TARGETS[0])]="b".repeat(64);})],
  ["duplicate metadata key",f=>{const file=path.join(f.input,TARGETS[0],"provenance.json");const text=fs.readFileSync(file,"utf8");fs.writeFileSync(file,text.replace('"schema":1','"schema":1,"schema":1'));}],
  ["duplicate manifest key",f=>{const file=path.join(f.input,TARGETS[0],"manifest.json");const text=fs.readFileSync(file,"utf8");fs.writeFileSync(file,text.replace('"schema":1','"schema":1,"schema":1'));}],
  ["duplicate binary key",f=>{const file=path.join(f.input,TARGETS[0],"manifest.json");const text=fs.readFileSync(file,"utf8"),name=binaryFor(TARGETS[0]);const value=JSON.parse(text).artifacts[name];fs.writeFileSync(file,text.replace(JSON.stringify(name)+":"+JSON.stringify(value),JSON.stringify(name)+":"+JSON.stringify(value)+","+JSON.stringify(name)+":"+JSON.stringify(value)));}],
  ["unexpected file",f=>fs.writeFileSync(path.join(f.input,TARGETS[0],"extra"),"unexpected")],
  ["unexpected binary",f=>fs.writeFileSync(path.join(f.input,TARGETS[0],"bin","extra"),"unexpected")],
  ["symlink artifact",f=>{const dir=path.join(f.input,TARGETS[0]);fs.renameSync(dir,path.join(f.root,"held"));fs.symlinkSync(path.join(f.root,"held"),dir);}],
  ["symlink binary",f=>{const file=path.join(f.input,TARGETS[0],"bin",binaryFor(TARGETS[0]));fs.renameSync(file,path.join(f.root,"held"));fs.symlinkSync(path.join(f.root,"held"),file);}],
  ["symlink metadata",f=>{const file=path.join(f.input,TARGETS[0],"manifest.json");fs.renameSync(file,path.join(f.root,"held"));fs.symlinkSync(path.join(f.root,"held"),file);}],
])test(`assembly refuses ${label} before output`,()=>{const f=fixture();mutate(f);assert.throws(()=>run(f));assert.equal(fs.existsSync(f.output),false);});
test("build refuses unsupported host targets and invalid revisions",()=>{const f=fixture();assert.throws(()=>build({output:f.output,revision,target:"win32-x64"}));assert.throws(()=>build({output:f.output,revision:"invalid"}));});
test("local development build preserves other target artifacts and emits isolated provenance",{skip:!TARGETS.includes(`${process.platform}-${process.arch}`)},()=>{const f=fixture();const output=path.join(f.root,"build");fs.mkdirSync(path.join(output,"bin"),{recursive:true});const other=TARGETS.find(t=>t!==`${process.platform}-${process.arch}`),name=binaryFor(other),bytes=Buffer.from("previous independently verified synthetic artifact");fs.writeFileSync(path.join(output,"bin",name),bytes);fs.writeFileSync(path.join(output,"manifest.json"),JSON.stringify({schema:1,artifacts:{[name]:digest(bytes)}}));const result=build({output,revision});const manifest=JSON.parse(fs.readFileSync(path.join(output,"manifest.json")));assert.equal(manifest.artifacts[name],digest(bytes));assert.equal(manifest.artifacts[binaryFor(result.target)],result.digest);const provenance=JSON.parse(fs.readFileSync(path.join(output,"provenance.json")));assert.deepEqual(provenance,{schema:1,source_revision:revision,source_sha256:source,target:result.target,binary_sha256:result.digest});});
