// selfdocs — file-first storage. The whole persistence layer lives in `.selfdocs/`
// inside the target repo: a `manifest.json` (the latest scan) and one
// `docs/<doc-type>.json` per doc (the block list — auto blocks AND user annotations,
// each with its anchor). No database at all.

import fs from "node:fs";
import { readJson, writeJson } from "./lib.mjs";
import { docTitle } from "./config.mjs";

/** Load the stored scan manifest (or null). */
export function loadManifest(P) {
  return readJson(P.MANIFEST_FILE, null);
}

export function saveManifest(P, manifest) {
  writeJson(P.MANIFEST_FILE, manifest);
}

/**
 * Load a doc file (or null). Shape:
 *   { doc_type, title, generated_at, manifest_hash, model, input_tokens,
 *     output_tokens, files_analyzed, blocks: [...] }
 */
export function loadDoc(P, docType) {
  return readJson(P.docFile(docType), null);
}

export function saveDoc(P, docType, doc) {
  writeJson(P.docFile(docType), doc);
}

/** The stored blocks for a doc (empty array when the doc doesn't exist yet). */
export function loadBlocks(P, docType) {
  const doc = loadDoc(P, docType);
  return doc && Array.isArray(doc.blocks) ? doc.blocks : [];
}

/** Persist a fresh block list for a doc, carrying generation metadata. */
export function saveDocBlocks(P, docType, blocks, meta = {}) {
  const existing = loadDoc(P, docType) || {};
  const doc = {
    doc_type: docType,
    title: docTitle(docType),
    generated_at: meta.generated_at ?? existing.generated_at ?? null,
    manifest_hash: meta.manifest_hash ?? existing.manifest_hash ?? null,
    model: meta.model ?? existing.model ?? null,
    input_tokens: meta.input_tokens ?? existing.input_tokens ?? 0,
    output_tokens: meta.output_tokens ?? existing.output_tokens ?? 0,
    files_analyzed: meta.files_analyzed ?? existing.files_analyzed ?? 0,
    validation: meta.validation ?? existing.validation ?? null,
    blocks,
  };
  saveDoc(P, docType, doc);
  return doc;
}

/** A compact summary of a doc for `status` / the viewer sidebar. */
export function docSummary(doc) {
  if (!doc || !Array.isArray(doc.blocks)) {
    return { generated: false, autoCount: 0, userCount: 0, detachedCount: 0, generated_at: null };
  }
  const auto = doc.blocks.filter((b) => b.origin === "auto");
  const user = doc.blocks.filter((b) => b.origin === "user");
  const detached = user.filter((b) => b.detached === 1);
  return {
    generated: auto.length > 0 || user.length > 0,
    autoCount: auto.length,
    userCount: user.length,
    detachedCount: detached.length,
    generated_at: doc.generated_at ?? null,
    model: doc.model ?? null,
  };
}

/** True if `.selfdocs/` has anything in it. */
export function hasOutput(P) {
  return fs.existsSync(P.OUT_DIR);
}
