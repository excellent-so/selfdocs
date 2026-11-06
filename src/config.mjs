// selfdocs — config: discover, load, and normalize `selfdocs.config.*`, and
// resolve every path under the target repo's `.selfdocs/` directory.
//
// Zero-config is the headline: point selfdocs at any repo and it works with no
// config at all. The config file only exists to narrow the target, add ignore
// rules, or restrict which doc types are generated — every key degrades to a
// sensible default when absent.

import fs from "node:fs";
import path from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";

/** The five fixed doc types, in display order. */
export const DOC_TYPES = ["architecture", "schema", "api", "data-flow", "integrations"];

export const DOC_TITLES = {
  architecture: "Architecture Overview",
  schema: "Database Schema",
  api: "API Reference",
  "data-flow": "Data Flow",
  integrations: "Integrations Guide",
};

export function docTitle(docType) {
  return DOC_TITLES[docType] || docType;
}

const CONFIG_NAMES = [
  "selfdocs.config.mjs",
  "selfdocs.config.js",
  "selfdocs.config.cjs",
  "selfdocs.config.json",
];

/** The zero-config defaults. */
export function defaults() {
  return {
    // The repo to document. Relative to the config file's dir (or cwd). Default:
    // the config dir, else the current working directory.
    target: null,
    // Extra .gitignore-style patterns to exclude from the scan (on top of the
    // built-in defaults + the target's own .gitignore).
    ignore: [],
    // Which doc types to generate. Default: all five.
    docTypes: DOC_TYPES.slice(),
    // The model passed to the `claude` CLI (ignored in --mock mode).
    model: null,
  };
}

/** Find the nearest config file walking up from `startDir`. Returns { file, dir } | null. */
export function findConfig(startDir = process.cwd()) {
  let dir = path.resolve(startDir);
  for (;;) {
    for (const name of CONFIG_NAMES) {
      const file = path.join(dir, name);
      if (fs.existsSync(file)) return { file, dir };
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
}

async function loadRaw(file) {
  if (file.endsWith(".json")) return JSON.parse(fs.readFileSync(file, "utf8"));
  const mod = await import(pathToFileURL(file).href);
  return mod.default ?? mod;
}

/**
 * Resolve the effective config + target root. Merges (defaults ← file ←
 * overrides), resolves the target repo, and normalizes shapes.
 *
 * @param {object} [o]
 * @param {string} [o.cwd]        where to start looking (default process.cwd())
 * @param {object} [o.overrides]  CLI-supplied overrides (highest precedence)
 * @returns {Promise<{ config, root, file }>}
 */
export async function loadConfig({ cwd = process.cwd(), overrides = {} } = {}) {
  const found = findConfig(cwd);
  const configDir = found ? found.dir : path.resolve(cwd);
  const base = defaults();
  const fromFile = found ? await loadRaw(found.file) : {};
  const merged = { ...base, ...fromFile, ...overrides };

  // SELFDOCS_TARGET env escape hatch (overrides win over it).
  if (!overrides.target && process.env.SELFDOCS_TARGET) merged.target = process.env.SELFDOCS_TARGET;

  // Resolve the target repo root: an explicit target (relative to the config
  // dir), else the config dir, else cwd.
  const root = merged.target
    ? path.resolve(configDir, String(merged.target))
    : configDir;

  // Normalize shapes so the engine never branches on config form.
  merged.ignore = Array.isArray(merged.ignore) ? merged.ignore.filter((p) => typeof p === "string" && p) : [];
  merged.docTypes = normalizeDocTypes(merged.docTypes);
  merged.model = merged.model ? String(merged.model) : null;

  return { config: merged, root, file: found ? found.file : null };
}

function normalizeDocTypes(list) {
  const arr = Array.isArray(list) ? list : [list];
  const valid = arr.filter((t) => DOC_TYPES.includes(t));
  return valid.length ? valid : DOC_TYPES.slice();
}

/** Every path under the target repo's `.selfdocs/` output directory. */
export function paths(root) {
  const OUT_DIR = path.join(root, ".selfdocs");
  const DOCS_DIR = path.join(OUT_DIR, "docs");
  return {
    OUT_DIR,
    DOCS_DIR,
    MANIFEST_FILE: path.join(OUT_DIR, "manifest.json"),
    docFile: (docType) => path.join(DOCS_DIR, `${docType}.json`),
    VIEWER_DIR: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "viewer"),
  };
}
