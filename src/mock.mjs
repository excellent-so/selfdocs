// selfdocs — the deterministic OFFLINE generator. This is the `--mock` brain: it
// drafts each doc type from the scan manifest alone, no `claude` CLI, no network, no
// key. With it, the whole tool (and the test suite) runs with nothing else installed.
//
// Output is intentionally honest about being a scaffold ("generated offline by
// --mock"), but it's grounded in REAL scanned facts — the project type, framework,
// package manager, directory layout, and representative files — so the anchored
// blocks it produces are stable across runs (the annotation-survival invariant holds
// under mock exactly as it does under a live model).

const EXT_LANGUAGE = {
  ts: "TypeScript", tsx: "TypeScript (React)", js: "JavaScript", jsx: "JavaScript (React)",
  mjs: "JavaScript (ESM)", cjs: "JavaScript (CommonJS)", py: "Python", go: "Go", rs: "Rust",
  java: "Java", kt: "Kotlin", rb: "Ruby", php: "PHP", cs: "C#", c: "C", cpp: "C++",
  swift: "Swift", vue: "Vue", svelte: "Svelte", css: "CSS", scss: "SCSS", html: "HTML", sql: "SQL",
};

function basename(p) {
  return String(p).split("/").pop() || String(p);
}

/** Directory → file-count, most-populated first. */
function topDirs(manifest, limit = 6) {
  const counts = new Map();
  for (const f of manifest.files) {
    const seg = f.path.includes("/") ? f.path.split("/")[0] : "(root)";
    counts.set(seg, (counts.get(seg) || 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, limit);
}

/** The dominant source language, inferred from extensions. */
function primaryLanguage(manifest) {
  const counts = new Map();
  for (const f of manifest.files) {
    if (f.type !== "source") continue;
    const ext = (f.path.split(".").pop() || "").toLowerCase();
    if (EXT_LANGUAGE[ext]) counts.set(ext, (counts.get(ext) || 0) + 1);
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? EXT_LANGUAGE[top[0]] : null;
}

function filesMatching(manifest, re, limit = 8) {
  return manifest.files.filter((f) => re.test(f.path)).slice(0, limit).map((f) => f.path);
}

function bulletList(items) {
  return items.length ? items.map((i) => `- ${i}`).join("\n") : "- (none found in the scan)";
}

function projectFacts(manifest) {
  return {
    name: basename(manifest.project_root),
    type: manifest.project_type || "unknown",
    framework: manifest.markers.framework,
    pm: manifest.markers.package_manager,
    test: manifest.markers.test_framework,
    ci: manifest.markers.ci || [],
    lang: primaryLanguage(manifest),
    fileCount: manifest.stats.total_files,
    dirCount: manifest.stats.total_dirs,
  };
}

const NOTE = "> Drafted offline by `selfdocs build --mock` from the file scan alone (no model). Regenerate with a connected `claude` CLI for prose grounded in the code.";

function architecture(manifest) {
  const f = projectFacts(manifest);
  const dirs = topDirs(manifest);
  const entries = filesMatching(manifest, /(^|\/)(main|index|app|server|cli)\.(ts|tsx|js|mjs|cjs|py|go|rs|rb)$/i, 6);

  const stackRows = [
    ["Language", f.lang || "unclear from the provided code"],
    ["Project type", f.type],
    ["Framework", f.framework || "none detected"],
    ["Package manager", f.pm || "n/a"],
    ["Test framework", f.test || "none detected"],
    ["CI", f.ci.length ? f.ci.join(", ") : "none detected"],
  ];

  return [
    "# Architecture Overview",
    "",
    NOTE,
    "",
    "## System Overview",
    "",
    `\`${f.name}\` is a ${f.type} project${f.framework ? ` built on \`${f.framework}\`` : ""}. The scan found ${f.fileCount} files across ${f.dirCount} directories, with the bulk of the source under ${dirs.slice(0, 3).map(([d]) => `\`${d}/\``).join(", ") || "the repository root"}.`,
    "",
    "This overview is a scaffold: it names what the scanner can see. Once you connect a model, selfdocs replaces these paragraphs with prose grounded in the actual code, and your own notes stay attached.",
    "",
    "## Technology Stack",
    "",
    "| Layer | Technology |",
    "| --- | --- |",
    ...stackRows.map(([k, v]) => `| ${k} | ${v} |`),
    "",
    "## System Components",
    "",
    ...dirs.flatMap(([dir, count]) => [
      `### \`${dir}\``,
      "",
      `${count} ${count === 1 ? "file lives" : "files live"} under \`${dir}\`. Its responsibility is inferred from its name and contents; verify against the code before relying on it.`,
      "",
    ]),
    "## Key Design Patterns",
    "",
    "Patterns are not inferred in offline mode. Connect a model to have selfdocs identify the architectural patterns actually used (plugin registries, event-driven flows, contract-first APIs, and so on).",
    "",
    "## Entry Points",
    "",
    bulletList(entries.map((e) => `\`${e}\``)),
    "",
    "## Build & Deploy",
    "",
    "The canonical dev sequence, inferred from the detected package manager:",
    "",
    "```sh",
    ...(f.pm === "npm" || f.pm === "pnpm" || f.pm === "yarn" || f.pm === "bun"
      ? [`${f.pm} install`, `${f.pm} run dev`]
      : f.pm === "pip"
        ? ["pip install -r requirements.txt"]
        : f.pm === "cargo"
          ? ["cargo build", "cargo run"]
          : f.pm === "go"
            ? ["go build ./...", "go run ."]
            : ["# install dependencies", "# run the project"]),
    "```",
    "",
  ].join("\n");
}

