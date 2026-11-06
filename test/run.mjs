// selfdocs — self-test. Zero-dep, fully offline: never touches the `claude` CLI or
// the network (doc generation runs through --mock). Covers the six load-bearing
// behaviors: the scan + ignore rules, project-root detection, block-parser
// round-trips, THE annotation-survives-regeneration merge invariant, an end-to-end
// mock build into a tmp dir, and the viewer server (boot + GET / + API round-trip).

import assert from "node:assert";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { spawnSync } from "node:child_process";

import { createIgnore } from "../src/ignore.mjs";
import { scanDirectory } from "../src/scanner.mjs";
import { detectFileType } from "../src/filetype.mjs";
import {
  detectProjectType,
  detectFramework,
  detectTestFramework,
  detectPackageManager,
} from "../src/root.mjs";
import { generateManifest } from "../src/manifest.mjs";
import { parseMarkdownToBlocks } from "../src/block-parser.mjs";
import { mergeBlocks, insertUserBlock, updateUserBlock, deleteBlock } from "../src/block-merge.mjs";
import { validateArchDoc, autoRepair } from "../src/doc-validator.mjs";
import { mockGenerate } from "../src/mock.mjs";
import { loadConfig, paths, DOC_TYPES } from "../src/config.mjs";
import { runBuild } from "../src/build.mjs";
import { serve } from "../src/serve.mjs";
import { tildify } from "../src/lib.mjs";

const FIXTURE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "fixture");

let pass = 0, fail = 0;
const t = async (name, fn) => {
  try {
    await fn();
    pass++;
    console.log(`  \x1b[32mPASS\x1b[0m ${name}`);
  } catch (e) {
    fail++;
    console.log(`  \x1b[31mFAIL\x1b[0m ${name}\n       ${e.stack || e.message}`);
  }
};

/** Copy the fixture into a fresh tmp dir and synthesize the always-ignored dirs
 *  (node_modules is gitignored so it can't be committed; make one on the fly). */
function freshFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selfdocs-test-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });
  // Synthesize the always-ignored files here (not committed to the repo) so the
  // exclusion assertions are genuine on a fresh clone: node_modules is a default
  // ignore; dist/ and *.secret are matched by the fixture's own .gitignore.
  fs.mkdirSync(path.join(dir, "node_modules", "leftpad"), { recursive: true });
  fs.writeFileSync(path.join(dir, "node_modules", "leftpad", "index.js"), "module.exports = 1;\n");
  fs.mkdirSync(path.join(dir, "dist"), { recursive: true });
  fs.writeFileSync(path.join(dir, "dist", "bundle.js"), "console.log('x');\n");
  fs.writeFileSync(path.join(dir, "notes.secret"), "top secret — must be ignored\n");
  return dir;
}

/** A fresh fixture copy with any pre-existing .selfdocs stripped — a genuine
 *  "nothing generated yet" repo, for exercising the link → generate loop. */
function freshRepo() {
  const dir = freshFixture();
  fs.rmSync(path.join(dir, ".selfdocs"), { recursive: true, force: true });
  return dir;
}

console.log("\nselfdocs self-test\n");

