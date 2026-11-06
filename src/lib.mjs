// selfdocs — shared helpers. Zero-dep, plain Node ESM, built-ins only.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

export function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

/** A short, stable hash — for block ids and content fingerprints. */
export function shortHash(str, n = 10) {
  return crypto.createHash("sha256").update(String(str)).digest("hex").slice(0, n);
}

/** A fresh, collision-resistant block id. */
let idCounter = 0;
export function newId(prefix = "b") {
  idCounter = (idCounter + 1) % 1e6;
  return `${prefix}_${Date.now().toString(36)}${idCounter.toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * A path for people to read: anything under the home directory as `~/…` (the home directory itself as `~`).
 * Compares against the home directory as given and as resolved, since macOS reports a temp dir as /var/…
 * while the working directory resolves to /private/var/…. Paths outside home come back unchanged.
 */
export function tildify(p, home = os.homedir()) {
  const target = String(p || "");
  if (!target || !home) return target;
  const homes = new Set([path.resolve(home)]);
  try {
    homes.add(fs.realpathSync(home));
  } catch {
    /* a home that doesn't exist only matches as given */
  }
  for (const h of homes) {
    if (h === path.parse(h).root) continue; // a home of "/" would make every path "~/…"
    if (target === h) return "~";
    if (target.startsWith(h + path.sep)) return "~" + path.sep + target.slice(h.length + 1);
  }
  return target;
}

/** ANSI color helpers, TTY-aware (blank when piped, so logs stay clean). */
export const C = process.stdout.isTTY
  ? {
      g: "\x1b[32m", r: "\x1b[31m", y: "\x1b[33m", c: "\x1b[36m",
      d: "\x1b[2m", b: "\x1b[1m", m: "\x1b[35m", x: "\x1b[0m",
    }
  : { g: "", r: "", y: "", c: "", d: "", b: "", m: "", x: "" };

/** A concise pass/warn/fail badge for CLI output. */
export function badge(kind) {
  if (kind === "ok") return `${C.g}✓${C.x}`;
  if (kind === "warn") return `${C.y}!${C.x}`;
  if (kind === "empty") return `${C.d}·${C.x}`;
  return `${C.r}✗${C.x}`;
}
