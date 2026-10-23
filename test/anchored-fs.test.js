import assert from "node:assert/strict";
import { test, afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import anchored, { validatePath, withRollback, closeAnchoredFs } from "../src/anchored-fs.js";
const supported = process.platform === "darwin" && process.arch === "arm64";
const roots = [];
afterEach(() => { closeAnchoredFs(); for (const root of roots.splice(0)) fs.rmSync(root,{recursive:true,force:true}); });
function fixture() { const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(),"anchored-fs-test-"))); roots.push(root); return root; }
function create(file, content) { const fd=anchored.openSync(file,"wx",0o600); try {anchored.writeFileSync(fd,content);anchored.fsyncSync(fd);} finally {anchored.closeSync(fd);} }
test("prebuilt helper reads, replaces, syncs and cleans without a runtime compiler", {skip:!supported}, () => {
  const root=fixture(); anchored.realpathSync(root);
  const dir=path.join(root,"nested");anchored.mkdirSync(dir,{mode:0o700});
  const file=path.join(dir,"file"),temp=path.join(dir,"temp");create(file,"before");
  assert.equal(anchored.readFileSync(file,"utf8"),"before");create(temp,"after");anchored.renameSync(temp,file);
  assert.equal(anchored.readFileSync(file,"utf8"),"after");assert.equal(anchored.statSync(file).mode&0o777,0o600);
  const fd=anchored.openSync(dir,"r");anchored.fsyncSync(fd);anchored.closeSync(fd);
  anchored.unlinkSync(file);anchored.rmdirSync(dir);
  anchored.mkdirSync(dir);create(path.join(dir,"new"),"new");
});
test("substituted parent fails closed and rollback stays on retained directory", {skip:!supported}, () => {
  const root=fixture(),outside=fixture(),dir=path.join(root,"target"),old=path.join(root,"old");fs.mkdirSync(dir);
  anchored.realpathSync(root);const file=path.join(dir,"secret");create(file,"synthetic-token");
  fs.renameSync(dir,old);fs.symlinkSync(outside,dir);
  assert.throws(()=>validatePath(dir),{code:"ESTALE"});
  assert.throws(()=>create(path.join(dir,"later"),"synthetic-token"),{code:"ESTALE"});
  withRollback(()=>anchored.unlinkSync(file));
  assert.deepEqual(fs.readdirSync(outside),[]);assert.deepEqual(fs.readdirSync(old),[]);
});
test("cleanup refuses an attacker-substituted leaf", {skip:!supported}, () => {
  const root=fixture(),file=path.join(root,"lock");anchored.realpathSync(root);create(file,"");
  fs.renameSync(file,path.join(root,"original"));fs.writeFileSync(file,"keep");
  anchored.lstatSync(file); // Observation must not adopt the substituted identity.
  assert.throws(()=>withRollback(()=>anchored.unlinkSync(file)),{code:"ESTALE"});
  assert.equal(fs.readFileSync(file,"utf8"),"keep");
});
test("symlink parents and hardlinked files are refused", {skip:!supported}, () => {
  const root=fixture(),outside=fixture();anchored.realpathSync(root);fs.symlinkSync(outside,path.join(root,"link"));
  assert.throws(()=>create(path.join(root,"link","file"),"synthetic-token"));
  const file=path.join(root,"hard");fs.writeFileSync(file,"keep");fs.linkSync(file,path.join(outside,"alias"));
  assert.throws(()=>anchored.openSync(file,"r+"),{code:"ELOOP"});
  assert.equal(fs.readFileSync(path.join(outside,"alias"),"utf8"),"keep");
});
test("exclusive hardlink promotion retains create-if-absent semantics", {skip:!supported}, () => {
  const root=fixture();anchored.realpathSync(root);const temp=path.join(root,"temp"),dest=path.join(root,"dest");create(temp,"identity");
  anchored.linkSync(temp,dest);anchored.unlinkSync(temp);
  assert.equal(anchored.readFileSync(dest,"utf8"),"identity");
});

test("nonregular reads cannot block the helper on a FIFO", {skip:!supported}, async () => {
  const {spawnSync}=await import("node:child_process");const root=fixture();anchored.realpathSync(root);
  const file=path.join(root,"fifo");assert.equal(spawnSync("mkfifo",[file]).status,0);
  assert.throws(()=>anchored.openSync(file,fs.constants.O_RDONLY|fs.constants.O_NONBLOCK),{code:"ELOOP"});
});

test("resolving a pinned root again cannot rebind it through a substituted symlink", {skip:!supported}, () => {
  const parent=fixture(),outside=fixture(),root=path.join(parent,"project");fs.mkdirSync(root);anchored.realpathSync(root);
  fs.renameSync(root,path.join(parent,"original"));fs.symlinkSync(outside,root);
  assert.throws(()=>anchored.realpathSync(root),{code:"ESTALE"});
  assert.throws(()=>create(path.join(root,"file"),"synthetic-token"),{code:"ESTALE"});
  assert.deepEqual(fs.readdirSync(outside),[]);
});