// ── 1. scanner + ignore ──────────────────────────────────────────────────────
await t("scan finds source files and excludes ignored trees", () => {
  const dir = freshFixture();
  try {
    const ig = createIgnore(dir);
    const { files } = scanDirectory(dir, { ignore: ig });
    const paths_ = files.map((f) => f.path.replace(/\\/g, "/"));

    assert(paths_.includes("src/index.js"), "src/index.js should be scanned");
    assert(paths_.includes("src/routes/users.js"), "nested source should be scanned");
    assert(paths_.includes("package.json"), "package.json should be scanned");

    assert(!paths_.some((p) => p.startsWith("node_modules/")), "node_modules must be excluded (default ignore)");
    assert(!paths_.some((p) => p.startsWith("dist/")), "dist/ must be excluded (fixture .gitignore)");
    assert(!paths_.includes("notes.secret"), "*.secret must be excluded (fixture .gitignore)");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await t("every scanned file carries a content hash", () => {
  const dir = freshFixture();
  try {
    const { files } = scanDirectory(dir, { ignore: createIgnore(dir) });
    for (const f of files) assert(/^sha256:[0-9a-f]{16}$|^size:\d+$/.test(f.hash), `bad hash for ${f.path}: ${f.hash}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await t("detectFileType classifies by path", () => {
  assert.equal(detectFileType("test/user.test.js"), "test");
  assert.equal(detectFileType("src/foo.spec.ts"), "test");
  assert.equal(detectFileType("package.json"), "config");
  assert.equal(detectFileType("README.md"), "docs");
  assert.equal(detectFileType("logo.png"), "binary");
  assert.equal(detectFileType("data/seeds/x.csv"), "data");
  assert.equal(detectFileType("src/index.js"), "source");
  assert.equal(detectFileType("Makefile"), "other");
});

await t("hand-rolled ignore matcher handles globs, anchoring, and negation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selfdocs-ig-"));
  try {
    fs.writeFileSync(
      path.join(dir, ".gitignore"),
      ["build/", "*.log", "/only-root.txt", "docs/**/*.tmp", "!keep.log"].join("\n"),
    );
    const ig = createIgnore(dir);
    assert(ig.ignores("build/x.js"), "dir pattern ignores descendants");
    assert(ig.ignores("a/b/error.log"), "*.log ignores at any depth");
    assert(!ig.ignores("keep.log"), "negation un-ignores keep.log");
    assert(ig.ignores("only-root.txt"), "anchored root file ignored");
    assert(!ig.ignores("sub/only-root.txt"), "anchored pattern does not match nested");
    assert(ig.ignores("docs/a/b/note.tmp"), "** crosses directories");
    assert(!ig.ignores("src/index.js"), "unrelated file not ignored");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 2. project-root detection ────────────────────────────────────────────────
await t("root detection identifies the fixture as a node/express project", () => {
  assert.equal(detectProjectType(FIXTURE), "node");
  assert.equal(detectFramework(FIXTURE, "node"), "express");
  assert.equal(detectTestFramework(FIXTURE, "node"), "jest");
  assert.equal(detectPackageManager(FIXTURE, "node"), "npm");
});

await t("generateManifest assembles stats + markers", () => {
  const m = generateManifest(FIXTURE);
  assert.equal(m.project_type, "node");
  assert.equal(m.markers.framework, "express");
  assert(m.stats.total_files > 3, "should count several files");
  assert(m.files.every((f) => typeof f.path === "string" && f.hash), "files carry path + hash");
});

// ── 3. block-parser round-trips ──────────────────────────────────────────────
const SAMPLE_MD = `# Architecture Overview

## System Overview

The app does things. It uses \`express\`.

## Technology Stack

| Layer | Technology |
| --- | --- |
| Language | JavaScript |

## System Components

### \`src\`

- routes
- models

\`\`\`sh
npm run dev
\`\`\`
`;

await t("parseMarkdownToBlocks yields anchored blocks of the right types", () => {
  const blocks = parseMarkdownToBlocks(SAMPLE_MD);
  const byType = (tp) => blocks.filter((b) => b.block_type === tp);

  assert.equal(blocks[0].block_type, "heading");
  assert.equal(blocks[0].anchor, "h1:architecture-overview");
  assert(blocks.some((b) => b.anchor === "h2:architecture-overview/system-overview"), "H2 anchor present");
  assert(byType("table").length === 1, "one table block");
  assert(byType("code").length === 1, "one code block");
  assert(byType("list").length === 1, "one list block");
  assert(blocks.some((b) => b.anchor === "h3:architecture-overview/system-components/src"), "H3 anchor present");
});

await t("anchors are stable across re-parses of identical markdown", () => {
  const a = parseMarkdownToBlocks(SAMPLE_MD).map((b) => b.anchor);
  const b = parseMarkdownToBlocks(SAMPLE_MD).map((x) => x.anchor);
  assert.deepEqual(a, b);
  assert.equal(new Set(a).size, a.length, "anchors are unique within a doc");
});

// ── 4. THE annotation-survives-regeneration invariant ────────────────────────
await t("a user annotation survives regeneration and stays attached", () => {
  // v1: first generation.
  const gen1 = parseMarkdownToBlocks(SAMPLE_MD);
  const v1 = mergeBlocks([], gen1, "2026-01-01T00:00:00.000Z");
  assert.equal(v1.report.inserted, gen1.length);
  assert.equal(v1.report.updated, 0);

  // The user leaves a note under the Technology Stack heading.
  const anchor = "h2:architecture-overview/technology-stack";
  const withNote = insertUserBlock(v1.blocks, { after_anchor: anchor, content: "Note: we pin express to 4.x." }, "2026-01-02T00:00:00.000Z");
  const noteId = withNote.block.id;
  assert(withNote.blocks.some((b) => b.id === noteId && b.origin === "user"), "note inserted");

  // v2: regenerate with the SAME content — auto blocks all "updated", note kept.
  const gen2 = parseMarkdownToBlocks(SAMPLE_MD);
  const v2 = mergeBlocks(withNote.blocks, gen2, "2026-01-03T00:00:00.000Z");
  const note2 = v2.blocks.find((b) => b.id === noteId);
  assert(note2, "note still present after regeneration");
  assert.equal(note2.origin, "user");
  assert.equal(note2.detached, 0, "note stays attached");
  assert.equal(note2.content, "Note: we pin express to 4.x.", "note content preserved");
  assert.equal(v2.report.inserted, 0, "same content ⇒ nothing inserted");
  assert.equal(v2.report.deleted, 0, "same content ⇒ nothing deleted");

  // The note sits immediately after its anchor auto-block.
  const anchorIdx = v2.blocks.findIndex((b) => b.anchor === anchor);
  const noteIdx = v2.blocks.findIndex((b) => b.id === noteId);
  assert.equal(noteIdx, anchorIdx + 1, "note is threaded right after its anchor");
});

await t("a note detaches when its anchor disappears, and reattaches when it returns", () => {
  const gen1 = parseMarkdownToBlocks(SAMPLE_MD);
  const v1 = mergeBlocks([], gen1, "2026-01-01T00:00:00.000Z");
  const anchor = "h2:architecture-overview/system-components";
  const withNote = insertUserBlock(v1.blocks, { after_anchor: anchor, content: "components note" }, "2026-01-02T00:00:00.000Z");
  const noteId = withNote.block.id;

  // Regenerate a doc WITHOUT the System Components section.
  const shrunk = `# Architecture Overview\n\n## System Overview\n\nJust the overview now.\n\n## Technology Stack\n\n| Layer | Technology |\n| --- | --- |\n| Language | JavaScript |\n`;
  const v2 = mergeBlocks(withNote.blocks, parseMarkdownToBlocks(shrunk), "2026-01-03T00:00:00.000Z");
  const note2 = v2.blocks.find((b) => b.id === noteId);
  assert(note2, "note not deleted — it detaches, never drops");
  assert.equal(note2.detached, 1, "note detached when anchor vanished");
  assert.equal(v2.report.detached, 1);

  // Detached notes float to the end.
  assert.equal(v2.blocks[v2.blocks.length - 1].id, noteId, "detached note floats to the bottom");

  // Bring the section back → the note reattaches.
  const v3 = mergeBlocks(v2.blocks, parseMarkdownToBlocks(SAMPLE_MD), "2026-01-04T00:00:00.000Z");
  const note3 = v3.blocks.find((b) => b.id === noteId);
  assert.equal(note3.detached, 0, "note reattached when anchor returned");
  assert.equal(v3.report.reattached, 1);
});

await t("auto-block content updates in place while its id (and anchor) is stable", () => {
  const v1 = mergeBlocks([], parseMarkdownToBlocks(SAMPLE_MD), "2026-01-01T00:00:00.000Z");
  const anchor = "h2:architecture-overview/system-overview";
  const bodyAnchor = "body:architecture-overview/system-overview/1";
  const idBefore = v1.blocks.find((b) => b.anchor === bodyAnchor).id;

  const edited = SAMPLE_MD.replace("The app does things.", "The app does MANY things.");
  const v2 = mergeBlocks(v1.blocks, parseMarkdownToBlocks(edited), "2026-01-02T00:00:00.000Z");
  const after = v2.blocks.find((b) => b.anchor === bodyAnchor);
  assert.equal(after.id, idBefore, "auto block keeps its id across a content edit");
  assert(after.content.includes("MANY"), "auto block content refreshed");
  assert(anchor, "anchor referenced");
});

await t("editing and deleting user blocks works; auto blocks are read-only", () => {
  const v1 = mergeBlocks([], parseMarkdownToBlocks(SAMPLE_MD), "2026-01-01T00:00:00.000Z");
  const ins = insertUserBlock(v1.blocks, { after_anchor: "h1:architecture-overview", content: "top note" });
  const id = ins.block.id;

  const edited = updateUserBlock(ins.blocks, id, "top note (edited)");
  assert.equal(edited.block.content, "top note (edited)");

  // updating an auto block id is a no-op (returns null block).
  const autoId = v1.blocks.find((b) => b.origin === "auto").id;
  const noop = updateUserBlock(edited.blocks, autoId, "hack");
  assert.equal(noop.block, null, "auto blocks cannot be edited via updateUserBlock");

  const del = deleteBlock(edited.blocks, id);
  assert(del.removed, "user block deleted");
  assert(!del.blocks.some((b) => b.id === id), "block gone");
});

// ── validator + mock sanity (feeds the build path) ───────────────────────────
await t("the mock generator produces a valid doc for every type", () => {
  const manifest = generateManifest(FIXTURE);
  for (const docType of DOC_TYPES) {
    const md = autoRepair(mockGenerate(manifest, docType));
    const v = validateArchDoc(md, docType);
    assert(v.valid, `${docType} should validate; issues: ${JSON.stringify(v.issues.filter((i) => i.severity === "error"))}`);
    assert(md.startsWith("# "), `${docType} starts with an H1`);
  }
});

await t("a well-formed table gets no table warning, and one with no alignment row gets one", () => {
  const ok = "# T\n\n## S\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n| 7 | 8 |\n";
  const warns = (md) => validateArchDoc(md, "architecture").issues.filter((i) => i.rule === "table-missing-alignment-row");
  assert(warns(ok).length === 0, `a valid table should not warn: ${JSON.stringify(warns(ok))}`);
  const bad = "# T\n\n## S\n\n| A | B |\n| 1 | 2 |\n| 3 | 4 |\n| 5 | 6 |\n";
  assert(warns(bad).length === 1, `one warning for the one table, got ${warns(bad).length}`);
  assert(warns(ok + "\n" + bad.slice(10)).length === 1, "two tables, one bad: one warning");
});

await t("with no model configured, the claude CLI is asked for the default model (never null)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selfdocs-model-"));
  const bin = path.join(dir, "claude");
  // A stand-in claude CLI: it records its arguments and replies with a result envelope.
  fs.writeFileSync(bin, `#!/usr/bin/env node\nrequire("fs").writeFileSync(${JSON.stringify(path.join(dir, "args.json"))}, JSON.stringify(process.argv.slice(2)));\nprocess.stdin.resume(); process.stdin.on("end", () => console.log(JSON.stringify({ result: "# Doc" })));\n`);
  fs.chmodSync(bin, 0o755);
  const llm = JSON.stringify(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "src", "llm.mjs"));
  const r = spawnSync(process.execPath, ["--input-type=module", "-e", `const { callLLM, DEFAULT_MODEL } = await import(${llm}); const out = await callLLM({ model: null, system: "s", userMessage: "u" }); console.log(JSON.stringify({ out: out.model, def: DEFAULT_MODEL }));`], { encoding: "utf8", env: { ...process.env, SELFDOCS_CLAUDE_BIN: bin } });
  assert(r.status === 0, r.stderr);
  const { out, def } = JSON.parse(r.stdout.trim());
  const args = JSON.parse(fs.readFileSync(path.join(dir, "args.json"), "utf8"));
  assert(args[args.indexOf("--model") + 1] === def, `--model ${args[args.indexOf("--model") + 1]}`);
  assert(out === def, `the doc records ${out}`);
});

await t("autoRepair inserts an alignment row ONLY after the table header", () => {
  const md = "# T\n\n## S\n\n| A | B |\n| 1 | 2 |\n| 3 | 4 |\n";
  const repaired = autoRepair(md);
  const seps = repaired.split("\n").filter((l) => /^\|( --- \|)+$/.test(l));
  assert(seps.length === 1, `expected exactly 1 alignment row, got ${seps.length}:\n${repaired}`);
  const already = "| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |";
  assert(autoRepair(already) === already, "an already-aligned table is untouched");
});

// ── 5. end-to-end mock build into a tmp dir ──────────────────────────────────
await t("mock build writes manifest + all five docs to .selfdocs/", async () => {
  const dir = freshFixture();
  try {
    const { config, root } = await loadConfig({ cwd: dir });
    const { results } = await runBuild({ config, root, types: DOC_TYPES, mock: true, log: () => {} });
    assert.equal(results.length, 5);

    const P = paths(root);
    assert(fs.existsSync(P.MANIFEST_FILE), "manifest.json written");
    for (const docType of DOC_TYPES) {
      assert(fs.existsSync(P.docFile(docType)), `${docType}.json written`);
      const doc = JSON.parse(fs.readFileSync(P.docFile(docType), "utf8"));
      assert(Array.isArray(doc.blocks) && doc.blocks.length > 0, `${docType} has blocks`);
      assert.equal(doc.blocks[0].block_type, "heading", `${docType} opens with a heading block`);
      assert.equal(doc.model, "mock");
    }
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await t("a second mock build preserves an annotation written between runs", async () => {
  const dir = freshFixture();
  try {
    const { config, root } = await loadConfig({ cwd: dir });
    await runBuild({ config, root, types: ["architecture"], mock: true, log: () => {} });

    const P = paths(root);
    // Simulate an annotation being saved (what the server's POST does).
    const doc = JSON.parse(fs.readFileSync(P.docFile("architecture"), "utf8"));
    const anchor = doc.blocks.find((b) => b.block_type === "heading" && /technology-stack/.test(b.anchor))?.anchor
      || doc.blocks.find((b) => b.origin === "auto").anchor;
    const withNote = insertUserBlock(doc.blocks, { after_anchor: anchor, content: "human: verified against package.json" });
    fs.writeFileSync(P.docFile("architecture"), JSON.stringify({ ...doc, blocks: withNote.blocks }, null, 2));
    const noteId = withNote.block.id;

    // Rebuild — the note must survive.
    await runBuild({ config, root, types: ["architecture"], mock: true, log: () => {} });
    const after = JSON.parse(fs.readFileSync(P.docFile("architecture"), "utf8"));
    const note = after.blocks.find((b) => b.id === noteId);
    assert(note, "annotation survived the rebuild end-to-end");
    assert.equal(note.detached, 0, "annotation still attached");
    assert.equal(note.content, "human: verified against package.json");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 6. serve: boot + GET / + API round-trip ──────────────────────────────────
await t("serve boots, returns the viewer, serves /api/docs, and round-trips an annotation", async () => {
  const dir = freshFixture();
  let server;
  try {
    const { config, root } = await loadConfig({ cwd: dir });
    await runBuild({ config, root, types: DOC_TYPES, mock: true, log: () => {} });

    server = serve({ config, root, port: 0, open: false, log: () => {} });
    await once(server, "listening");
    const { port } = server.address();
    const base = `http://127.0.0.1:${port}`;

    // GET / → the viewer HTML.
    const home = await fetch(`${base}/`);
    assert.equal(home.status, 200, "GET / is 200");
    const html = await home.text();
    assert(/<!--\s*selfdocs viewer\s*-->|selfdocs/i.test(html) && html.includes("<style"), "viewer HTML served");

    // GET /api/docs → JSON with all five doc types.
    const docsRes = await fetch(`${base}/api/docs`);
    assert.equal(docsRes.status, 200, "GET /api/docs is 200");
    const payload = await docsRes.json();
    assert(payload.ok && payload.docs && payload.docTypes.length === 5, "api/docs shape");
    assert(payload.docs.architecture.blocks.length > 0, "architecture blocks present");

    // POST /api/blocks → add an annotation.
    const anchor = payload.docs.architecture.blocks.find((b) => b.origin === "auto").anchor;
    const postRes = await fetch(`${base}/api/blocks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docType: "architecture", after_anchor: anchor, content: "served note" }),
    });
    assert.equal(postRes.status, 200, "POST /api/blocks is 200");
    const posted = await postRes.json();
    assert(posted.ok && posted.block?.id, "POST returns the new block");
    const noteId = posted.block.id;

    // It's persisted to disk.
    const P = paths(root);
    const onDisk = JSON.parse(fs.readFileSync(P.docFile("architecture"), "utf8"));
    assert(onDisk.blocks.some((b) => b.id === noteId), "annotation persisted to .selfdocs/");

    // And visible on the next GET.
    const docs2 = await (await fetch(`${base}/api/docs`)).json();
    assert(docs2.docs.architecture.blocks.some((b) => b.id === noteId), "annotation visible via API");

    // PATCH → edit it.
    const patchRes = await fetch(`${base}/api/blocks`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docType: "architecture", id: noteId, content: "served note (edited)" }),
    });
    assert.equal((await patchRes.json()).block.content, "served note (edited)", "PATCH edits the note");

    // DELETE → remove it.
    const delRes = await fetch(`${base}/api/blocks`, {
      method: "DELETE",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docType: "architecture", id: noteId }),
    });
    assert((await delRes.json()).ok, "DELETE removes the note");
    const after = JSON.parse(fs.readFileSync(P.docFile("architecture"), "utf8"));
    assert(!after.blocks.some((b) => b.id === noteId), "note gone from disk");

    // Cross-origin mutation is blocked.
    const evil = await fetch(`${base}/api/blocks`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ docType: "architecture", after_anchor: anchor, content: "x" }),
    });
    assert.equal(evil.status, 403, "cross-origin POST rejected");
  } finally {
    if (server) server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 7. in-browser loop: link a repo → generate → read ────────────────────────
await t("POST /api/target links a fresh repo; /api/env reports it exists with a detected type", async () => {
  const boot = fs.mkdtempSync(path.join(os.tmpdir(), "selfdocs-boot-"));
  const dir = freshRepo();
  let server;
  try {
    const { config, root } = await loadConfig({ cwd: boot });
    server = serve({ config, root, port: 0, open: false, log: () => {} });
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;

    // Boots pointed at the empty boot dir.
    const env0 = await (await fetch(`${base}/api/env`)).json();
    assert(env0.ok, "GET /api/env ok");
    assert.equal(env0.target.path, path.resolve(root), "env starts on the boot root");
    assert.equal(env0.generated, false, "nothing generated at boot");

    // Link the fixture repo.
    const res = await fetch(`${base}/api/target`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: dir }),
    });
    assert.equal(res.status, 200, "POST /api/target is 200");
    const linked = await res.json();
    assert(linked.ok, "target linked");
    assert.equal(linked.target.path, path.resolve(dir), "target path echoes the linked repo");
    assert.equal(linked.target.exists, true, "linked target exists");
    assert.equal(linked.target.projectType, "node", "detected node");
    assert.equal(linked.target.framework, "express", "detected express");
    assert.equal(linked.generated, false, "no docs generated in the fresh repo yet");

    // /api/env now reflects the linked target.
    const env1 = await (await fetch(`${base}/api/env`)).json();
    assert.equal(env1.target.path, path.resolve(dir), "env reflects the linked target");
    assert.equal(env1.target.exists, true);
    assert.equal(env1.target.projectType, "node");

    // A non-directory path is rejected.
    const bad = await fetch(`${base}/api/target`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ path: path.join(dir, "package.json") }),
    });
    assert.equal(bad.status, 400, "linking a file (not a dir) is 400");
    assert.equal((await bad.json()).ok, false, "the 400 body is a failure envelope");
  } finally {
    if (server) server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(boot, { recursive: true, force: true });
  }
});

await t("POST /api/build generates into the linked target; an annotation survives a rebuild", async () => {
  const boot = fs.mkdtempSync(path.join(os.tmpdir(), "selfdocs-boot-"));
  const dir = freshRepo();
  let server;
  try {
    const { config, root } = await loadConfig({ cwd: boot });
    server = serve({ config, root, port: 0, open: false, log: () => {} });
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;

    // Link, then build offline — no terminal round-trip.
    await fetch(`${base}/api/target`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ path: dir }) });
    const buildRes = await fetch(`${base}/api/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mock: true }) });
    assert.equal(buildRes.status, 200, "POST /api/build is 200");
    const built = await buildRes.json();
    assert(built.ok && built.mode === "mock", "built in mock mode");
    assert.equal(built.generated.length, 5, "all five docs generated");
    assert(built.project && built.project.type === "node", "build reply carries the project block");

    // Docs landed under the LINKED target — not the boot dir.
    const P = paths(dir);
    assert(fs.existsSync(P.MANIFEST_FILE), "manifest written under the linked target");
    assert(!fs.existsSync(paths(root).MANIFEST_FILE), "nothing written under the boot dir");

    // GET /api/docs now shows generated blocks.
    const docs = await (await fetch(`${base}/api/docs`)).json();
    assert(docs.docs.architecture.blocks.length > 0, "architecture has blocks after the build");
    assert.equal(docs.project.type, "node", "/api/docs project block reflects the target");

    // Annotate, then rebuild that doc — the note must survive.
    const anchor = docs.docs.architecture.blocks.find((b) => b.origin === "auto").anchor;
    const posted = await (await fetch(`${base}/api/blocks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ docType: "architecture", after_anchor: anchor, content: "survives the rebuild" }),
    })).json();
    const noteId = posted.block.id;

    const rebuild = await fetch(`${base}/api/build`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ types: ["architecture"], mock: true }) });
    assert.equal(rebuild.status, 200, "second build is 200");
    const rebuilt = await rebuild.json();
    assert.equal(rebuilt.generated.length, 1, "only architecture rebuilt");
    assert(rebuilt.generated[0].userKept >= 1, "the rebuild reports the note kept");

    const after = await (await fetch(`${base}/api/docs`)).json();
    const note = after.docs.architecture.blocks.find((b) => b.id === noteId);
    assert(note, "annotation survived the in-browser rebuild");
    assert.equal(note.detached, 0, "annotation still attached");
    assert.equal(note.content, "survives the rebuild", "annotation content preserved");
  } finally {
    if (server) server.close();
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(boot, { recursive: true, force: true });
  }
});

await t("POST /api/target and /api/build reject a cross-origin Origin (403)", async () => {
  const dir = freshRepo();
  let server;
  try {
    const { config, root } = await loadConfig({ cwd: dir });
    server = serve({ config, root, port: 0, open: false, log: () => {} });
    await once(server, "listening");
    const base = `http://127.0.0.1:${server.address().port}`;

    const evilTarget = await fetch(`${base}/api/target`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ path: dir }),
    });
    assert.equal(evilTarget.status, 403, "cross-origin POST /api/target rejected");

    const evilBuild = await fetch(`${base}/api/build`, {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ mock: true }),
    });
    assert.equal(evilBuild.status, 403, "cross-origin POST /api/build rejected");
  } finally {
    if (server) server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ── 8. init, links, and the mock's wording ───────────────────────────────────
const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PKG = JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8"));
const HOME_PAGE = PKG.homepage.replace(/\/$/, "");
/** Every link to a selfdocs repo on GitHub or GitLab in `text`. */
const repoLinks = (text) => text.match(/https?:\/\/(?:github|gitlab)\.com\/[^\s"'`)<>]*selfdocs[^\s"'`)<>]*/g) || [];

await t("init scaffolds a config that links to package.json's homepage and loads cleanly", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selfdocs-init-"));
  try {
    const run = spawnSync(process.execPath, [path.join(REPO, "bin", "selfdocs.mjs"), "init"], { cwd: dir, encoding: "utf8" });
    assert.equal(run.status, 0, `init exits 0 (stderr: ${run.stderr})`);
    const file = path.join(dir, "selfdocs.config.mjs");
    const text = fs.readFileSync(file, "utf8");
    assert(PKG.homepage && text.includes(PKG.homepage), `the scaffold links to ${PKG.homepage}`);
    for (const l of repoLinks(text)) assert(l.startsWith(HOME_PAGE), `stale link ${l}: package.json names ${HOME_PAGE}`);
    const { config, file: found } = await loadConfig({ cwd: dir });
    assert.equal(found, file, "loadConfig finds the scaffolded file");
    assert.deepEqual(config.docTypes, DOC_TYPES, "the scaffold asks for all five doc types");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await t("every selfdocs repo link the package ships matches package.json", () => {
  const shipped = [
    ...fs.readdirSync(path.join(REPO, "src")).map((f) => path.join(REPO, "src", f)),
    path.join(REPO, "viewer", "index.html"),
    path.join(REPO, "README.md"),
  ];
  for (const f of shipped) {
    for (const l of repoLinks(fs.readFileSync(f, "utf8"))) assert(l.startsWith(HOME_PAGE), `${path.relative(REPO, f)} links to ${l}, not ${HOME_PAGE}`);
  }
  for (const [key, url] of [["repository.url", PKG.repository.url], ["bugs.url", PKG.bugs.url]]) {
    assert(url.replace(/^git\+/, "").startsWith(HOME_PAGE), `package.json ${key} is ${url}, not under ${HOME_PAGE}`);
  }
});

await t("the mock names a one-file directory in the singular", () => {
  const md = mockGenerate(generateManifest(FIXTURE), "architecture");
  assert(/1 file lives under `config`/.test(md), "a one-file directory reads '1 file lives under'");
  assert(!/\b1 file live under/.test(md), "never '1 file live under'");
  assert(/\d+ files live under/.test(md), "several files still read 'files live under'");
  assert(!md.includes("(root)"), "the repo root is named in words, not as a `(root)/` directory");
  assert(/### Repository root\n\n\d+ files? sits? at the top of the repository/.test(md), "the root gets its own component");
});

// ── 9. paths for people: ~/… under the home directory ────────────────────────
await t("tildify shows paths under home as ~/… and leaves the rest alone", () => {
  const home = path.join(path.sep, "home", "matt");
  assert.equal(tildify(home, home), "~", "home itself");
  assert.equal(tildify(path.join(home, "code", "repo"), home), `~${path.sep}${path.join("code", "repo")}`, "a path under home");
  assert.equal(tildify(path.join(home, "code"), home + path.sep), `~${path.sep}code`, "a home with a trailing separator");
  assert.equal(tildify(path.join(path.sep, "home", "matthew", "repo"), home), path.join(path.sep, "home", "matthew", "repo"), "a sibling that shares the prefix is not under home");
  assert.equal(tildify(path.join(path.sep, "srv", "repo"), home), path.join(path.sep, "srv", "repo"), "a path outside home");
  assert.equal(tildify(path.join(path.sep, "srv", "repo"), path.sep), path.join(path.sep, "srv", "repo"), "a home of / changes nothing");
  assert.equal(tildify(path.join(home, "x"), ""), path.join(home, "x"), "no home changes nothing");
});

await t("/api/env reports a repo under HOME as ~/<name>, matching HOME's resolved path too", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "selfdocs-home-"));
  const repo = path.join(home, "widgetco-api");
  fs.cpSync(FIXTURE, repo, { recursive: true });
  const savedHome = process.env.HOME;
  let server;
  try {
    process.env.HOME = home; // as given; on macOS this is /var/…, and the root below resolves to /private/var/…
    const { config } = await loadConfig({ cwd: repo });
    server = serve({ config, root: fs.realpathSync(repo), port: 0, open: false, log: () => {} });
    await once(server, "listening");
    const env = await (await fetch(`http://127.0.0.1:${server.address().port}/api/env`)).json();
    assert.equal(env.target.display, `~${path.sep}widgetco-api`, "display path is ~/widgetco-api");
    assert.equal(env.target.path, fs.realpathSync(repo), "the real path is still there for the server's own use");
  } finally {
    if (savedHome === undefined) delete process.env.HOME; else process.env.HOME = savedHome;
    if (server) server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// ── 10. the viewer keeps the kit's look ───────────────────────────────────────
const VIEWER = fs.readFileSync(path.join(REPO, "viewer", "index.html"), "utf8");
const KIT_BEGIN = "/* excellent-kit:begin */";
const KIT_END = "/* excellent-kit:end */";
/** The viewer's own CSS: everything in the <style> after the kit block. */
const ownCss = () => VIEWER.slice(VIEWER.indexOf(KIT_END) + KIT_END.length, VIEWER.indexOf("</style>"));

await t("the viewer carries the kit block and is light unless the reader picks dark", () => {
  const a = VIEWER.indexOf(KIT_BEGIN), b = VIEWER.indexOf(KIT_END);
  assert(a > 0 && b > a, "kit markers present, in order");
  const kit = VIEWER.slice(a, b);
  for (const token of ["--color-verified", "--color-returned", ".ex-btn", ".ex-shell", ".theme-dark"]) {
    assert(kit.includes(token), `kit block has ${token} (run: npx @excellent-so/kit sync viewer/index.html --no-compat --fonts)`);
  }
  // The favicon is its own SVG document and follows the browser's tab bar; the page itself never keys on the OS.
  const page = VIEWER.replace(/<link rel="icon" href="[^"]*" \/>/, "");
  assert(!/prefers-color-scheme/.test(page), "no style or script keys on the OS colour scheme");
  assert(!/matchMedia\(/.test(VIEWER), "no theme guess from matchMedia");
  assert(/classList\.toggle\("theme-dark"/.test(VIEWER) && VIEWER.includes('"ex-theme"'), "the toggle sets .theme-dark and remembers ex-theme");
  assert(VIEWER.includes("data-ex-theme-toggle"), "the kit's theme toggle hook is on the button");
});

await t("the viewer wears the selfdocs mark and links nowhere but the repo", () => {
  const PAGE_PATH = 'd="M2 1h12v14H2z"'; // the mark's outline: a page, with two lines and a cursor inside
  const brand = VIEWER.match(/<span class="ex-sidebar__brand">([\s\S]*?)<\/span>/);
  assert(brand, "the sidebar has a brand row");
  assert(/^<svg class="ex-mark"[^>]*aria-hidden="true"/.test(brand[1]) && brand[1].includes(PAGE_PATH), "the mark leads the brand row");
  assert(brand[1].endsWith("</svg>selfdocs"), "the name follows the mark");
  const icon = VIEWER.match(/<link rel="icon" href="([^"]*)" \/>/);
  assert(icon && icon[1].startsWith("data:image/svg+xml,"), "the favicon is an inline SVG");
  assert(decodeURIComponent(icon[1]).includes(PAGE_PATH.replace(/"/g, "'")), "the favicon is the mark");
  const markup = VIEWER.slice(VIEWER.indexOf("<body"));
  const links = [...markup.matchAll(/\bhref="(https?:[^"]*)"/g)].map((m) => m[1]);
  assert.deepEqual(links, [HOME_PAGE], `the only outside link is the Code link to ${HOME_PAGE}`);
});

await t("the viewer's own CSS has no colour of its own and no text under 12px", () => {
  const css = ownCss();
  assert(/\.sd-prose \.ex-table code \{ overflow-wrap: normal; \}/.test(css), "code in a table cell breaks only between words");
  assert(css.length > 1000, "found the viewer's own CSS after the kit block");
  const colours = css.match(/#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(/g);
  assert(!colours, `colours come from kit tokens only; found ${colours}`);
  for (const old of ["#4F46E5", "#6366F1", "#10B981", "#8B5CF6", "#4338CA", "#047857"]) {
    assert(!VIEWER.toUpperCase().includes(old), `no ${old} (the pre-kit indigo/emerald/violet palette)`);
  }
  for (const m of css.matchAll(/font-size:\s*([\d.]+)(px|rem)/g)) {
    const px = m[2] === "rem" ? Number(m[1]) * 16 : Number(m[1]);
    assert(px >= 12, `font-size ${m[1]}${m[2]} is under 12px`);
  }
});

// ── 9. the unhappy paths: one sentence, what to do, the right exit code ─────────
const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "selfdocs.mjs");
const SRC_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "src");

/** Run the CLI with a clean environment (plus `env`) in `cwd`. */
function cli(args, { cwd = os.tmpdir(), env = {} } = {}) {
  const base = { HOME: os.tmpdir(), PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, LANG: "C" };
  return spawnSync(process.execPath, [BIN, ...args], { cwd, env: { ...base, ...env }, encoding: "utf8", timeout: 60_000 });
}

/** A stand-in claude CLI. `script` runs with `args` (argv) and `input` (stdin) in scope and prints the reply. */
function standInClaude(dir, script) {
  const bin = path.join(dir, "claude-standin.cjs");
  fs.writeFileSync(
    bin,
    `#!/usr/bin/env node\nconst fs = require("fs"); const args = process.argv.slice(2);\nif (args[0] === "--version") { console.log("0.0.0"); process.exit(0); }\nlet input = ""; process.stdin.on("data", (c) => (input += c)); process.stdin.on("end", () => {\n${script}\n});\n`,
  );
  fs.chmodSync(bin, 0o755);
  return bin;
}

const ARCH_DOC = "# Architecture Overview\n\n## System Overview\n\nA draft.\n\n## Technology Stack\n\n| Layer | Technology |\n| --- | --- |\n| Language | JavaScript |\n\n## System Components\n\nThe `src/` tree.\n";

await t("the CLI answers --help, --version and mistakes in one sentence, with no stack trace", () => {
  const help = cli(["build", "--help"]);
  assert(help.status === 0 && help.stdout.includes("Commands"), "build --help prints the help and builds nothing");
  const ver = cli(["--version"]);
  assert(ver.status === 0 && ver.stdout.trim() === JSON.parse(fs.readFileSync(path.join(SRC_DIR, "..", "package.json"), "utf8")).version, ver.stdout);
  for (const [args, says] of [
    [["bogus"], `"bogus" isn't a selfdocs command`],
    [["build", "--mokc"], "build doesn't take --mokc"],
    [["build", "--type"], "--type needs a value"],
    [["build", "--mock", "--type=nope"], "unknown doc type: nope"],
    [["status", "--target=/no/such/dir"], "/no/such/dir isn't a folder"],
    [["serve", "--port=99999"], "--port must be a port number"],
  ]) {
    const r = cli(args);
    assert.equal(r.status, 1, `${args.join(" ")} exits 1`);
    assert(r.stderr.includes(says), `${args.join(" ")} says "${says}": ${r.stderr}`);
    assert(!/\n\s+at .+:\d+:\d+/.test(r.stderr), `${args.join(" ")} prints no stack trace: ${r.stderr}`);
  }
});

await t("hints name the command the way it was run", () => {
  const r = cli(["bogus"], { cwd: path.dirname(path.dirname(BIN)) });
  assert(r.stderr.includes("See `node bin/selfdocs.mjs --help`"), `from a clone: ${r.stderr}`);
  const n = cli(["bogus"], { env: { npm_command: "exec" } });
  assert(n.stderr.includes("See `npx @excellent-so/selfdocs --help`"), `through npx: ${n.stderr}`);
});

await t("--type and --target take a value after a space too", () => {
  const dir = freshRepo();
  try {
    const r = cli(["build", "--mock", "--type", "api", "--target", dir]);
    assert.equal(r.status, 0, r.stderr);
    assert(fs.existsSync(path.join(dir, ".selfdocs", "docs", "api.json")) && !fs.existsSync(path.join(dir, ".selfdocs", "docs", "schema.json")), "only api was built");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await t("an empty folder and a broken config each stop with what to do", () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "selfdocs-empty-"));
  try {
    const r = cli(["build", "--mock"], { cwd: empty });
    assert(r.status === 1 && r.stderr.includes("found no files to document"), r.stderr);
    assert(!fs.existsSync(path.join(empty, ".selfdocs")), "nothing is written for an empty folder");
    fs.writeFileSync(path.join(empty, "selfdocs.config.json"), "{ not json");
    const bad = cli(["status"], { cwd: empty });
    assert(bad.status === 1 && bad.stderr.includes("couldn't read the config file") && bad.stderr.includes("Fix the file or delete it"), bad.stderr);
  } finally {
    fs.rmSync(empty, { recursive: true, force: true });
  }
});

await t("a claude CLI that isn't signed in is reported with how to sign in", () => {
  const dir = freshRepo();
  try {
    // The envelope claude 2.1 prints when it has no credentials.
    const bin = standInClaude(dir, `console.log(JSON.stringify({ type: "result", is_error: true, result: "Not logged in · Please run /login" })); process.exit(1);`);
    const r = cli(["build", "--type=architecture"], { cwd: dir, env: { SELFDOCS_CLAUDE_BIN: bin } });
    assert.equal(r.status, 1);
    assert(r.stderr.includes("isn't signed in") && r.stderr.includes("claude auth login"), r.stderr);
    assert(!/\n\s+at .+:\d+:\d+/.test(r.stderr), "no stack trace");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await t("claude is run isolated, and asked again without a flag an older CLI rejects", () => {
  const dir = freshRepo();
  try {
    const log = path.join(dir, "calls.jsonl");
    const bin = standInClaude(
      dir,
      `fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(args) + "\\n");
       if (args.includes("--safe-mode")) { process.stderr.write("error: unknown option '--safe-mode'\\n"); process.exit(1); }
       console.log(JSON.stringify({ type: "result", is_error: false, result: ${JSON.stringify(ARCH_DOC)}, usage: { input_tokens: 5, cache_read_input_tokens: 100, output_tokens: 7 } }));`,
    );
    const r = cli(["build", "--type=architecture"], { cwd: dir, env: { SELFDOCS_CLAUDE_BIN: bin } });
    assert.equal(r.status, 0, r.stderr);
    const calls = fs.readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(calls.length, 2, "one rejected call, one retry");
    assert(calls[0].includes("--safe-mode") && calls[0].includes("--strict-mcp-config"), "first asks for no MCP servers and no user setup");
    assert(!calls[1].includes("--safe-mode") && calls[1].includes("--strict-mcp-config"), "the retry drops only the rejected flag");
    assert(calls[1][calls[1].indexOf("--disallowedTools") + 1] === "*", "every tool stays disallowed");
    const doc = JSON.parse(fs.readFileSync(path.join(dir, ".selfdocs", "docs", "architecture.json"), "utf8"));
    assert.equal(doc.input_tokens, 105, "cached prompt tokens count toward the input");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await t("a context the model calls too large is retried once at half, then stops with what to do", async () => {
  const dir = freshRepo();
  try {
    // Pad the repo so the architecture context is well over 160k characters.
    for (let i = 0; i < 120; i++) {
      fs.mkdirSync(path.join(dir, "src", `mod${i}`), { recursive: true });
      fs.writeFileSync(path.join(dir, "src", `mod${i}`, "index.js"), "// padding\n".repeat(400));
    }
    const lens = path.join(dir, "lens.txt");
    const once_ = standInClaude(
      dir,
      `fs.appendFileSync(${JSON.stringify(lens)}, input.length + "\\n");
       const tooBig = input.length > 200000;
       console.log(JSON.stringify({ type: "result", is_error: tooBig, result: tooBig ? "Prompt is too long" : ${JSON.stringify(ARCH_DOC)} }));`,
    );
    const r = cli(["build", "--type=architecture"], { cwd: dir, env: { SELFDOCS_CLAUDE_BIN: once_ } });
    assert.equal(r.status, 0, r.stderr);
    const [first, second] = fs.readFileSync(lens, "utf8").trim().split("\n").map(Number);
    assert(first > 300000 && second < first / 2 + 5000, `the retry sends about half: ${first} then ${second}`);
    const doc = JSON.parse(fs.readFileSync(path.join(dir, ".selfdocs", "docs", "architecture.json"), "utf8"));
    const m = generateManifest(dir);
    const { gatherContext } = await import("../src/context.mjs");
    assert.equal(doc.files_analyzed, gatherContext(dir, m, "architecture", 40_000).files.length, "files_analyzed counts the files the retry sent");

    const always = standInClaude(dir, `console.log(JSON.stringify({ type: "result", is_error: true, result: "Prompt is too long" }));`);
    const r2 = cli(["build", "--type=architecture"], { cwd: dir, env: { SELFDOCS_CLAUDE_BIN: always } });
    assert(r2.status === 1 && r2.stderr.includes("too large, even at half") && r2.stderr.includes("--ignore"), r2.stderr);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await t("the scan doesn't follow a symlinked directory or a link that leaves the repo", () => {
  const dir = freshRepo();
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), "selfdocs-outside-"));
  try {
    fs.writeFileSync(path.join(outside, "secret.txt"), "not yours\n");
    fs.symlinkSync("..", path.join(dir, "src", "loop"));
    fs.symlinkSync(path.join(outside, "secret.txt"), path.join(dir, "leak.txt"));
    fs.symlinkSync("package.json", path.join(dir, "pkg-link.json"));
    const { files } = scanDirectory(dir, { ignore: createIgnore(dir) });
    const p = files.map((f) => f.path);
    assert(!p.some((x) => x.startsWith("src/loop")), "a link to a parent is not walked");
    assert(!p.includes("leak.txt"), "a link out of the repo is skipped");
    assert(p.includes("pkg-link.json"), "a link to a file inside the repo counts");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

await t("context skips binary files, finds .mjs, Go and Python entry points, and redacts .env values", async () => {
  const { gatherContext } = await import("../src/context.mjs");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selfdocs-ctx-"));
  try {
    const put = (rel, body) => {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    };
    put("go.mod", "module example.com/app\n\nrequire github.com/gin-gonic/gin v1.9.0\n");
    put("hello.go", "package main\n");
    put("hello_test.go", "package main\n");
    put("users/doc.go", "// Package users ...\npackage users\n");
    put("users/routers.go", "package users\n");
    put("bin/tool.mjs", "#!/usr/bin/env node\n");
    put("src/middleware/model.onnx", Buffer.from([0x08, 0x00, 0x12, 0x00, 0x41]));
    put("config/.env.js", "export API_KEY=abc123\nlower_key = shh\n");
    const m = generateManifest(dir);
    assert.equal(m.markers.framework, "gin", "gin is detected from go.mod");
    const arch = gatherContext(dir, m, "architecture").files.map((f) => f.path);
    for (const want of ["go.mod", "hello.go", "users/doc.go", "bin/tool.mjs"]) assert(arch.includes(want), `architecture reads ${want}: ${arch}`);
    assert(!arch.includes("hello_test.go"), "tests aren't entry points");
    assert(gatherContext(dir, m, "api").files.some((f) => f.path === "users/routers.go"), "routers.go is an API file");
    assert(!gatherContext(dir, m, "api").files.some((f) => f.path.endsWith(".onnx")), "a binary file is never sent");
    const env = gatherContext(dir, m, "integrations").files.find((f) => f.path === "config/.env.js");
    assert(env && !env.content.includes("abc123") && !env.content.includes("shh"), `values redacted: ${env && env.content}`);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await t("a doc whose patterns match nothing reads the entry points and routes, and the prompt says to stay inside them", async () => {
  const { gatherContext } = await import("../src/context.mjs");
  const dir = freshRepo();
  try {
    fs.rmSync(path.join(dir, "src", "workers"), { recursive: true, force: true }); // no workers, queues or jobs left
    const m = generateManifest(dir);
    const ctx = gatherContext(dir, m, "data-flow");
    assert(ctx.fallback, "data-flow fell back");
    const got = ctx.files.map((f) => f.path);
    assert(got.includes("src/index.js") && got.includes("src/routes/users.js"), `entry points and routes: ${got}`);
    assert(/^\s*Dockerfile$|^package\.json$/m.test(ctx.directoryTree) && ctx.directoryTree.includes("users.js"), "the tree lists files, not only directories");

    const seen = path.join(dir, "prompt.txt");
    const bin = standInClaude(dir, `fs.writeFileSync(${JSON.stringify(seen)}, input); console.log(JSON.stringify({ type: "result", is_error: false, result: "# Data Flow Documentation\\n\\n## Overview\\n\\nRequests go to \`src/routes/users.js\`.\\n" }));`);
    const r = cli(["build", "--type=data-flow"], { cwd: dir, env: { SELFDOCS_CLAUDE_BIN: bin } });
    assert.equal(r.status, 0, r.stderr);
    const prompt = fs.readFileSync(seen, "utf8");
    assert(prompt.includes("No file matched what a data-flow doc usually reads"), "the prompt says why these files were sent");
    assert(prompt.trimEnd().endsWith("rather than describing what projects like this usually contain."), "the prompt ends with the grounding rule");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await t("python frameworks are detected from requirements.txt", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "selfdocs-py-"));
  try {
    fs.writeFileSync(path.join(dir, "requirements.txt"), "Flask==3.0\nrequests\n");
    assert.equal(detectProjectType(dir), "python");
    assert.equal(detectFramework(dir, "python"), "flask");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await t("a busy port moves the viewer to the next one and announces it once", async () => {
  const dir = freshFixture();
  const blocker = (await import("node:http")).createServer();
  let server;
  try {
    blocker.listen(0, "127.0.0.1");
    await once(blocker, "listening");
    const busy = blocker.address().port;
    const lines = [];
    const { config, root } = await loadConfig({ cwd: dir });
    server = serve({ config, root, port: busy, open: false, log: (l) => lines.push(l) });
    // Not events.once: that rejects on the first EADDRINUSE, which serve handles by moving up a port.
    await new Promise((r) => server.once("listening", r));
    await new Promise((r) => setTimeout(r, 50));
    assert.equal(server.address().port, busy + 1, "moved one port up");
    assert.equal(lines.filter((l) => l.includes("http://127.0.0.1:")).length, 1, `announced once: ${JSON.stringify(lines)}`);
    assert(lines[0].includes(`:${busy + 1}`), "the announced port is the one it listens on");
  } finally {
    if (server) server.close();
    blocker.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

console.log(`\nselfdocs: ${pass} passed, ${fail} failed\n`);
if (fail > 0) process.exit(1);
