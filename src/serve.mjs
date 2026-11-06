// selfdocs — the viewer server. Serves the single-file viewer over http (not
// file://, which trips browser CSP/fetch) and exposes a tiny JSON API the viewer
// reads AND drives. The READ path is GET /api/docs (everything to render) and
// GET /api/env (which repo we're pointed at + whether the `claude` CLI is around).
// The WRITE path is GET/POST/PATCH/DELETE /api/blocks (your annotations) plus, so
// the whole loop runs in the browser with no terminal round-trip, POST /api/target
// (link a repo) and POST /api/build (generate its docs). Everything reads and writes
// ONLY `.selfdocs/` under the CURRENT target repo.
//
// The target is mutable per running server: "Link repository" re-points it and every
// route reads the current target. Builds run through the same `runBuild` engine the
// CLI uses — the server only drives it; the generation logic (live `claude`, or the
// deterministic offline generator when the CLI is absent or --mock is asked for) is
// unchanged. The mutating routes (blocks, target, build) carry an Origin guard so a
// random web page can't drive them while the viewer is open.

import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { paths, DOC_TYPES, docTitle } from "./config.mjs";
import { loadDoc, loadBlocks, saveDocBlocks, loadManifest, docSummary } from "./store.mjs";
import { insertUserBlock, updateUserBlock, deleteBlock } from "./block-merge.mjs";
import { isClaudeCliAvailable } from "./llm.mjs";
import { runBuild } from "./build.mjs";
import { detectProjectType, detectFramework } from "./root.mjs";
import { C, tildify } from "./lib.mjs";

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".js": "text/javascript",
  ".css": "text/css",
  ".svg": "image/svg+xml",
};

const DEFAULT_PORT = 4630;

function readBody(req, res, limit, cb) {
  let body = "";
  req.on("error", () => {
    try {
      res.writeHead(400);
      res.end();
    } catch {
      /* ignore */
    }
  });
  req.on("data", (c) => {
    body += c;
    if (body.length > limit) req.destroy();
  });
  req.on("end", () => cb(body));
}

function sendJson(res, code, obj) {
  res.writeHead(code, { "content-type": MIME[".json"], "cache-control": "no-store" });
  res.end(JSON.stringify(obj));
}

/** Same-origin / no-Origin allowed; a cross-origin browser POST is rejected. */
function originOk(req) {
  const origin = req.headers.origin;
  if (!origin) return true;
  return /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
}

/** Expand a leading `~` and resolve to an absolute path (relative → process cwd). */
function resolveTargetPath(input) {
  let p = String(input || "").trim();
  if (p === "~") p = os.homedir();
  else if (p.startsWith("~/") || p.startsWith("~\\")) p = path.join(os.homedir(), p.slice(2));
  return path.resolve(p);
}

/**
 * @param {{ config, root, port?, open?, log? }} o
 * @returns {http.Server}
 */
