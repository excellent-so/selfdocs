// selfdocs — the LLM caller. Spawns the `claude` CLI on PATH (or the binary named by
// SELFDOCS_CLAUDE_BIN) with `child_process.spawn`: `-p --output-format=json`, every
// tool disallowed, no session saved, and the prompt piped on stdin. It parses the
// JSON result envelope into the drafted text and its token counts. A missing binary
// throws ClaudeCliMissingError, and a "context too large" reply throws
// ContextTooLargeError so the caller can retry with less. isClaudeCliAvailable()
// runs `claude --version` and caches the answer for 60 s.

import { spawn } from "node:child_process";

export const DEFAULT_MODEL = "claude-sonnet-4-6";
const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_BUFFER = 8_000_000;
const CLAUDE_BIN = process.env.SELFDOCS_CLAUDE_BIN || "claude";

export class ContextTooLargeError extends Error {
  constructor(message) {
    super(message);
    this.name = "ContextTooLargeError";
  }
}

export class ClaudeCliMissingError extends Error {
  constructor() {
    super(
      "The `claude` CLI was not found on your PATH. selfdocs generates documentation " +
        "by driving the local Claude CLI — install it and sign in, or run " +
        "`selfdocs build --mock` to use the deterministic offline generator instead. " +
        "(You can point selfdocs at a specific binary with SELFDOCS_CLAUDE_BIN.)",
    );
    this.name = "ClaudeCliMissingError";
  }
}

/**
 * @param {{ model?: string, system: string, userMessage: string, cwd?: string, timeoutMs?: number }} options
 * @returns {Promise<{ content: string, inputTokens: number, outputTokens: number, model: string }>}
 */
export async function callLLM(options) {
  // A config with no model says null, which a default parameter wouldn't catch; any empty value means the default.
  const model = options.model || DEFAULT_MODEL;
  const {
    system,
    userMessage,
    cwd,
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = options;

  const args = [
    "-p",
    "--output-format=json",
    "--model",
    model,
    "--system-prompt",
    system,
    "--permission-mode",
    "default",
    "--disallowedTools",
    "*",
    "--no-session-persistence",
  ];

  const { stdout, stderr, exitCode, timedOut, spawnError } = await runClaude(args, userMessage, {
    cwd,
    timeoutMs,
  });

  if (spawnError) {
    if (spawnError.code === "ENOENT") throw new ClaudeCliMissingError();
    throw new Error(`Failed to spawn claude CLI: ${spawnError.message}`);
  }

  if (timedOut) throw new Error(`claude CLI timed out after ${timeoutMs}ms`);

  // Parse JSON regardless of exit code — the CLI sometimes exits non-zero but
  // still emits a JSON result envelope.
  const parsed = tryParseJson(stdout);

  if (parsed && parsed.is_error) {
    const msg = errorMessageFromResult(parsed);
    if (looksLikeContextTooLarge(msg)) throw new ContextTooLargeError(msg);
    throw new Error(`claude CLI error: ${msg}`);
  }

  if (exitCode !== 0 && !parsed) {
    throw new Error(
      `claude CLI exited ${exitCode}: ${stderr.slice(0, 2000) || stdout.slice(0, 2000) || "no output"}`,
    );
  }

  if (!parsed) {
    throw new Error(`claude CLI produced no parseable JSON. stdout: ${stdout.slice(0, 500)}`);
  }

  const content = parsed.result ?? "";
  if (!content.trim()) throw new Error("claude CLI returned empty result");

  return {
    content,
    inputTokens: parsed.usage?.input_tokens ?? 0,
    outputTokens: parsed.usage?.output_tokens ?? 0,
    model,
  };
}

// `claude --version` spawns a subprocess (~50 ms). Cache the result for 60 s and
// coalesce concurrent callers behind one promise.
const CLI_AVAILABLE_TTL_MS = 60_000;
let cliAvailableCache = null;
let cliAvailableInflight = null;

export async function isClaudeCliAvailable() {
  const now = Date.now();
  if (cliAvailableCache && now - cliAvailableCache.ts < CLI_AVAILABLE_TTL_MS) {
    return cliAvailableCache.value;
  }
  if (cliAvailableInflight) return cliAvailableInflight;
  cliAvailableInflight = new Promise((resolve) => {
    let child;
    try {
      child = spawn(CLAUDE_BIN, ["--version"], { stdio: ["ignore", "ignore", "ignore"] });
    } catch {
      resolve(false);
      return;
    }
    child.on("error", () => resolve(false));
    child.on("close", (code) => resolve(code === 0));
  })
    .then((value) => {
      cliAvailableCache = { value, ts: Date.now() };
      cliAvailableInflight = null;
      return value;
    })
    .catch(() => {
      cliAvailableInflight = null;
      return false;
    });
  return cliAvailableInflight;
}

function tryParseJson(s) {
  try {
    const trimmed = s.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch {
    const first = s.indexOf("{");
    const last = s.lastIndexOf("}");
    if (first >= 0 && last > first) {
      try {
        return JSON.parse(s.slice(first, last + 1));
      } catch {
        return null;
      }
    }
    return null;
  }
}

function errorMessageFromResult(r) {
  if (typeof r.error === "string") return r.error;
  if (r.error && typeof r.error === "object") return r.error.message || r.error.type || "unknown error";
  if (r.message) return r.message;
  if (r.result) return r.result;
  return "unknown claude CLI error";
}

function looksLikeContextTooLarge(msg) {
  const m = msg.toLowerCase();
  return (
    m.includes("too long") ||
    m.includes("too large") ||
    (m.includes("context") && m.includes("limit")) ||
    m.includes("token limit") ||
    m.includes("maximum context")
  );
}

function runClaude(args, stdin, opts) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(CLAUDE_BIN, args, {
        cwd: opts.cwd,
        env: { ...process.env, NO_COLOR: "1", CI: process.env.CI ?? "1" },
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ stdout: "", stderr: "", exitCode: null, timedOut: false, spawnError: err });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;

    child.stdout?.on("data", (chunk) => {
      if (stdout.length < DEFAULT_MAX_BUFFER) stdout += chunk.toString();
    });
    child.stderr?.on("data", (chunk) => {
      if (stderr.length < DEFAULT_MAX_BUFFER) stderr += chunk.toString();
    });

    const timer = setTimeout(() => {
      timedOut = true;
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          /* ignore */
        }
      }, 2000).unref();
    }, opts.timeoutMs);
    timer.unref();

    child.on("error", (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: null, timedOut, spawnError: err });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, exitCode: code, timedOut, spawnError: null });
    });

    try {
      child.stdin?.end(stdin);
    } catch {
      /* already errored above */
    }
  });
}
