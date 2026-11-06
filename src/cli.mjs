// selfdocs — CLI: parses the verb and its flags and runs it (npx @excellent-so/selfdocs …).
// Verbs: build · serve · open · status · doctor · init · help · version.
// Every failure a person can act on is a SelfdocsError: one sentence and what to do, no stack trace.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, paths, DOC_TYPES, docTitle } from "./config.mjs";
import { C, badge, SelfdocsError } from "./lib.mjs";
import { DEFAULT_MODEL } from "./llm.mjs";

const PKG_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The project page the scaffolded config points at. Read from package.json so the two never disagree.
const PKG = JSON.parse(fs.readFileSync(path.join(PKG_ROOT, "package.json"), "utf8"));

// The flags each command takes. `true` takes a value (--type=api or --type api); `false` is a switch.
const FLAGS = {
  build: { type: true, mock: false, target: true, ignore: true, model: true },
  serve: { target: true, port: true },
  open: { target: true, port: true },
  status: { target: true },
  doctor: { target: true },
  init: { force: false },
};

/** How to run selfdocs again, the way it was started, so a hint works as typed: npx, a clone, or the installed command. */
function self() {
  if (process.env.npm_command === "exec") return `npx ${PKG.name}`;
  const script = process.argv[1] || "";
  if (path.basename(script) === "selfdocs.mjs") {
    const rel = path.relative(process.cwd(), script);
    return `node ${rel && !rel.startsWith("..") ? rel : script}`; // relative inside the clone, absolute from elsewhere
  }
  return "selfdocs";
}

function parseFlags(cmd, argv) {
  const known = FLAGS[cmd] || {};
  const f = {};
  const positionals = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-h" || a === "--help") {
      f.help = true;
      continue;
    }
    const m = a.match(/^--([^=]+)(?:=(.*))?$/);
    if (!m) {
      positionals.push(a);
      continue;
    }
    const [, name, value] = m;
    if (!(name in known)) {
      const list = Object.keys(known).map((k) => `--${k}`).join(", ");
      throw new SelfdocsError(`${cmd} doesn't take --${name}.`, list ? `It takes ${list}. See \`${self()} --help\`.` : `See \`${self()} --help\`.`);
    }
    if (!known[name]) {
      f[name] = true; // a switch
      continue;
    }
    // A value flag: --name=value, or --name value.
    let v = value;
    if (v === undefined && i + 1 < argv.length && !argv[i + 1].startsWith("-")) v = argv[++i];
    if (v === undefined || v === "") {
      throw new SelfdocsError(`--${name} needs a value.`, `For example: ${self()} ${cmd} ${FLAG_EXAMPLES[name] || `--${name}=VALUE`}`);
    }
    f[name] = v;
  }
  if (positionals.length) {
    throw new SelfdocsError(`${cmd} doesn't take "${positionals[0]}".`, `Flags take the form --name=value. See \`${self()} --help\`.`);
  }
  return f;
}

const FLAG_EXAMPLES = {
  type: "--type=architecture,api",
  target: "--target=../my-repo",
  ignore: '--ignore="examples/**,*.generated.ts"',
  model: `--model=${DEFAULT_MODEL}`,
  port: "--port=4631",
};

function overridesFromFlags(f) {
  const o = {};
  if (f.target) o.target = String(f.target);
  if (f.ignore) o.ignore = String(f.ignore).split(",").map((s) => s.trim()).filter(Boolean);
  if (f.model) o.model = String(f.model);
  return o;
}

/** Load the config and check the target is a folder (doctor reports a bad target instead of stopping). */
async function setup(f, { requireTarget = true } = {}) {
  const loaded = await loadConfig({ overrides: overridesFromFlags(f) });
  if (requireTarget) {
    let isDir = false;
    try {
      isDir = fs.statSync(loaded.root).isDirectory();
    } catch {
      isDir = false;
    }
    if (!isDir) {
      const from = f.target ? "--target" : process.env.SELFDOCS_TARGET ? "SELFDOCS_TARGET" : loaded.file ? `the target in ${loaded.file}` : "the target";
      throw new SelfdocsError(`${loaded.root} isn't a folder (from ${from}).`, "Point --target=DIR at an existing directory.");
    }
  }
  return loaded;
}

/** Which doc types this invocation targets: --type=X (repeatable via comma) or config. */
function resolveTypes(f, config) {
  if (f.type) {
    const asked = String(f.type).split(",").map((s) => s.trim()).filter(Boolean);
    const unknown = asked.filter((t) => !DOC_TYPES.includes(t));
    if (unknown.length || !asked.length) {
      throw new SelfdocsError(`unknown doc type${unknown.length === 1 ? "" : "s"}: ${unknown.join(", ") || "(none given)"}.`, `The doc types are ${DOC_TYPES.join(", ")}.`);
    }
    return asked;
  }
  return config.docTypes;
}