test("helper survives deferred terminal signals and exits when owner pipe closes", {skip:!supported, timeout:5000}, async () => {
  const {spawn}=await import("node:child_process");
  const {once}=await import("node:events");
  const child=spawn(new URL("../native/bin/anchored-fs-darwin-arm64",import.meta.url).pathname,[],{stdio:["pipe","pipe","ignore"]});
  const frame=Buffer.alloc(11);frame.writeUInt32BE(7);frame[4]=1;frame[5]=1;frame.writeUInt32BE(1,6);frame[10]=47;
  async function query() {
    const answer=new Promise((resolve,reject)=>{
      const pieces=[];let size=0;
      function data(bytes) {pieces.push(bytes);size+=bytes.length;if(size>=72){child.stdout.off("data",data);resolve(Buffer.concat(pieces));}}
      child.stdout.on("data",data);child.once("error",reject);
    });
    child.stdin.write(frame);const reply=await answer;assert.equal(reply.readUInt32BE(),0);assert.equal(reply.readUInt32BE(4),64);
  }
  try {
    await query();
    for(const signal of ["SIGINT","SIGTERM","SIGHUP"]) {child.kill(signal);await query();}
    const exited=once(child,"exit");child.stdin.end();assert.deepEqual(await exited,[0,null]);
  } finally {if(child.exitCode===null)child.kill("SIGKILL");}
});

test("fresh observation permits replacement of a final file updated by another process", {skip:!supported}, async () => {
  const {spawnSync}=await import("node:child_process");
  const root=fixture(),dest=path.join(root,"grant"),temp=path.join(root,"first");anchored.realpathSync(root);
  create(temp,"initial");anchored.renameSync(temp,dest);assert.equal(anchored.readFileSync(dest,"utf8"),"initial");
  const adapter=new URL("../src/anchored-fs.js",import.meta.url).href;
  const script=`import f,{closeAnchoredFs} from ${JSON.stringify(adapter)};const d=${JSON.stringify(dest)},t=${JSON.stringify(path.join(root,"other"))};f.lstatSync(d);const fd=f.openSync(t,"wx",384);f.writeFileSync(fd,"refreshed");f.closeSync(fd);f.renameSync(t,d);closeAnchoredFs();`;
  const child=spawnSync(process.execPath,["--input-type=module","-e",script],{encoding:"utf8"});assert.equal(child.status,0,child.stderr);
  anchored.lstatSync(dest);assert.equal(anchored.readFileSync(dest,"utf8"),"refreshed");
  const next=path.join(root,"next");create(next,"latest");anchored.renameSync(next,dest);
  assert.equal(anchored.readFileSync(dest,"utf8"),"latest");
});

test("directory lstat pins identity before an ordinary-directory substitution", {skip:!supported}, () => {
  const root=fixture(),outside=fixture(),dir=path.join(root,"credentials"),held=path.join(root,"held");
  fs.mkdirSync(dir);anchored.lstatSync(dir);
  fs.renameSync(dir,held);fs.renameSync(outside,dir);
  assert.throws(()=>create(path.join(dir,"grant"),"synthetic-token"),{code:"ESTALE"});
  assert.deepEqual(fs.readdirSync(dir),[]);assert.deepEqual(fs.readdirSync(held),[]);
});

test("openStore pins credentials before its first credential write", {skip:!supported}, async () => {
  const {openStore,writeCredential,newSlot}=await import("../src/auth-store.js");
  const root=fixture(),outside=fixture(),config=path.join(root,"config");
  const store=openStore(config,{create:true});const held=path.join(root,"held");
  fs.renameSync(store.credentials,held);fs.renameSync(outside,store.credentials);
  const record={schema_version:1,origin:"http://127.0.0.1:4000",issuer:"http://127.0.0.1:4000/v1/oauth",resource:"http://127.0.0.1:4000/v1/agent/mcp",deployment_profile:"local",workspace_id:"00000000-0000-0000-0000-000000000001",client_id:"synthetic-client",scope:"agent:metadata",access_token:"synthetic-access",refresh_token:"synthetic-refresh",expires_at:Date.now()+1000,refresh_pending:false};
  assert.throws(()=>writeCredential(store,newSlot(),record),error=>error.reason==="credential_write_failed");
  assert.deepEqual(fs.readdirSync(store.credentials),[]);assert.deepEqual(fs.readdirSync(held),[]);
});

test("skill install preserves writable searchable project support without directory read permission", {skip:!supported || process.getuid?.()===0}, async () => {
  const {runSkill}=await import("../src/skill.js");const root=fixture();fs.chmodSync(root,0o333);
  try {
    const result=runSkill({action:"install",client:"codex",runtime:"local",project:root});
    assert.equal(result.outcome,"ok",JSON.stringify(result));
    assert.equal(anchored.readFileSync(path.join(root,".agents","skills","metergraph","SKILL.md"),"utf8").includes("Metergraph"),true);
  } finally {fs.chmodSync(root,0o700);}
});
