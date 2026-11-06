// selfdocs — CLI: parses the verb and its flags and runs it (npx @excellent-so/selfdocs …).
// Verbs: build · serve · open · status · doctor · init · help.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, paths, DOC_TYPES, docTitle } from "./config.mjs";
import { C, badge } from "./lib.mjs";
import { DEFAULT_MODEL } from "./llm.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The project page the scaffolded config points at. Read from package.json so the two never disagree.
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));

function parseFlags(argv) {
  const f = {};
  const positionals = [];
  for (const a of argv) {
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (m) f[m[1]] = m[2] === undefined ? true : m[2];
    else positionals.push(a);
  }
  return { f, positionals };
}

function overridesFromFlags(f) {
  const o = {};
  if (f.target) o.target = String(f.target);
  if (f.ignore) o.ignore = String(f.ignore).split(",").map((s) => s.trim()).filter(Boolean);
  if (f.model) o.model = String(f.model);
  return o;
}

async function setup(f) {
  return loadConfig({ overrides: overridesFromFlags(f) });
}

/** Which doc types this invocation targets: --type=X (repeatable via comma) or config. */
function resolveTypes(f, config) {
  if (f.type) {
    const asked = String(f.type).split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = asked.filter((t) => !DOC_TYPES.includes(t));
    if (unknown.length) {
      console.error(`Unknown doc type(s): ${unknown.join(", ")}. Known: ${DOC_TYPES.join(", ")}.`);
      process.exit(1);
    }
    return asked;
  }
  return config.docTypes;
}

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);
  const { f } = parseFlags(rest);

  switch (cmd) {
    case "build": {
      const { config, root } = await setup(f);
      const types = resolveTypes(f, config);
      const mock = Boolean(f.mock);

      if (!mock) {
        const { isClaudeCliAvailable } = await import("./llm.mjs");
        if (!(await isClaudeCliAvailable())) {
          console.error(
            `${C.r}selfdocs:${C.x} the \`claude\` CLI was not found on your PATH.\n\n` +
              `  Generation drives the local Claude CLI. Install it and sign in, or run\n` +
              `  offline with the deterministic generator:\n\n` +
              `    ${C.c}selfdocs build --mock${C.x}\n\n` +
              `  (Point at a specific binary with SELFDOCS_CLAUDE_BIN.)`,
          );
          process.exit(1);
        }
      }

      const { runBuild } = await import("./build.mjs");
      try {
        const { results } = await runBuild({ config, root, types, mock });
        const P = paths(root);
        console.log(
          `\n${badge("ok")} wrote ${results.length} doc${results.length === 1 ? "" : "s"} to ${C.d}${path.relative(process.cwd(), P.DOCS_DIR) || P.DOCS_DIR}${C.x}` +
            `\n  view them: ${C.c}selfdocs open${C.x}`,
        );
      } catch (e) {
        if (e?.name === "ClaudeCliMissingError") {
          console.error(`\n${C.r}selfdocs:${C.x} ${e.message}`);
          process.exit(1);
        }
        throw e;
      }
      break;
    }

    case "serve":
    case "open": {
      const { config, root } = await setup(f);
      const { serve } = await import("./serve.mjs");
      serve({ config, root, port: f.port, open: cmd === "open" });
      break;
    }

    case "status": {
      const { config, root } = await setup(f);
      await cmdStatus(config, root);
      break;
    }

    case "doctor": {
      const { config, root, file } = await setup(f);
      await cmdDoctor(config, root, file);
      break;
    }

    case "init": {
      const target = path.join(process.cwd(), "selfdocs.config.mjs");
      if (fs.existsSync(target) && !f.force) {
        console.error(`${target} already exists (pass --force to overwrite).`);
        process.exit(1);
      }
      fs.writeFileSync(target, scaffoldConfig());
      console.log(`${badge("ok")} wrote ${path.relative(process.cwd(), target)}\n  Edit it, then run: ${C.c}selfdocs build${C.x}`);
      break;
    }

    default:
      printHelp();
  }
}

async function cmdStatus(config, root) {
  const { loadManifest, loadDoc, docSummary } = await import("./store.mjs");
  const P = paths(root);
  const manifest = loadManifest(P);

  console.log(`${C.b}selfdocs status${C.x}`);
  console.log(`  target:   ${root}`);
  if (manifest) {
    console.log(
      `  scanned:  ${manifest.stats.total_files} files · ${manifest.project_type}` +
        `${manifest.markers.framework ? ` · ${manifest.markers.framework}` : ""} ${C.d}(${manifest.generated_at})${C.x}`,
    );
  } else {
    console.log(`  scanned:  ${C.d}never — run \`selfdocs build\`${C.x}`);
  }
  console.log("");

  let totalNotes = 0;
  for (const docType of DOC_TYPES) {
    const doc = loadDoc(P, docType);
    const s = docSummary(doc);
    totalNotes += s.userCount;
    const mark = s.generated ? badge("ok") : badge("empty");
    const detail = s.generated
      ? `${s.autoCount} block${s.autoCount === 1 ? "" : "s"} · ${s.userCount} note${s.userCount === 1 ? "" : "s"}` +
        `${s.detachedCount ? ` · ${C.y}${s.detachedCount} detached${C.x}` : ""} ${C.d}(${s.model || "?"})${C.x}`
      : `${C.d}not generated${C.x}`;
    console.log(`  ${mark} ${docTitle(docType).padEnd(22)} ${detail}`);
  }
  console.log("");
  console.log(`  ${totalNotes} annotation${totalNotes === 1 ? "" : "s"} total. ${C.d}Regenerating never loses them.${C.x}`);
}

