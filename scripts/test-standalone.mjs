// selfdocs: the independence gate (npm run test:standalone).
//
// Runs the primary job, `selfdocs build --mock`, the way a stranger would after installing the package, with
// nothing else installed:
//   - the package is a copy of only what npm publishes (package.json "files"), outside this repo
//   - HOME is a fresh empty directory
//   - PATH is node's own bin directory plus /usr/bin:/bin (a claude CLI installed beside node stays
//     reachable; --mock never calls it)
//   - the environment is built from scratch: HOME, PATH, LANG and TMPDIR only, so no SELFDOCS_* variables
//   - the working directory is a copy of the fixture project in a temp directory outside any git repo
// It must exit 0 and write the manifest and all five docs. Everything it makes is removed afterwards.

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const DOC_TYPES = ["architecture", "schema", "api", "data-flow", "integrations"];

const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "selfdocs-standalone-")));
const home = path.join(base, "home");
const pkg = path.join(base, "pkg");
const project = path.join(base, "widgetco-api");

/** Fail if `dir` or any directory above it is a git repo or holds a selfdocs config (both would change the run). */
function assertOutsideAnyRepo(dir) {
  for (let d = dir; ; d = path.dirname(d)) {
    assert(!fs.existsSync(path.join(d, ".git")), `${d} is inside a git repo; pick a temp dir outside any repo`);
    for (const n of ["selfdocs.config.mjs", "selfdocs.config.js", "selfdocs.config.cjs", "selfdocs.config.json"]) {
      assert(!fs.existsSync(path.join(d, n)), `${path.join(d, n)} would be picked up as config`);
    }
    if (path.dirname(d) === d) break;
  }
}

let ok = false;
try {
  fs.mkdirSync(home);

  // The published package, and only that.
  fs.mkdirSync(pkg);
  fs.copyFileSync(path.join(REPO, "package.json"), path.join(pkg, "package.json"));
  for (const entry of PKG.files) {
    const rel = entry.replace(/\/$/, "");
    fs.cpSync(path.join(REPO, rel), path.join(pkg, rel), { recursive: true });
  }

  // The project to document: the fixture, with no output from an earlier run.
  fs.cpSync(path.join(REPO, "fixture"), project, { recursive: true });
  fs.rmSync(path.join(project, ".selfdocs"), { recursive: true, force: true });
  assertOutsideAnyRepo(project);

  const env = { HOME: home, PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C" };
  if (process.env.TMPDIR) env.TMPDIR = process.env.TMPDIR;
  assert(Object.keys(env).every((k) => ["HOME", "PATH", "LANG", "TMPDIR"].includes(k)), "the env holds HOME, PATH, LANG and TMPDIR only");

  const bin = path.join(pkg, PKG.bin.selfdocs);
  const run = spawnSync(process.execPath, [bin, "build", "--mock"], { cwd: project, env, encoding: "utf8", timeout: 60_000 });
  if (run.status !== 0) {
    process.stderr.write(run.stdout + run.stderr);
    throw new Error(`selfdocs build --mock exited ${run.status}${run.signal ? ` (${run.signal})` : ""}`);
  }

  const out = path.join(project, ".selfdocs");
  assert(fs.existsSync(path.join(out, "manifest.json")), "manifest.json written");
  let blocks = 0;
  for (const t of DOC_TYPES) {
    const file = path.join(out, "docs", `${t}.json`);
    assert(fs.existsSync(file), `${t}.json written`);
    const doc = JSON.parse(fs.readFileSync(file, "utf8"));
    assert(Array.isArray(doc.blocks) && doc.blocks.length > 0, `${t} has blocks`);
    assert.equal(doc.model, "mock", `${t} was drafted offline`);
    blocks += doc.blocks.length;
  }
  assert.deepEqual(fs.readdirSync(home), [], "nothing was written to HOME");

  console.log(`test:standalone: pass. build --mock exited 0 and wrote ${DOC_TYPES.length} docs (${blocks} blocks) with HOME empty, PATH=${env.PATH}, no other env vars, outside any repo.`);
  ok = true;
} catch (e) {
  console.error(`test:standalone: FAIL. ${e.message}`);
} finally {
  fs.rmSync(base, { recursive: true, force: true });
}
process.exit(ok ? 0 : 1);
