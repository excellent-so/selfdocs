// selfdocs — recursive filesystem scan → a file manifest with content hashes.
// Paths the ignore matcher (ignore.mjs, `.ignores(relPath)`) rejects are skipped; files
// over 10 MB are listed with their size in place of a hash. Symlinks are never followed
// into directories (a link to a parent would loop), and a link to a file counts only
// when it points inside the repo, so nothing outside the repo is read or sent.

import { readdirSync, statSync, lstatSync, readFileSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { createHash } from "node:crypto";
import { detectFileType } from "./filetype.mjs";

const DEFAULT_MAX_FILE_SIZE = 10 * 1024 * 1024;

/**
 * @param {string} root
 * @param {{ ignore: { ignores(p:string):boolean }, maxFileSize?: number }} options
 * @returns {{ files: object[], dirs: Set<string>, totalSize: number }}
 */
export function scanDirectory(root, options) {
  const files = [];
  const dirs = new Set();
  let totalSize = 0;
  const maxFileSize = options.maxFileSize ?? DEFAULT_MAX_FILE_SIZE;
  let realRoot = root;
  try {
    realRoot = realpathSync(root);
  } catch {
    /* an unreadable root scans as empty below */
  }
  const insideRoot = (p) => p === realRoot || p.startsWith(realRoot + sep);

  function walk(dir) {
    let entries;
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = join(dir, entry);
      const relativePath = relative(root, fullPath);

      if (options.ignore.ignores(relativePath)) continue;

      let stats;
      try {
        stats = lstatSync(fullPath);
        if (stats.isSymbolicLink()) {
          // Follow a link only to a file inside the repo; never into a directory.
          if (!insideRoot(realpathSync(fullPath))) continue;
          stats = statSync(fullPath);
          if (!stats.isFile()) continue;
        }
      } catch {
        continue; // unreadable, or a dangling link
      }

      if (stats.isDirectory()) {
        dirs.add(relativePath);
        walk(fullPath);
      } else if (stats.isFile()) {
        const fileType = detectFileType(relativePath);
        const hash = stats.size <= maxFileSize ? hashFile(fullPath) : `size:${stats.size}`;
        files.push({
          path: relativePath,
          type: fileType,
          hash,
          size: stats.size,
          modified: stats.mtime.toISOString(),
        });
        totalSize += stats.size;
      }
    }
  }

  walk(root);
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, dirs, totalSize };
}

function hashFile(filePath) {
  try {
    const content = readFileSync(filePath);
    const hash = createHash("sha256").update(content).digest("hex");
    return `sha256:${hash.substring(0, 16)}`;
  } catch {
    return "error:unreadable";
  }
}
