// selfdocs — the build pipeline. Scan the target repo, draft the requested doc
// types (live model or --mock), parse each to anchored blocks, and MERGE them into
// the stored blocks so your annotations survive. Writes everything under
// `.selfdocs/` (manifest + one file per doc). This is the CLI `build` verb's engine.

import { paths } from "./config.mjs";
import { generateManifest } from "./manifest.mjs";
import { generateArchDoc, computeManifestHash } from "./arch-generator.mjs";
import { parseMarkdownToBlocks } from "./block-parser.mjs";
import { mergeBlocks } from "./block-merge.mjs";
import { loadBlocks, saveDocBlocks, saveManifest } from "./store.mjs";
import { C, badge } from "./lib.mjs";

/**
 * @param {object}   o
 * @param {object}   o.config     resolved config
 * @param {string}   o.root       target repo root
 * @param {string[]} o.types      doc types to generate
 * @param {boolean}  [o.mock]     use the deterministic offline generator
 * @param {function} [o.log]      logger (default console.log)
 * @returns {Promise<{ manifest, manifestHash, results: object[] }>}
 */
export async function runBuild({ config, root, types, mock = false, log = console.log }) {
  const P = paths(root);

  log(`${C.d}scanning ${root}…${C.x}`);
  const manifest = generateManifest(root, config.ignore);
  const manifestHash = computeManifestHash(manifest);
  saveManifest(P, { ...manifest, manifest_hash: manifestHash });

  log(
    `${C.d}scanned ${manifest.stats.total_files} files · ${manifest.project_type}` +
      `${manifest.markers.framework ? ` · ${manifest.markers.framework}` : ""}${C.x}`,
  );
  log(
    `${C.b}selfdocs${C.x} — generating ${types.length} doc${types.length === 1 ? "" : "s"} ` +
      `${mock ? `${C.y}(--mock offline)${C.x}` : `via ${C.c}claude${C.x}`}`,
  );

  const results = [];
  for (const docType of types) {
    const t0 = Date.now();
    const result = await generateArchDoc({ projectRoot: root, manifest, docType, model: config.model, mock });

    const newBlocks = parseMarkdownToBlocks(result.content);
    const existing = loadBlocks(P, docType);
    const now = new Date().toISOString();
    const { blocks, report } = mergeBlocks(existing, newBlocks, now);

    saveDocBlocks(P, docType, blocks, {
      generated_at: now,
      manifest_hash: manifestHash,
      model: result.model,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      files_analyzed: result.filesAnalyzed,
      validation: { valid: result.validation.valid, warnings: result.validation.issues.filter((i) => i.severity === "warning").length },
    });

    const ms = Date.now() - t0;
    const userKept = blocks.filter((b) => b.origin === "user").length;
    const mark = result.validation.valid ? badge("ok") : badge("warn");
    log(
      `  ${mark} ${docType.padEnd(13)} ${report.inserted}+ ${report.updated}~ ${report.deleted}- auto · ` +
        `${userKept} note${userKept === 1 ? "" : "s"} kept` +
        `${report.detached ? ` · ${C.y}${report.detached} detached${C.x}` : ""} ` +
        `${C.d}(${result.filesAnalyzed} files, ${ms}ms)${C.x}`,
    );

    results.push({ docType, result, report, blockCount: blocks.length, userKept });
  }

  return { manifest, manifestHash, results };
}