async function main() {
  const [cmd = "help", ...rest] = process.argv.slice(2);

  if (cmd === "help" || cmd === "--help" || cmd === "-h") return printHelp();
  if (cmd === "version" || cmd === "--version" || cmd === "-v") return console.log(PKG.version);
  if (!FLAGS[cmd]) {
    throw new SelfdocsError(`"${cmd}" isn't a selfdocs command.`, `The commands are ${Object.keys(FLAGS).join(", ")}. See \`${self()} --help\`.`);
  }

  const f = parseFlags(cmd, rest);
  if (f.help) return printHelp();

  switch (cmd) {
    case "build": {
      const { config, root } = await setup(f);
      const types = resolveTypes(f, config);
      const mock = Boolean(f.mock);

      if (!mock) {
        const { isClaudeCliAvailable, ClaudeCliMissingError } = await import("./llm.mjs");
        if (!(await isClaudeCliAvailable())) throw new ClaudeCliMissingError();
      }

      const { runBuild } = await import("./build.mjs");
      const { results } = await runBuild({ config, root, types, mock });
      const P = paths(root);
      const warned = results.filter((r) => !r.result.validation.valid).map((r) => r.docType);
      console.log(
        `\n${badge("ok")} wrote ${results.length} doc${results.length === 1 ? "" : "s"} to ${C.d}${path.relative(process.cwd(), P.DOCS_DIR) || P.DOCS_DIR}${C.x}` +
          (warned.length ? `\n${badge("warn")} ${warned.join(", ")} still ${warned.length === 1 ? "has" : "have"} markdown problems after two repairs; the viewer shows ${warned.length === 1 ? "it" : "them"} as drafted` : "") +
          `\n  view them: ${C.c}${self()} open${f.target ? ` --target=${f.target}` : ""}${C.x}`,
      );
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
      const { config, root, file } = await setup(f, { requireTarget: false });
      await cmdDoctor(config, root, file);
      break;
    }

    case "init": {
      const target = path.join(process.cwd(), "selfdocs.config.mjs");
      if (fs.existsSync(target) && !f.force) {
        throw new SelfdocsError(`${target} already exists.`, "Edit it, or pass --force to overwrite it with the starter config.");
      }
      fs.writeFileSync(target, scaffoldConfig());
      console.log(`${badge("ok")} wrote ${path.relative(process.cwd(), target)}\n  Edit it, then run: ${C.c}${self()} build${C.x}`);
      break;
    }
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
      --model=NAME     model for the claude CLI (default ${DEFAULT_MODEL})

  ${C.c}serve${C.x}      host the web viewer (annotations save to .selfdocs/docs/)
      --target=DIR     the repo to show (the viewer can link another)
      --port=N         default ${C.d}4630${C.x}; honors \$PORT; auto-advances if busy (up to +25)
  ${C.c}open${C.x}       serve + open the viewer in your browser (same flags as serve)

  ${C.c}status${C.x}     what's generated, block counts, annotation counts (--target=DIR)
  ${C.c}doctor${C.x}     claude CLI availability, config, and target detection (--target=DIR)
  ${C.c}init${C.x}       scaffold a selfdocs.config.mjs in this directory
      --force          overwrite an existing one

  ${C.c}--help${C.x}     this help (also after any command)
  ${C.c}--version${C.x}  the version

${C.b}Doc types${C.x}
  ${DOC_TYPES.map((t) => `${t.padEnd(13)} ${docTitle(t)}`).join("\n  ")}

${C.b}Examples${C.x}
  npx @excellent-so/selfdocs build --mock   # try it offline, right now
  selfdocs build                            # generate all five with claude
  selfdocs build --type=architecture,api    # just two
  selfdocs open                             # read them, leave notes

Zero runtime dependencies and no service of its own: a real draft goes to the model
through your claude CLI, and --mock stays on this machine. Output lives in .selfdocs/
(see the README). Config: selfdocs.config.{mjs,js,cjs,json}.`);
}

main().catch((e) => {
  // A SelfdocsError says what happened and what to do. Anything else is a bug: its message, and the stack
  // only when SELFDOCS_DEBUG is set.
  const msg = String(e?.message ?? e);
  console.error(`${C.r}selfdocs:${C.x} ${msg}`);
  if (e?.hint) console.error(`\n  ${e.hint}`);
  if (!(e instanceof SelfdocsError)) {
    console.error(process.env.SELFDOCS_DEBUG ? `\n${e?.stack ?? ""}` : `\n  This looks like a bug in selfdocs. Run again with SELFDOCS_DEBUG=1 for the details, and report it at ${PKG.bugs.url}.`);
  }
  process.exit(1);
});
