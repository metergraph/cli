// Development/release build only. Package consumers never run a compiler.
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.dirname(fileURLToPath(import.meta.url));
if (process.platform !== "darwin" || process.arch !== "arm64") throw new Error("target has not been verified");
const name = `anchored-fs-${process.platform}-${process.arch}`;
const result = spawnSync("clang", ["-std=c11", "-Wall", "-Wextra", "-Werror", "-O2", path.join(root,"anchored-fs.c"), "-o", path.join(root,"bin",name)], {stdio:"inherit"});
if (result.status !== 0) process.exit(1);
const digest = createHash("sha256").update(fs.readFileSync(path.join(root,"bin",name))).digest("hex");
fs.writeFileSync(path.join(root,"manifest.json"),`${JSON.stringify({schema:1,artifacts:{[name]:digest}},null,2)}\n`);
