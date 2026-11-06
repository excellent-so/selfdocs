// selfdocs — manifest → LLM prompt payload. Selects the files most relevant to each
// doc type, budgets them by an estimated token ceiling, skips files that look binary,
// redacts `.env` values, and formats the whole thing as one markdown context block for
// the model.

import { openSync, readSync, closeSync, readFileSync } from "node:fs";
import { join } from "node:path";

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 80_000;
const MAX_FILE_SIZE = 50_000;
// The directory tree sent with every doc: as deep as fits in this many lines.
const TREE_MAX_LINES = 300;
const TREE_MAX_DEPTH = 4;

// The source extensions the patterns below accept.
const SRC = "(?:ts|tsx|js|jsx|mjs|cjs|py|go|rs|rb|java|kt|php|cs)";
const src = (body, flags = "") => new RegExp(body.replaceAll("SRC", SRC), flags);

const FILE_PATTERNS = {
  architecture: {
    primary: [
      /^README/i,
      /^package\.json$/,
      /^pyproject\.toml$/,
      /^setup\.py$/,
      /^Cargo\.toml$/,
      /^go\.mod$/,
      /^Gemfile$/,
      /^pom\.xml$/,
      // Entry points: at the root, under src/app/lib, in a Go cmd/ tree, or a Python __main__.
      src("^(main|index|app|server|cli|manage|wsgi|asgi)\\.SRC$"),
      src("^(src|app|lib)\\/(main|index|app|server|cli)\\.SRC$"),
      src("(src|app|lib)\\/.*\\/(main|index|app)\\.SRC$"),
      /^cmd\/[^/]+\/main\.go$/,
      /(^|\/)__main__\.py$/,
    ],
    secondary: [
      /^tsconfig.*\.json$/,
      /^Dockerfile/,
      /^docker-compose/,
      /\.gitlab-ci/,
      /\.github\/workflows/,
      /Makefile$/,
      // The rest of the root package in Go, and Go's package comments.
      /^[^/]+(?<!_test)\.go$/,
      /(^|\/)doc\.go$/,
      // Executables, and the modules at the top of src/.
      src("^bin\\/[^/]+(\\.SRC)?$"),
      src("^src\\/[^/]+\\.SRC$"),
    ],
  },
  schema: {
    primary: [
      src("models?\\.SRC$"),
      src("(^|\\/)(models|entities|schema)\\/.*\\.SRC$"),
      /\.prisma$/,
      /schema\.(ts|js|mjs|py|sql|graphql)$/,
      src("migrations?\\.SRC$"),
    ],
    secondary: [/(^|\/)(migrations|alembic)\//],
  },
  api: {
    primary: [
      src("(^|\\/)(routes|routers?|controllers|api|handlers|endpoints|views)\\/.*\\.SRC$"),
      src("(^|[/._-])(routes?|routers?|controllers?|handlers?|endpoints?|views|urls)\\.SRC$"),
      /\/api\/.*\/route\.(ts|js)$/,
    ],
    secondary: [/middleware/, src("auth\\.SRC$"), /(^|\/)(auth|middleware)\//],
  },
  "data-flow": {
    primary: [
      src("(^|\\/)(workers|tasks|queue|pipeline|jobs|events|cron)\\/.*\\.SRC$"),
      src("(worker|task|queue|pipeline|job|event)s?\\.SRC$"),
    ],
    secondary: [
      src("(^|\\/)(schedulers?|processors?)\\/.*\\.SRC$"),
      /cron/,
      /docker-compose/,
    ],
  },
  integrations: {
    primary: [
      /\.env\.example$/,
      /\.env\.sample$/,
      src("(^|\\/)(integrations|config)\\/.*\\.SRC$"),
    ],
    secondary: [
      /^package\.json$/,
      /^pyproject\.toml$/,
      /^Cargo\.toml$/,
      /^go\.mod$/,
      /^Gemfile$/,
      /docker-compose/,
      /\.gitlab-ci/,
      /\.github\/workflows/,
    ],
  },
};

// When a doc type's own patterns find no readable file, it reads what these doc types read instead: entry
// points, then the API surface, then the data model. With no code at all, a model drafts from what projects
// like this usually contain, and names files that don't exist.
const FALLBACK_TYPES = ["architecture", "api", "schema"];

export function gatherContext(projectRoot, manifest, docType, maxTokens = DEFAULT_MAX_TOKENS) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const directoryTree = buildDirectoryTree(manifest);

  const read = (ordered) => {
    const files = [];
    let totalChars = directoryTree.length;
    for (const file of ordered) {
      if (totalChars >= maxChars) break;
      const content = readFileContent(projectRoot, file.path);
      if (content === null) continue;
      const processed = processContent(file.path, content, maxChars - totalChars);
      files.push({ path: file.path, content: processed });
      totalChars += processed.length;
    }
    return { files, totalChars };
  };

  let { files, totalChars } = read(selectFiles(manifest, docType));
  let fallback = false;
  if (files.length === 0 && docType !== "architecture") {
    const seen = new Set();
    const ordered = FALLBACK_TYPES.filter((t) => t !== docType)
      .flatMap((t) => selectFiles(manifest, t, { primaryOnly: true }))
      .filter((f) => !seen.has(f.path) && seen.add(f.path));
    ({ files, totalChars } = read(ordered));
    fallback = files.length > 0;
  }

  return {
    files,
    fallback,
    projectInfo: {
      name: manifest.project_root.split("/").pop() || "project",
      type: manifest.project_type,
      framework: manifest.markers.framework,
      packageManager: manifest.markers.package_manager,
      fileCount: manifest.stats.total_files,
    },
    directoryTree,
    tokenEstimate: Math.ceil(totalChars / CHARS_PER_TOKEN),
  };
}

/** The files a doc type reads, best matches first: primary patterns, then (for schema) recent migrations, then secondary. */
function selectFiles(manifest, docType, { primaryOnly = false } = {}) {
  const patterns = FILE_PATTERNS[docType];
  const primaryFiles = [];
  const secondaryFiles = [];
  const migrationFiles = [];

  for (const file of manifest.files) {
    if (file.type === "binary") continue;
    const isPrimary = patterns.primary.some((p) => p.test(file.path));
    const isSecondary = patterns.secondary.some((p) => p.test(file.path));
    const isMigration = /(^|\/)(migrations|alembic)\//.test(file.path);

    if (isPrimary) primaryFiles.push(file);
    else if (isMigration && docType === "schema") migrationFiles.push(file);
    else if (isSecondary) secondaryFiles.push(file);
  }

  primaryFiles.sort((a, b) => a.path.localeCompare(b.path));
  if (primaryOnly) return primaryFiles;
  secondaryFiles.sort((a, b) => a.path.localeCompare(b.path));
  migrationFiles.sort((a, b) => b.path.localeCompare(a.path));
  return [...primaryFiles, ...migrationFiles.slice(0, 3), ...secondaryFiles];
}

/** True when the file's first 8 KB hold a NUL byte: binary, whatever its extension says. */
function looksBinary(file) {
  let fd;
  try {
    fd = openSync(file, "r");
    const buf = Buffer.alloc(8192);
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } catch {
    return true;
  } finally {
    if (fd !== undefined) closeSync(fd);
  }
}

function readFileContent(projectRoot, relativePath) {
  const file = join(projectRoot, relativePath);
  if (looksBinary(file)) return null;
  try {
    return readFileSync(file, "utf-8");
  } catch {
    return null;
  }
}

function processContent(filePath, content, remainingChars) {
  let processed = content;

  if (/(^|\/)\.env/.test(filePath) && !/\.(example|sample)$/.test(filePath)) {
    // KEY=value, `export KEY=value` and `KEY: value`, any case: keep the name, drop the value.
    processed = processed.replace(/^(\s*(?:export\s+)?[A-Za-z_][A-Za-z0-9_.-]*\s*[=:]\s*)(\S.*)$/gm, "$1<redacted>");
  }

  const limit = Math.min(MAX_FILE_SIZE, remainingChars);
  if (processed.length > limit) {
    const remaining = processed.length - limit;
    processed = processed.slice(0, limit) + `\n[... truncated, ${remaining} bytes remaining ...]`;
  }
  return processed;
}

function buildDirectoryTree(manifest) {
  const dirs = new Set();
  for (const file of manifest.files) {
    const parts = file.path.split("/");
    for (let i = 1; i < parts.length; i++) {
      dirs.add(parts.slice(0, i).join("/") + "/");
    }
  }
  const depthOf = (p) => p.replace(/\/$/, "").split("/").length;
  const render = (entries, note) => {
    const lines = ["Files and directories:", ""];
    for (const e of entries.slice(0, TREE_MAX_LINES)) {
      const name = e.endsWith("/") ? e.split("/").slice(-2, -1)[0] + "/" : e.split("/").pop();
      lines.push(`${"  ".repeat(depthOf(e) - 1)}${name}`);
    }
    if (entries.length > TREE_MAX_LINES) lines.push(`… and ${entries.length - TREE_MAX_LINES} more`);
    if (note) lines.push("", note);
    return lines.join("\n");
  };

  // Every file and directory, when that fits: then the model knows what isn't there, too.
  const all = [...dirs, ...manifest.files.map((f) => f.path)].sort();
  if (all.length <= TREE_MAX_LINES) return render(all);

  // Otherwise the directories, as deep as fits up to TREE_MAX_DEPTH, and the files at the top of the repo.
  const rootFiles = manifest.files.map((f) => f.path).filter((p) => !p.includes("/"));
  let maxDepth = 1;
  for (let d = 2; d <= TREE_MAX_DEPTH; d++) {
    if ([...dirs].filter((dir) => depthOf(dir) <= d).length + rootFiles.length > TREE_MAX_LINES) break;
    maxDepth = d;
  }
  const shown = [...[...dirs].filter((dir) => depthOf(dir) <= maxDepth), ...rootFiles].sort();
  return render(shown, `(${manifest.files.length} files in all: only the top-level files and the directories down to depth ${maxDepth} are listed.)`);
}

export function formatContextForLLM(ctx) {
  const sections = [];
  sections.push(`# Project: ${ctx.projectInfo.name}`);
  sections.push(`Type: ${ctx.projectInfo.type || "unknown"}`);
  if (ctx.projectInfo.framework) sections.push(`Framework: ${ctx.projectInfo.framework}`);
  if (ctx.projectInfo.packageManager) sections.push(`Package Manager: ${ctx.projectInfo.packageManager}`);
  sections.push(`Total Files: ${ctx.projectInfo.fileCount}`);
  sections.push("");
  sections.push(ctx.directoryTree);
  sections.push("");
  sections.push("---");
  sections.push("# File Contents");
  sections.push("");
  for (const file of ctx.files) {
    sections.push(`## ${file.path}`);
    sections.push("```");
    sections.push(file.content);
    sections.push("```");
    sections.push("");
  }
  return sections.join("\n");
}
