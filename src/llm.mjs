// selfdocs — the LLM caller. Spawns the `claude` CLI on PATH (or the binary named by
// SELFDOCS_CLAUDE_BIN) with `child_process.spawn`: `-p --output-format=json`, every
// tool disallowed, no session saved, and the prompt piped on stdin. It also asks for
// no MCP servers (`--strict-mcp-config`) and none of your own CLAUDE.md, hooks or
// plugins (`--safe-mode`), so the model sees only what selfdocs sends; a CLI too old
// for one of those flags is asked again without it. It parses the JSON result
// envelope into the drafted text and its token counts. A missing binary throws
// ClaudeCliMissingError, a "context too large" reply throws ContextTooLargeError so
// the caller can retry with less, and every other failure throws a ClaudeCliError
// that says what to do. isClaudeCliAvailable() runs `claude --version` and caches
// the answer for 60 s.

import { spawn } from "node:child_process";
import { SelfdocsError } from "./lib.mjs";

export const DEFAULT_MODEL = "claude-sonnet-4-6";
// A long doc can take a few minutes to write (14,000 tokens took two in testing); this only catches a CLI that hangs.
const DEFAULT_TIMEOUT_MS = 600_000;
const DEFAULT_MAX_BUFFER = 8_000_000;
const CLAUDE_BIN = process.env.SELFDOCS_CLAUDE_BIN || "claude";

// Flags that keep the user's own Claude setup out of the run. Older CLIs reject them
// ("unknown option"), so each is dropped, once, for the rest of the process when that happens.
const ISOLATION_FLAGS = ["--strict-mcp-config", "--safe-mode"];
const unsupportedFlags = new Set();

export class ContextTooLargeError extends SelfdocsError {
  constructor(message) {
    super(`the model says the context is too large (${message}).`);
    this.name = "ContextTooLargeError";
  }
}

export class ClaudeCliMissingError extends SelfdocsError {
  constructor() {
    super(
      `the \`claude\` CLI was not found${process.env.SELFDOCS_CLAUDE_BIN ? ` at SELFDOCS_CLAUDE_BIN (${process.env.SELFDOCS_CLAUDE_BIN})` : " on your PATH"}.`,
      "Install it and sign in, or draft offline with `selfdocs build --mock`. " +
        "To use a claude binary that isn't on your PATH, set SELFDOCS_CLAUDE_BIN to its path.",
    );
    this.name = "ClaudeCliMissingError";
  }
}

/** Any other failure of the claude CLI, with what to do about it. */
export class ClaudeCliError extends SelfdocsError {
  constructor(message, hint) {
    super(message, hint);
    this.name = "ClaudeCliError";
  }
}

/** Turn the CLI's own error text into a ClaudeCliError that says what to do next. */
export function claudeErrorFor(raw, model) {
  const msg = String(raw || "unknown error").trim().replace(/\s+/g, " ").slice(0, 400);
  const m = msg.toLowerCase();
  if (m.includes("not logged in") || m.includes("/login") || m.includes("invalid api key") || m.includes("authentication") || m.includes("oauth token")) {
    return new ClaudeCliError(
      `the \`claude\` CLI isn't signed in (it said: "${msg}").`,
      "Sign in with `claude auth login` (or run `claude` and type /login), then build again. To draft offline instead, add --mock.",
    );
  }
  if (m.includes("selected model") || m.includes("model not found") || m.includes("not_found_error") || m.includes("may not exist")) {
    return new ClaudeCliError(
      `the \`claude\` CLI can't use the model "${model}" (it said: "${msg}").`,
      `Pass a model your account can use with --model=NAME, or set \`model\` in selfdocs.config.mjs. With neither, selfdocs uses ${DEFAULT_MODEL}.`,
    );
  }
  if (m.includes("usage limit") || m.includes("rate limit") || m.includes("rate_limit") || m.includes("hit your limit") || m.includes("overloaded") || m.includes("credit balance")) {
    return new ClaudeCliError(`the \`claude\` CLI couldn't draft right now (it said: "${msg}").`, "Wait and build again, or draft offline with --mock.");
  }
  return new ClaudeCliError(`the \`claude\` CLI failed: ${msg}`, "Check that `claude -p \"hello\"` works in a terminal, then build again. To draft offline instead, add --mock.");
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

  const buildArgs = () => [
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
    ...ISOLATION_FLAGS.filter((f) => !unsupportedFlags.has(f)),
  ];

  let run;
  for (;;) {
    run = await runClaude(buildArgs(), userMessage, { cwd, timeoutMs });
    // An older CLI that doesn't know an isolation flag: drop it and ask again.
    const unknown = run.exitCode !== 0 && !run.spawnError && /unknown option '?(--[\w-]+)/i.exec(run.stderr + run.stdout);
    if (unknown && ISOLATION_FLAGS.includes(unknown[1]) && !unsupportedFlags.has(unknown[1])) {
      unsupportedFlags.add(unknown[1]);
      continue;
    }
    break;
  }
  const { stdout, stderr, exitCode, timedOut, spawnError } = run;

  if (spawnError) {
    if (spawnError.code === "ENOENT") throw new ClaudeCliMissingError();
    throw new ClaudeCliError(`couldn't start the \`claude\` CLI (${spawnError.message}).`, "Check that `claude --version` works in a terminal, or set SELFDOCS_CLAUDE_BIN to the claude binary.");
  }

  if (timedOut) {
    throw new ClaudeCliError(
      `the \`claude\` CLI didn't answer within ${Math.round(timeoutMs / 1000)} seconds.`,
      "Check that `claude -p \"hello\"` answers in a terminal, then build again, or build fewer docs at once with --type=NAME.",
    );
  }

  // Parse JSON regardless of exit code — the CLI sometimes exits non-zero but
  // still emits a JSON result envelope.
  const parsed = tryParseJson(stdout);

  if (parsed && parsed.is_error) {
    const msg = errorMessageFromResult(parsed);
    if (looksLikeContextTooLarge(msg)) throw new ContextTooLargeError(msg);
    throw claudeErrorFor(msg, model);
  }

  if (exitCode !== 0 && !parsed) {
    throw claudeErrorFor(`exited with code ${exitCode}: ${(stderr || stdout).trim().slice(0, 300) || "no output"}`, model);
  }

  if (!parsed) {
    throw claudeErrorFor(`its output wasn't the JSON selfdocs asked for: ${stdout.trim().slice(0, 200) || "no output"}`, model);
  }

  const content = typeof parsed.result === "string" ? parsed.result : "";
  if (!content.trim()) throw claudeErrorFor("it returned an empty draft", model);

  const u = parsed.usage || {};
  return {
    content,
    // With prompt caching, the prompt splits across three counters; their sum is what was read.
    inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
    outputTokens: u.output_tokens ?? 0,
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