function schema(manifest) {
  const f = projectFacts(manifest);
  const models = filesMatching(manifest, /(models?|schema|entities|migrations?)\b/i, 10);

  return [
    "# Database Schema",
    "",
    NOTE,
    "",
    "## Overview",
    "",
    `No schema engine is inferred in offline mode. The scanner flagged ${models.length} file${models.length === 1 ? "" : "s"} whose path suggests data modeling (models, schema, entities, or migrations). Connect a model to have selfdocs read them and describe the real tables.`,
    "",
    "## Tables / Models",
    "",
    "Candidate schema files found by the scan:",
    "",
    "| File | Kind |",
    "| --- | --- |",
    ...(models.length
      ? models.map((m) => `| \`${m}\` | ${/migrat/i.test(m) ? "migration" : "model / schema"} |`)
      : ["| (none found) | — |"]),
    "",
    "### Notes",
    "",
    "This section is a placeholder. A live regeneration replaces it with one H3 per table, each with a column table and a purpose paragraph.",
    "",
    "## Relationships",
    "",
    "Relationships are not inferred offline. Connect a model to map the foreign keys.",
    "",
    "## Migrations",
    "",
    filesMatching(manifest, /migrat/i, 6).length
      ? bulletList(filesMatching(manifest, /migrat/i, 6).map((m) => `\`${m}\``))
      : "No migration files were detected in the scan.",
    "",
  ].join("\n");
}

function api(manifest) {
  const routes = filesMatching(manifest, /(routes?|router|controllers?|handlers?|\/api\/)/i, 12);

  return [
    "# API Reference",
    "",
    NOTE,
    "",
    "## Overview",
    "",
    `The scan flagged ${routes.length} file${routes.length === 1 ? "" : "s"} whose path suggests an API surface (routes, routers, controllers, handlers, or an \`api/\` directory). The API style (REST, GraphQL, RPC, MCP) is not inferred offline.`,
    "",
    "## Authentication",
    "",
    "Authentication is not inferred offline. Connect a model to describe how requests are authenticated.",
    "",
    "## Endpoints",
    "",
    "Candidate endpoint files found by the scan:",
    "",
    bulletList(routes.map((r) => `\`${r}\``)),
    "",
    "## Error Handling",
    "",
    "Not inferred offline.",
    "",
    "## Rate Limiting / Middleware",
    "",
    "Not inferred offline.",
    "",
  ].join("\n");
}

function dataFlow(manifest) {
  const workers = filesMatching(manifest, /(workers?|tasks?|queue|pipeline|jobs?|events?|cron)/i, 12);

  return [
    "# Data Flow Documentation",
    "",
    NOTE,
    "",
    "## Overview",
    "",
    `The scan flagged ${workers.length} file${workers.length === 1 ? "" : "s"} whose path suggests background processing (workers, tasks, queues, pipelines, jobs, events, or cron). How data actually moves between them is not inferred offline.`,
    "",
    "## Ingestion / Input",
    "",
    "Not inferred offline.",
    "",
    "## Processing Pipelines",
    "",
    "Candidate pipeline files found by the scan:",
    "",
    bulletList(workers.map((w) => `\`${w}\``)),
    "",
    "## Data Transformations",
    "",
    "Not inferred offline.",
    "",
    "## Output / Storage",
    "",
    "Not inferred offline.",
    "",
    "## Scheduling / Cron",
    "",
    filesMatching(manifest, /cron|schedule/i, 6).length
      ? bulletList(filesMatching(manifest, /cron|schedule/i, 6).map((c) => `\`${c}\``))
      : "No scheduled-job files were detected in the scan.",
    "",
  ].join("\n");
}

function integrations(manifest) {
  const f = projectFacts(manifest);
  const envExamples = filesMatching(manifest, /\.env(\.example|\.sample)?$/i, 6);
  const configs = filesMatching(manifest, /(integrations?|config)\b/i, 8);

  return [
    "# Integrations Guide",
    "",
    NOTE,
    "",
    "## Overview",
    "",
    `External services are not inferred offline. The scan found ${envExamples.length} env template${envExamples.length === 1 ? "" : "s"} and ${configs.length} config/integration file${configs.length === 1 ? "" : "s"} that a live regeneration would read to enumerate the real integrations.`,
    "",
    "## External Services",
    "",
    "Candidate integration/config files found by the scan:",
    "",
    bulletList(configs.map((c) => `\`${c}\``)),
    "",
    "## Authentication Providers",
    "",
    "Not inferred offline.",
    "",
    "## Infrastructure",
    "",
    `Package manager: \`${f.pm || "n/a"}\`. CI: ${f.ci.length ? f.ci.map((c) => `\`${c}\``).join(", ") : "none detected"}.`,
    "",
    "## Environment Variables",
    "",
    "| Variable | Required | Default | Used by |",
    "| --- | --- | --- | --- |",
    "| (none inferred offline) | — | — | — |",
    "",
    envExamples.length ? `Env templates detected: ${envExamples.map((e) => `\`${e}\``).join(", ")}.` : "No env templates were detected in the scan.",
    "",
  ].join("\n");
}

const GENERATORS = { architecture, schema, api, "data-flow": dataFlow, integrations };

/**
 * Deterministically draft one doc type from the manifest.
 * @param {object} manifest
 * @param {string} docType
 * @returns {string} markdown
 */
export function mockGenerate(manifest, docType) {
  const gen = GENERATORS[docType];
  if (!gen) throw new Error(`unknown doc type: ${docType}`);
  return gen(manifest);
}
