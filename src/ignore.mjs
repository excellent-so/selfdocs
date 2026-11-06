// selfdocs — .gitignore-style ignore rules.
//
// A hand-rolled gitignore matcher (no dependencies) good enough for a source scan:
// directory patterns (trailing `/`), anchored vs basename patterns, `*` / `**` / `?`
// globs, and `!` negation with last-match-wins.

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_IGNORES = [
  ".git/",
  ".svn/",
  ".hg/",
  "node_modules/",
  "vendor/",
  ".venv/",
  "venv/",
  "__pycache__/",
  "*.pyc",
  ".eggs/",
  "*.egg-info/",
  "dist/",
  "build/",
  "out/",
  "target/",
  ".next/",
  ".nuxt/",
  ".output/",
  ".vercel/",
  ".netlify/",
  ".idea/",
  ".vscode/",
  "*.swp",
  "*.swo",
  "*~",
  ".DS_Store",
  "Thumbs.db",
  "desktop.ini",
  "*.log",
  "logs/",
  "tmp/",
  "temp/",
  ".cache/",
  "coverage/",
  "htmlcov/",
  ".nyc_output/",
  ".coverage",
  // selfdocs' own output — never document the docs.
  ".selfdocs/",
];

/**
 * Build the ignore matcher for a project root. Combines the built-in defaults,
 * the project's own `.gitignore`, and any extra patterns from config.
 *
 * @param {string}   projectRoot
 * @param {string[]} [extra]  additional patterns (config.ignore)
 * @returns {{ ignores: (relPath: string) => boolean }}
 */
export function createIgnore(projectRoot, extra = []) {
  const patterns = [...DEFAULT_IGNORES];

  const gitignorePath = join(projectRoot, ".gitignore");
  if (existsSync(gitignorePath)) {
    try {
      patterns.push(...parseIgnoreFile(readFileSync(gitignorePath, "utf-8")));
    } catch {
      // ignore read errors
    }
  }
  patterns.push(...extra.filter((p) => typeof p === "string" && p.trim()));

  const rules = patterns.map(compileRule).filter(Boolean);

  return {
    ignores(relPath) {
      const p = String(relPath).replace(/\\/g, "/").replace(/^\/+/, "").replace(/\/+$/, "");
      if (!p) return false;
      let ignored = false;
      for (const rule of rules) {
        if (rule.re.test(p)) ignored = !rule.negate;
      }
      return ignored;
    },
  };
}

function parseIgnoreFile(content) {
  return content
    .split("\n")
    .map((line) => line.replace(/\r$/, "").trim())
    .filter((line) => line && !line.startsWith("#"));
}

/** Compile one gitignore pattern into { negate, re }. */
function compileRule(raw) {
  let pat = raw.trim();
  if (!pat || pat.startsWith("#")) return null;

  let negate = false;
  if (pat.startsWith("!")) {
    negate = true;
    pat = pat.slice(1);
  }
  // A trailing slash marks a directory pattern; we match the dir path itself
  // (descendants are covered by the `(/.*)?` tail below).
  pat = pat.replace(/\/+$/, "");
  // A leading slash, or an interior slash, anchors the pattern to the root.
  // A bare name (no interior slash) matches at any depth (basename semantics).
  const hadLeadingSlash = pat.startsWith("/");
  if (hadLeadingSlash) pat = pat.slice(1);
  const anchored = hadLeadingSlash || pat.includes("/");

  const body = globToRegex(pat);
  const prefix = anchored ? "^" : "(?:^|.*/)";
  const re = new RegExp(`${prefix}${body}(?:/.*)?$`);
  return { negate, re };
}

/** Translate a glob body into a regex fragment (segment-aware `*`/`**`/`?`). */
function globToRegex(glob) {
  let out = "";
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === "*") {
      if (glob[i + 1] === "*") {
        // `**` — cross directory boundaries. Consume a following slash too.
        i++;
        if (glob[i + 1] === "/") i++;
        out += ".*";
      } else {
        out += "[^/]*";
      }
    } else if (c === "?") {
      out += "[^/]";
    } else if ("\\^$.|+()[]{}".includes(c)) {
      out += "\\" + c;
    } else {
      out += c;
    }
  }
  return out;
}