export function serve({ config, root, port, open = false, log = console.log }) {
  // The target is MUTABLE per running server: "Link repository" (POST /api/target)
  // re-points it, and every route below reads the CURRENT target through `P`.
  let curConfig = config;
  let curRoot = root;
  let P = paths(curRoot);
  let building = false; // one build at a time — POST /api/build guards on this.

  const retarget = (nextRoot) => {
    curRoot = nextRoot;
    P = paths(curRoot);
  };

  /** The project block GET /api/docs returns (or null before the first scan). */
  const projectBlock = () => {
    const manifest = loadManifest(P);
    return manifest
      ? {
          name: (manifest.project_root || curRoot).split("/").pop(),
          type: manifest.project_type,
          framework: manifest.markers?.framework ?? null,
          files: manifest.stats?.total_files ?? null,
          generated_at: manifest.generated_at ?? null,
        }
      : null;
  };

  /** The shared shape returned by GET /api/env and POST /api/target. */
  const envPayload = async () => {
    let exists = false;
    try {
      exists = fs.statSync(curRoot).isDirectory();
    } catch {
      exists = false;
    }
    const projectType = exists ? detectProjectType(curRoot) : "unknown";
    const framework = exists ? detectFramework(curRoot, projectType) : null;
    const manifest = loadManifest(P);
    const generated = DOC_TYPES.some((dt) => docSummary(loadDoc(P, dt)).generated);
    return {
      ok: true,
      root: curRoot,
      target: {
        path: curRoot,
        display: tildify(curRoot), // for people: `~/…` under the home directory
        exists,
        projectType,
        framework,
        // From the manifest if we've scanned; never an expensive scan on this GET.
        files: manifest?.stats?.total_files ?? null,
      },
      claude: { available: await isClaudeCliAvailable() },
      docTypes: DOC_TYPES,
      generated,
    };
  };

  /** Run one build against the current target; shape the POST /api/build reply. */
  const runBuildRequest = async (body) => {
    const asked = Array.isArray(body.types) ? body.types.filter((t) => DOC_TYPES.includes(t)) : [];
    const types = asked.length ? asked : curConfig.docTypes;
    // Explicit `mock` wins; otherwise use claude when it's available, else offline.
    const mock = typeof body.mock === "boolean" ? body.mock : !(await isClaudeCliAvailable());
    // Swallow the build log — the server's stdout stays clean.
    const { results } = await runBuild({ config: curConfig, root: curRoot, types, mock, log: () => {} });
    return {
      ok: true,
      mode: mock ? "mock" : "claude",
      generated: results.map((r) => ({ docType: r.docType, userKept: r.userKept, blockCount: r.blockCount })),
      project: projectBlock(),
    };
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://127.0.0.1");

    // ── GET /api/docs — everything the viewer needs to READ, in one payload. ──
    if (req.method === "GET" && url.pathname === "/api/docs") {
      const docs = {};
      const index = [];
      for (const docType of DOC_TYPES) {
        const doc = loadDoc(P, docType);
        docs[docType] = doc
          ? { doc_type: docType, title: doc.title || docTitle(docType), generated_at: doc.generated_at, model: doc.model, blocks: doc.blocks || [] }
          : { doc_type: docType, title: docTitle(docType), generated_at: null, model: null, blocks: [] };
        index.push({ doc_type: docType, title: docTitle(docType), ...docSummary(doc) });
      }
      sendJson(res, 200, {
        ok: true,
        root: curRoot,
        project: projectBlock(),
        docTypes: index,
        docs,
      });
      return;
    }

    // ── GET /api/env — the linked repo, its detected type, and engine availability. ──
    if (req.method === "GET" && url.pathname === "/api/env") {
      envPayload()
        .then((payload) => sendJson(res, 200, payload))
        .catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }));
      return;
    }

    // ── POST /api/target — "Link repository": re-point the current target. ──
    if (req.method === "POST" && url.pathname === "/api/target") {
      if (!originOk(req)) {
        sendJson(res, 403, { ok: false, error: "cross-origin blocked" });
        return;
      }
      readBody(req, res, 1e5, (raw) => {
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        const input = String(body.path ?? "").trim();
        if (!input) {
          sendJson(res, 400, { ok: false, error: "path is required" });
          return;
        }
        const resolved = resolveTargetPath(input);
        let isDir = false;
        try {
          isDir = fs.statSync(resolved).isDirectory();
        } catch {
          isDir = false;
        }
        if (!isDir) {
          sendJson(res, 400, { ok: false, error: `not an existing directory: ${resolved}` });
          return;
        }
        retarget(resolved);
        envPayload()
          .then((payload) => sendJson(res, 200, payload))
          .catch((e) => sendJson(res, 500, { ok: false, error: String(e?.message ?? e) }));
      });
      return;
    }

    // ── POST /api/build — "Generate docs": run the build against the target. ──
    if (req.method === "POST" && url.pathname === "/api/build") {
      if (!originOk(req)) {
        sendJson(res, 403, { ok: false, error: "cross-origin blocked" });
        return;
      }
      if (building) {
        sendJson(res, 409, { ok: false, error: "a build is already running" });
        return;
      }
      building = true;
      readBody(req, res, 1e5, (raw) => {
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          building = false;
          sendJson(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        runBuildRequest(body)
          .then((obj) => sendJson(res, 200, obj))
          .catch((e) => sendJson(res, 400, { ok: false, error: String(e?.message ?? e) }))
          .finally(() => {
            building = false;
          });
      });
      return;
    }

    // ── Mutating block routes (annotations). ──
    if (url.pathname === "/api/blocks" && (req.method === "POST" || req.method === "PATCH" || req.method === "DELETE")) {
      if (!originOk(req)) {
        sendJson(res, 403, { ok: false, error: "cross-origin blocked" });
        return;
      }
      readBody(req, res, 1e6, (raw) => {
        let body = {};
        try {
          body = raw ? JSON.parse(raw) : {};
        } catch {
          sendJson(res, 400, { ok: false, error: "invalid JSON body" });
          return;
        }
        // Allow id/docType via query too (robust DELETE clients).
        const docType = body.docType || url.searchParams.get("docType");
        if (!DOC_TYPES.includes(docType)) {
          sendJson(res, 400, { ok: false, error: `unknown docType: ${docType}` });
          return;
        }
        const now = new Date().toISOString();
        const existing = loadBlocks(P, docType);
        const meta = docMeta(loadDoc(P, docType));

        try {
          if (req.method === "POST") {
            const content = String(body.content ?? "").trim();
            if (!content) {
              sendJson(res, 400, { ok: false, error: "content is required" });
              return;
            }
            const { blocks, block } = insertUserBlock(
              existing,
              { after_anchor: body.after_anchor ?? null, content, block_type: body.block_type || "paragraph" },
              now,
            );
            saveDocBlocks(P, docType, blocks, meta);
            sendJson(res, 200, { ok: true, block });
          } else if (req.method === "PATCH") {
            const id = String(body.id ?? url.searchParams.get("id") ?? "");
            const content = String(body.content ?? "").trim();
            if (!id || !content) {
              sendJson(res, 400, { ok: false, error: "id and content are required" });
              return;
            }
            const { blocks, block } = updateUserBlock(existing, id, content, now);
            if (!block) {
              sendJson(res, 404, { ok: false, error: "user block not found" });
              return;
            }
            saveDocBlocks(P, docType, blocks, meta);
            sendJson(res, 200, { ok: true, block });
          } else {
            // DELETE
            const id = String(body.id ?? url.searchParams.get("id") ?? "");
            if (!id) {
              sendJson(res, 400, { ok: false, error: "id is required" });
              return;
            }
            const { blocks, removed } = deleteBlock(existing, id);
            if (!removed) {
              sendJson(res, 404, { ok: false, error: "user block not found" });
              return;
            }
            saveDocBlocks(P, docType, blocks, meta);
            sendJson(res, 200, { ok: true });
          }
        } catch (e) {
          sendJson(res, 400, { ok: false, error: String(e?.message ?? e) });
        }
      });
      return;
    }

    // ── Static viewer. ──
    if (req.method !== "GET") {
      res.writeHead(405);
      res.end("method not allowed");
      return;
    }
    let rel;
    try {
      rel = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400);
      res.end("bad request");
      return;
    }
    if (rel === "/") rel = "/index.html";
    const file = path.join(P.VIEWER_DIR, path.normalize(rel));
    if (!(file === P.VIEWER_DIR || file.startsWith(P.VIEWER_DIR + path.sep)) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    res.writeHead(200, { "content-type": MIME[path.extname(file)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).pipe(res);
  });

  // An explicit 0 means "ephemeral" (the OS picks a free port — tests use it);
  // only an ABSENT port falls through to $PORT / the default.
  const startPort =
    port === 0 || port === "0"
      ? 0
      : Number(port) || Number(process.env.PORT) || DEFAULT_PORT;

  let active = startPort;
  const onListen = () => {
    log(`\n  ${C.b}selfdocs${C.x} → http://127.0.0.1:${active}\n  ${C.d}link a repo · generate its docs · annotate — all in the browser · Ctrl-C to stop${C.x}\n`);
    if (open) {
      const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
      execFile(opener, [`http://127.0.0.1:${active}`], () => {});
    }
  };
  server.on("error", (e) => {
    if (e.code === "EADDRINUSE" && active < startPort + 25) {
      active++;
      server.listen(active, "127.0.0.1", onListen);
      return;
    }
    console.error(e.code === "EADDRINUSE" ? `\nNo free port found near ${startPort}.\n` : `server error: ${e.message}`);
    process.exit(1);
  });
  server.listen(active, "127.0.0.1", onListen);
  return server;
}

/** Carry a doc's generation metadata through an annotation write. */
function docMeta(doc) {
  if (!doc) return {};
  return {
    generated_at: doc.generated_at,
    manifest_hash: doc.manifest_hash,
    model: doc.model,
    input_tokens: doc.input_tokens,
    output_tokens: doc.output_tokens,
    files_analyzed: doc.files_analyzed,
    validation: doc.validation,
  };
}
