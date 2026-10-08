#!/usr/bin/env node
// Keeps the bundled skills identical to the public skills repository at the
// commit pinned in skills-source.json: skills/metergraph/SKILL.md is the setup
// skill that "skill install" writes, and every other skills/<name>/SKILL.md is
// the pack that "skills install" writes, vendored in assets/skills/.
//
//   node scripts/sync-skill.mjs --from ../skills [--commit SHA]
//     Copy the skills from a local checkout of the skills repository, at HEAD
//     or the given commit, into the npm and Python bundles, and update every
//     pinned hash and revision.
//   node scripts/sync-skill.mjs --check
//     Download the pinned files and fail if any bundle differs. CI runs this.
//   node scripts/sync-skill.mjs --check-release
//     --check, and also fail unless the skill served at www.metergraph.dev is
//     the same file, so a release never ships a skill the website does not.
//     Both release workflows run this.
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";

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

const PACK_DIR = "assets/skills";
const PACK_MANIFEST = `${PACK_DIR}/manifest.json`;
const PACK_PIN = "src/skill-bundle.js";
const PACK_PIN_PATTERN = /const PINNED_PACK_SHA256 = "([0-9a-f]{64})";/;

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

// The pack manifest's bytes, built the same way every time so its hash can
// be pinned in code.
function packManifest(repository, commit, skills) {
  const entries = skills
    .map(({ name, content }) => {
      const hash = sha256(content);
      return { name, sha256: hash, size: content.length, revision: revision(hash) };
    })
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return Buffer.from(`${JSON.stringify({ manifest_version: 1, repository, commit, skills: entries }, null, 2)}\n`);
}

function checkPack(source, skills) {
  const problems = [];
  const expected = packManifest(source.repository, source.commit, skills);
  const actual = read(PACK_MANIFEST);
  if (!actual.equals(expected)) problems.push(`${PACK_MANIFEST} does not describe the pinned pack`);
  const pinned = PACK_PIN_PATTERN.exec(read(PACK_PIN).toString("utf8"))?.[1];
  if (pinned !== sha256(actual)) problems.push(`${PACK_PIN} does not pin the pack manifest`);
  const bundled = readdirSync(new URL(`${PACK_DIR}/`, root), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .sort();
  const names = skills.map(({ name }) => name).sort();
  if (bundled.join() !== names.join()) problems.push(`${PACK_DIR} holds ${bundled.join(", ")}, expected ${names.join(", ")}`);
  for (const { name, content } of skills) {
    let local = null;
    try {
      local = read(`${PACK_DIR}/${name}/SKILL.md`);
    } catch {
      // Reported below.
    }
    if (local === null || !local.equals(content)) problems.push(`${PACK_DIR}/${name}/SKILL.md differs from the pinned source`);
  }
  return problems;
}

const args = process.argv.slice(2);
const source = JSON.parse(readFileSync(SOURCE_FILE, "utf8"));

if (args[0] === "--check" || args[0] === "--check-release") {
  const url = `https://raw.githubusercontent.com/${source.repository}/${source.commit}/${source.path}`;
  const response = await fetch(url, { redirect: "error" });
  if (!response.ok) fail(`Could not download ${url}: HTTP ${response.status}`);
  const expected = Buffer.from(await response.arrayBuffer());
  const problems = checkLocal(expected);
  // The pack is listed from the bundled manifest, so a skill added upstream
  // after the pin is not expected; a skill dropped from the bundle is caught
  // by the directory comparison in checkPack.
  const listed = JSON.parse(read(PACK_MANIFEST)).skills.map(({ name }) => name);
  const pack = [];
  for (const name of listed) {
    const packUrl = `https://raw.githubusercontent.com/${source.repository}/${source.commit}/skills/${name}/SKILL.md`;
    const packResponse = await fetch(packUrl, { redirect: "error" });
    if (!packResponse.ok) fail(`Could not download ${packUrl}: HTTP ${packResponse.status}`);
    pack.push({ name, content: Buffer.from(await packResponse.arrayBuffer()) });
  }
  problems.push(...checkPack(source, pack));
  if (problems.length) fail(`Bundled skill drifted from ${source.repository}@${source.commit}:\n- ${problems.join("\n- ")}\nRun scripts/sync-skill.mjs --from <skills checkout>.`);
  console.log(`Bundled skills match ${source.repository}@${source.commit.slice(0, 12)} (setup ${sha256(expected).slice(0, 12)}, ${pack.length} pack skills).`);
  if (args[0] === "--check-release") {
    const site = "https://www.metergraph.dev/SKILL.md";
    const served = await fetch(site, { redirect: "error" });
    if (!served.ok) fail(`Could not download ${site}: HTTP ${served.status}`);
    const live = Buffer.from(await served.arrayBuffer());
    if (!live.equals(expected)) {
      fail(`${site} (${sha256(live).slice(0, 12)}) is not the pinned skill (${sha256(expected).slice(0, 12)}). ` +
        "Release only after the website, npm and PyPI copies all come from the same metergraph/skills commit.");
    }
    console.log(`${site} matches the pinned skill.`);
  }
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
  const next = { ...source, commit };
  const core = source.path.split("/")[1];
  const pack = git("ls-tree", "--name-only", `${commit}:skills`)
    .toString()
    .split("\n")
    .filter((name) => name && name !== core)
    .map((name) => ({ name, content: git("show", `${commit}:skills/${name}/SKILL.md`) }));
  rmSync(new URL(`${PACK_DIR}/`, root), { recursive: true, force: true });
  for (const { name, content: skill } of pack) {
    mkdirSync(new URL(`${PACK_DIR}/${name}/`, root), { recursive: true });
    writeFileSync(new URL(`${PACK_DIR}/${name}/SKILL.md`, root), skill);
  }
  const manifestBytes = packManifest(next.repository, commit, pack);
  writeFileSync(new URL(PACK_MANIFEST, root), manifestBytes);
  const pinText = read(PACK_PIN).toString("utf8");
  if (!PACK_PIN_PATTERN.test(pinText)) fail(`${PACK_PIN} has no PINNED_PACK_SHA256 to update`);
  writeFileSync(new URL(PACK_PIN, root), pinText.replace(PACK_PIN_PATTERN, `const PINNED_PACK_SHA256 = "${sha256(manifestBytes)}";`));
  writeFileSync(SOURCE_FILE, `${JSON.stringify(next, null, 2)}\n`);
  const problems = [...checkLocal(content), ...checkPack(next, pack)];
  if (problems.length) fail(`Sync incomplete:\n- ${problems.join("\n- ")}`);
  console.log(`Synced ${source.path} at ${commit.slice(0, 12)} (${hash.slice(0, 12)}${hash === oldHash ? ", unchanged" : `, was ${oldHash.slice(0, 12)}`}) and ${pack.length} pack skills: ${pack.map(({ name }) => name).join(", ")}.`);
} else {
  fail("Usage: node scripts/sync-skill.mjs --from <skills checkout> [--commit SHA] | --check | --check-release");
}
