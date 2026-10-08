#!/usr/bin/env node
// Keeps the bundled setup skill identical to skills/metergraph/SKILL.md in the
// public skills repository at the commit pinned in skills-source.json.
//
//   node scripts/sync-skill.mjs --from ../skills [--commit SHA]
//     Copy the skill from a local checkout of the skills repository, at HEAD
//     or the given commit, into the npm and Python bundles, and update every
//     pinned hash and revision.
//   node scripts/sync-skill.mjs --check
//     Download the pinned file and fail if either bundle differs. CI runs this.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("..", import.meta.url);
const SOURCE_FILE = new URL("skills-source.json", root);
const COPIES = [
  { skill: "assets/skill/SKILL.md", manifest: "assets/skill/manifest.json" },
  {
    skill: "python/metergraph-skills/src/metergraph_skills/skill/SKILL.md",
    manifest: "python/metergraph-skills/src/metergraph_skills/skill/manifest.json",
  },
];
// Files that pin the hash or revision as a literal, so a stale pin fails fast.
const PINS = [
  "src/skill-bundle.js",
  "python/metergraph-skills/src/metergraph_skills/bundle.py",
  "test/skill.test.js",
  "test/package/pack.test.js",
  "python/metergraph-skills/tests/test_installer.py",
  "docs/reference.md",
];

const sha256 = (content) => createHash("sha256").update(content).digest("hex");
const revision = (hash) => `sha256-${hash.slice(0, 12)}`;
const read = (path) => readFileSync(new URL(path, root));

function fail(message) {
  console.error(message);
  process.exit(1);
}

function checkLocal(expected) {
  const problems = [];
  for (const { skill, manifest } of COPIES) {
    const content = read(skill);
    if (!content.equals(expected)) problems.push(`${skill} differs from the pinned source`);
    const parsed = JSON.parse(read(manifest));
    if (parsed.sha256 !== sha256(content) || parsed.size !== content.length || parsed.revision !== revision(parsed.sha256)) {
      problems.push(`${manifest} does not describe ${skill}`);
    }
  }
  const hash = sha256(expected);
  for (const path of PINS) {
    if (!read(path).toString("utf8").includes(hash)) problems.push(`${path} does not pin ${hash}`);
  }
  return problems;
}

const args = process.argv.slice(2);
const source = JSON.parse(readFileSync(SOURCE_FILE, "utf8"));

if (args[0] === "--check") {
  const url = `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.path}`;
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) fail(`Could not download ${url}: HTTP ${response.status}`);
  const expected = Buffer.from(await response.arrayBuffer());
  const problems = checkLocal(expected);
  if (problems.length) fail(`Bundled skill drifted from ${source.repository}@${source.commit}:\n- ${problems.join("\n- ")}\nRun scripts/sync-skill.mjs --from <skills checkout>.`);
  console.log(`Bundled skill matches ${source.repository}@${source.commit.slice(0, 12)} (${sha256(expected).slice(0, 12)}).`);
} else if (args[0] === "--from" && args[1]) {
  const checkout = args[1];
  const commitArg = args[2] === "--commit" ? args[3] : "HEAD";
  const git = (...rest) => execFileSync("git", ["-C", checkout, ...rest]);
  const commit = git("rev-parse", "--verify", `${commitArg}^{commit}`).toString().trim();
  const content = git("show", `${commit}:${source.path}`);
  const { sha256: oldHash, size: oldSize } = JSON.parse(read(COPIES[0].manifest));
  const hash = sha256(content);
  for (const { skill, manifest } of COPIES) {
    writeFileSync(new URL(skill, root), content);
    const parsed = JSON.parse(read(manifest));
    Object.assign(parsed, { sha256: hash, size: content.length, revision: revision(hash) });
    writeFileSync(new URL(manifest, root), `${JSON.stringify(parsed, null, 2)}\n`);
  }
  for (const path of PINS) {
    // Tests also pin the byte size, as `length, N)` and `size: N`.
    const text = read(path).toString("utf8").replaceAll(oldHash, hash).replaceAll(revision(oldHash), revision(hash))
      .replaceAll(`length, ${oldSize})`, `length, ${content.length})`).replaceAll(`size: ${oldSize},`, `size: ${content.length},`);
    writeFileSync(new URL(path, root), text);
  }
  writeFileSync(SOURCE_FILE, `${JSON.stringify({ ...source, commit }, null, 2)}\n`);
  const problems = checkLocal(content);
  if (problems.length) fail(`Sync incomplete:\n- ${problems.join("\n- ")}`);
  console.log(`Synced ${source.path} at ${commit.slice(0, 12)} (${hash.slice(0, 12)}${hash === oldHash ? ", unchanged" : `, was ${oldHash.slice(0, 12)}`}).`);
} else {
  fail("Usage: node scripts/sync-skill.mjs --from <skills checkout> [--commit SHA] | --check");
}
