// selfdocs — manifest → LLM prompt payload. Selects the files most relevant to each
// doc type, budgets them by an estimated token ceiling, redacts `.env` values, and
// formats the whole thing as one markdown context block for the model.

import { readFileSync } from "node:fs";
import { join } from "node:path";

const CHARS_PER_TOKEN = 4;
const DEFAULT_MAX_TOKENS = 80_000;
const MAX_FILE_SIZE = 50_000;

const FILE_PATTERNS = {
  architecture: {
    primary: [
      /^README/i,
      /^package\.json$/,
      /^pyproject\.toml$/,
      /^Cargo\.toml$/,
      /^go\.mod$/,
      /^Gemfile$/,
      /^pom\.xml$/,
      /^(src|app|lib)\/(main|index|app|server)\.(ts|js|py|go|rs|rb)$/,
      /(src|app|lib)\/.*\/(main|index|app)\.(ts|js|py|go|rs|rb)$/,
    ],
    secondary: [
      /^tsconfig.*\.json$/,
      /^Dockerfile/,
      /^docker-compose/,
      /\.gitlab-ci/,
      /\.github\/workflows/,
      /Makefile$/,
    ],
  },
  schema: {
    primary: [
      /models?\.(ts|js|py|go|rs|rb)$/,
      /\/(models|entities|schema)\/.*\.(ts|js|py|go|rs|rb)$/,
      /\.prisma$/,
      /schema\.(ts|js|py|sql|graphql)$/,
      /migrations?\.(ts|js)$/,
    ],
    secondary: [/\/(migrations|alembic)\//],
  },
  api: {
    primary: [
      /\/(routes|router|controllers|api|handlers)\/.*\.(ts|js|py|go|rs|rb)$/,
      /(routes|router|controllers|handlers)\.(ts|js|py|go|rs|rb)$/,
      /\/api\/.*\/route\.(ts|js)$/,
    ],
    secondary: [/middleware/, /auth\.(ts|js|py|go|rs|rb)$/, /\/(auth|middleware)\//],
  },
  "data-flow": {
    primary: [
      /\/(workers|tasks|queue|pipeline|jobs|events|cron)\/.*\.(ts|js|py|go|rs|rb)$/,
      /(worker|task|queue|pipeline|job|event)\.(ts|js|py|go|rs|rb)$/,
    ],
    secondary: [
      /\/(schedulers?|processors?)\/.*\.(ts|js|py|go|rs|rb)$/,
      /cron/,
      /docker-compose/,
    ],
  },
  integrations: {
    primary: [
      /\.env\.example$/,
      /\.env\.sample$/,
      /\/(integrations|config)\/.*\.(ts|js|py|go|rs|rb)$/,
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

export function gatherContext(projectRoot, manifest, docType, maxTokens = DEFAULT_MAX_TOKENS) {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  const patterns = FILE_PATTERNS[docType];
  const files = [];
  let totalChars = 0;

  const directoryTree = buildDirectoryTree(manifest);
  totalChars += directoryTree.length;

  const primaryFiles = [];
  const secondaryFiles = [];
  const migrationFiles = [];

  for (const file of manifest.files) {
    if (file.type === "binary") continue;
    const isPrimary = patterns.primary.some((p) => p.test(file.path));
    const isSecondary = patterns.secondary.some((p) => p.test(file.path));
    const isMigration = /\/(migrations|alembic)\//.test(file.path);

    if (isPrimary) primaryFiles.push(file);
    else if (isMigration && docType === "schema") migrationFiles.push(file);
    else if (isSecondary) secondaryFiles.push(file);
  }

  primaryFiles.sort((a, b) => a.path.localeCompare(b.path));
  secondaryFiles.sort((a, b) => a.path.localeCompare(b.path));
  migrationFiles.sort((a, b) => b.path.localeCompare(a.path));
  const recentMigrations = migrationFiles.slice(0, 3);

  const orderedFiles = [...primaryFiles, ...recentMigrations, ...secondaryFiles];

  for (const file of orderedFiles) {
    if (totalChars >= maxChars) break;
    const content = readFileContent(projectRoot, file.path);
    if (content === null) continue;
    const processed = processContent(file.path, content, maxChars - totalChars);
    files.push({ path: file.path, content: processed });
    totalChars += processed.length;
  }

  return {
    files,
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

function readFileContent(projectRoot, relativePath) {
  try {
    return readFileSync(join(projectRoot, relativePath), "utf-8");
  } catch {
    return null;
  }
}

function processContent(filePath, content, remainingChars) {
  let processed = content;

  if (/\.env/.test(filePath) && !/\.example$/.test(filePath) && !/\.sample$/.test(filePath)) {
    processed = processed.replace(/^([A-Z_][A-Z0-9_]*)=(.+)$/gm, "$1=<redacted>");
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

  const sortedDirs = [...dirs].sort();
  const lines = ["Directory Structure:", ""];
  for (const dir of sortedDirs) {
    const depth = dir.split("/").length - 1;
    if (depth <= 2) {
      const indent = "  ".repeat(depth - 1);
      const name = dir.split("/").slice(-2, -1)[0];
      lines.push(`${indent}${name}/`);
    }
  }
  return lines.join("\n");
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
