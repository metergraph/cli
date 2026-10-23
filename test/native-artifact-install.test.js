import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { TARGETS } from "../native/targets.mjs";

const source = fileURLToPath(new URL("../native/", import.meta.url));
const revision = "1".repeat(40);
const hash = bytes => createHash("sha256").update(bytes).digest("hex");

test("CI installation verifies the host before replacing checkout artifacts", { skip: process.platform === "win32" }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "native-artifact-install-"));
  try {
    const checkout = path.join(root, "native");
    fs.cpSync(source, checkout, { recursive: true });
    const bin = path.join(checkout, "bin");
    const before = new Map(fs.readdirSync(bin).map(name => [name, fs.readFileSync(path.join(bin, name))]));
    const artifact = path.join(root, "artifact");
    fs.mkdirSync(path.join(artifact, "bin"), { recursive: true });
    const current = `${process.platform}-${process.arch}`;
    const foreign = TARGETS.find(value => value !== current);
    const bytes = Buffer.from("synthetic-artifact-bytes");
    function write(target) {
      for (const name of fs.readdirSync(path.join(artifact, "bin"))) fs.unlinkSync(path.join(artifact, "bin", name));
      const name = `anchored-fs-${target}`;
      fs.writeFileSync(path.join(artifact, "bin", name), bytes);
      fs.writeFileSync(path.join(artifact, "manifest.json"), JSON.stringify({ schema: 1, artifacts: { [name]: hash(bytes) } }));
      fs.writeFileSync(path.join(artifact, "provenance.json"), JSON.stringify({ schema: 1, source_revision: revision,
        source_sha256: hash(fs.readFileSync(path.join(checkout, "anchored-fs.c"))), target, binary_sha256: hash(bytes) }));
    }
    const run = () => spawnSync(process.execPath, [path.join(checkout, "install-artifact.mjs"), "--input", artifact, "--revision", revision], { encoding: "utf8" });
    write(foreign);
    assert.notEqual(run().status, 0);
    assert.deepEqual(fs.readdirSync(bin).sort(), [...before.keys()].sort());
    for (const [name, original] of before) assert.deepEqual(fs.readFileSync(path.join(bin, name)), original);
    write(current);
    const accepted = run();
    assert.equal(accepted.status, 0, accepted.stderr);
    const name = `anchored-fs-${current}`;
    assert.deepEqual(fs.readdirSync(bin), [name]);
    assert.deepEqual(fs.readFileSync(path.join(bin, name)), bytes);
    assert.equal(fs.statSync(path.join(bin, name)).mode & 0o777, 0o755);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