async function cmdDoctor(config, root, file) {
  const { detectProjectType, detectFramework, detectPackageManager } = await import("./root.mjs");
  const { isClaudeCliAvailable } = await import("./llm.mjs");
  const { hasOutput } = await import("./store.mjs");
  const P = paths(root);

  const projectType = detectProjectType(root);
  const framework = detectFramework(root, projectType);
  const pm = detectPackageManager(root, projectType);
  const claudeOk = await isClaudeCliAvailable();

  console.log(`${C.b}selfdocs — doctor${C.x}\n`);
  console.log(`  config:     ${file || "(none — using zero-config defaults)"}`);
  console.log(`  target:     ${root}  ${fs.existsSync(root) ? badge("ok") : badge("fail")}`);
  console.log(`  type:       ${projectType}${framework ? ` · ${framework}` : ""}`);
  console.log(`  pkg mgr:    ${pm || "n/a"}`);
  console.log(`  doc types:  ${config.docTypes.join(", ")}`);
  console.log(`  output:     ${P.OUT_DIR}  ${hasOutput(P) ? badge("ok") : `${C.d}(not built yet)${C.x}`}`);
  console.log(`  claude CLI: ${claudeOk ? `${badge("ok")} available` : `${badge("warn")} not found — use \`--mock\` or set SELFDOCS_CLAUDE_BIN`}`);
  console.log(`  model:      ${config.model || `${DEFAULT_MODEL} (default)`}`);
}

function scaffoldConfig() {
  return `// selfdocs.config.mjs: every key is optional. Docs: ${PKG.homepage}
export default {
  // The repo to document. Relative to this config file. Default: this directory.
  // target: ".",

  // Extra .gitignore-style patterns to exclude from the scan, on top of the
  // built-in defaults and the target's own .gitignore.
  ignore: [
    // "examples/**",
    // "*.generated.ts",
  ],

  // Which of the five doc types to generate. Default: all of them.
  docTypes: ["architecture", "schema", "api", "data-flow", "integrations"],

  // The model passed to the \`claude\` CLI (ignored in --mock mode).
  // model: "${DEFAULT_MODEL}",
};
`;
}

function printHelp() {
  console.log(`${C.b}selfdocs${C.x} — the codebase that documents itself.

Scan a repo, draft its architecture docs with the local \`claude\` CLI, and serve a
viewer where your human annotations survive every regeneration.

${C.b}Commands${C.x}
  ${C.c}build${C.x}      scan the target repo and generate its docs → .selfdocs/
      --type=X         only this doc type (comma-separated for several):
                       ${DOC_TYPES.join(", ")}
      --mock           use the deterministic OFFLINE generator (no claude, no network)
      --target=DIR     the repo to document (default: cwd / config dir)
      --ignore=a,b     extra .gitignore-style patterns to exclude from the scan
      --model=NAME     model for the claude CLI

  ${C.c}serve${C.x}      host the web viewer (annotations save to .selfdocs/docs/)
      --port=N         default ${C.d}4630${C.x}; honors \$PORT; auto-advances if busy (up to +25)
  ${C.c}open${C.x}       serve + open the viewer in your browser

  ${C.c}status${C.x}     what's generated, block counts, annotation counts
  ${C.c}doctor${C.x}     claude CLI availability, config, and target detection
  ${C.c}init${C.x}       scaffold a selfdocs.config.mjs

${C.b}Doc types${C.x}
  ${DOC_TYPES.map((t) => `${t.padEnd(13)} ${docTitle(t)}`).join("\n  ")}

${C.b}Examples${C.x}
  npx @excellent-so/selfdocs build --mock   # try it offline, right now
  selfdocs build                            # generate all five with claude
  selfdocs build --type=architecture,api    # just two
  selfdocs open                             # read them, leave notes

Zero runtime dependencies. Fully local — no cloud, no account. Output lives in
.selfdocs/ (gitignore it — see the README). Config: selfdocs.config.{mjs,js,json}.`);
}

main().catch((e) => {
  console.error(`${C.r}selfdocs error:${C.x} ${e?.stack ?? e?.message ?? e}`);
  process.exit(1);
});
