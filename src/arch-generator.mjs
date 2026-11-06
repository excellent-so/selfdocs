// selfdocs — drive generation of one doc type: context → LLM (or --mock) → validate
// → auto-repair. With `mock`, the deterministic offline generator (mock.mjs) stands in
// for the live `claude` call. Mock output still flows through autoRepair + the
// validator, so both paths produce the same clean, block-parseable markdown.

import { createHash } from "node:crypto";
import { gatherContext, formatContextForLLM } from "./context.mjs";
import { callLLM, ContextTooLargeError } from "./llm.mjs";
import { validateArchDoc, autoRepair } from "./doc-validator.mjs";
import { mockGenerate } from "./mock.mjs";

export function computeManifestHash(manifest) {
  const data = manifest.files
    .map((f) => `${f.path}:${f.size}:${f.hash}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(data).digest("hex").slice(0, 16);
}

const COMMON_RULES = `Markdown rules — these are strict; the renderer enforces them:
1. The first non-empty line is the H1 title. No preamble, no sign-off, no wrapping code fence.
2. Use only ATX headings (\`# Title\`). Nest strictly: H1 → H2 → H3 → H4. Never skip levels.
3. Never insert a bare horizontal rule (\`---\`, \`***\`) between sections — H2 owns its divider.
4. Tables must be GFM: a header row, an alignment row \`|---|---|\`, then body rows.
5. Code fences declare a language (\`\`\`ts, \`\`\`sh, \`\`\`json, etc.) and end with a matching \`\`\` on its own line.
6. Inline code uses single backticks: \`packages/ui/\`, \`getDb()\`. Never use straight quotes or italics for identifiers.
7. One blank line between blocks (paragraph → heading, paragraph → list, etc.). Never two, never zero.
8. Bullet markers stay consistent inside a list (all \`-\` or all \`*\`, never mixed).
9. Don't use inline HTML.

Content rules:
- Be SPECIFIC. Every claim must reference a real file, function, class, or config key from the provided code.
- If you can't determine something from the code, say "unclear from the provided code" rather than guess.
- Keep prose tight. Prefer one well-grounded paragraph over three speculative ones.
- For commands, paths, identifiers, env vars: always use inline code.`;

const SYSTEM_PROMPTS = {
  architecture: `You are a senior software architect analyzing a codebase to produce an Architecture Overview document.

Your output is pure markdown.

Structure:

# Architecture Overview

## System Overview
What this system does, in 2-3 paragraphs, grounded in the code you see.

## Technology Stack
A GFM table with columns \`Layer\` and \`Technology\`. List languages, frameworks, databases, and key libraries.

## System Components
The major components/modules and their responsibilities. Use H3 subheadings per component. Reference real directory names, file paths, and exported symbols.

## Key Design Patterns
Architectural patterns actually used (plugin architecture, event-driven, contract-first API, etc.). Use H3 subheadings per pattern.

## Entry Points
The main entry points of the application — binaries, CLI scripts, server bootstraps.

## Build & Deploy
How the project is built and deployed, based on config files. Include a fenced \`sh\` code block of the canonical dev command sequence.

${COMMON_RULES}`,

  schema: `You are a database expert analyzing a codebase to produce a Database Schema document.

Your output is pure markdown.

Structure:

# Database Schema

## Overview
The database technology used (engine, driver, dialect) and the overall data-model design, in 1-2 paragraphs.

## Tables / Models
For each model/table, use an H3 subheading. Under each:
- A GFM table of columns (\`Column\`, \`Type\`, \`Notes\`).
- A paragraph describing the table's purpose.

## Relationships
Relationships between tables (one-to-many, many-to-many, etc.). Reference the foreign-key columns explicitly.

## Migrations
If migration files are provided, summarize the history in chronological order. List the canonical migration command in a fenced code block.

${COMMON_RULES}`,

  api: `You are an API documentation expert analyzing a codebase to produce an API Reference document.

Your output is pure markdown.

Structure:

# API Reference

## Overview
The API architecture — REST, GraphQL, gRPC, MCP, etc. — in 1-2 paragraphs.

## Authentication
How authentication works, based on the code.

## Endpoints
Group endpoints by module/resource using H3 subheadings. For each endpoint:
- A line of the form \`\`METHOD /path\`\` followed by a one-sentence description.
- A GFM table of parameters where parameters exist (\`Name\`, \`In\`, \`Type\`, \`Required\`, \`Notes\`).
- A fenced code block of the request body schema if visible, and another for a sample response.

## Error Handling
Common error envelopes and codes found in the code.

## Rate Limiting / Middleware
Any middleware or rate limiting found.

${COMMON_RULES}`,

  "data-flow": `You are a systems engineer analyzing a codebase to produce a Data Flow document.

Your output is pure markdown.

Structure:

# Data Flow Documentation

## Overview
How data moves through this system, in 1-2 paragraphs.

## Ingestion / Input
How data enters the system (APIs, webhooks, file uploads, etc.).

## Processing Pipelines
Background jobs, workers, task queues, event handlers. Use H3 subheadings per pipeline.

## Data Transformations
Key transformation steps data goes through.

## Output / Storage
Where processed data ends up (databases, file storage, external APIs, etc.).

## Scheduling / Cron
Any scheduled jobs or periodic tasks. If none, say so explicitly.

${COMMON_RULES}`,

  integrations: `You are a DevOps/integrations specialist analyzing a codebase to produce an Integrations Guide.

Your output is pure markdown.

Structure:

# Integrations Guide

## Overview
External services and integrations used by this project, summarized in 1-2 paragraphs.

## External Services
Use an H3 subheading per service. Under each:
- Purpose: what it's used for.
- Configuration: env vars or config keys needed.
- SDK/Client: how the code connects to it.

## Authentication Providers
OAuth, SSO, or other auth integrations.

## Infrastructure
Docker, CI/CD, cloud services, monitoring tools.

## Environment Variables
A GFM table of every env var found (\`Variable\`, \`Required\`, \`Default\`, \`Used by\`). Never expose secret values.

${COMMON_RULES}`,
};

const REPAIR_SYSTEM_PROMPT = `You are fixing a markdown document that failed the renderer's validator.
Fix ONLY the listed issues. Do not change the document's content or meaning.
Output the corrected markdown only — no preamble, no wrapping code fences.`;

/**
 * @param {{ projectRoot: string, manifest: object, docType: string, model?: string, mock?: boolean }} options
 * @returns {Promise<{ content, inputTokens, outputTokens, filesAnalyzed, model, validation, repairAttempts }>}
 */
export async function generateArchDoc(options) {
  const { projectRoot, manifest, docType, model, mock = false } = options;

  const ctx = gatherContext(projectRoot, manifest, docType);

  // ── Offline / --mock path: deterministic, no CLI, no repair loop needed. ──
  if (mock) {
    const content = autoRepair(mockGenerate(manifest, docType));
    const validation = validateArchDoc(content, docType);
    return {
      content,
      inputTokens: 0,
      outputTokens: 0,
      filesAnalyzed: ctx.files.length,
      model: "mock",
      validation,
      repairAttempts: 0,
    };
  }

  // ── Live path: drive the local `claude` CLI. ──
  const contextStr = formatContextForLLM(ctx);

  let result;
  try {
    result = await callLLM({
      model,
      cwd: projectRoot,
      system: SYSTEM_PROMPTS[docType],
      userMessage: `Analyze this codebase and generate the documentation.\n\n${contextStr}`,
    });
  } catch (error) {
    if (error instanceof ContextTooLargeError) {
      const reducedCtx = gatherContext(projectRoot, manifest, docType, 40_000);
      const reducedStr = formatContextForLLM(reducedCtx);
      result = await callLLM({
        model,
        cwd: projectRoot,
        system: SYSTEM_PROMPTS[docType],
        userMessage: `Analyze this codebase and generate the documentation.\n\n${reducedStr}`,
      });
    } else {
      throw error;
    }
  }

  let totalInputTokens = result.inputTokens;
  let totalOutputTokens = result.outputTokens;
  let content = autoRepair(result.content);
  let repairAttempts = 0;

  const MAX_REPAIRS = 2;
  let validation = validateArchDoc(content, docType);

  while (!validation.valid && repairAttempts < MAX_REPAIRS) {
    repairAttempts++;
    const issueList = validation.issues
      .map((i) => `- [${i.severity}] ${i.rule}: ${i.message}${i.line ? ` (line ${i.line})` : ""}`)
      .join("\n");

    const repairResult = await callLLM({
      model,
      cwd: projectRoot,
      system: REPAIR_SYSTEM_PROMPT,
      userMessage: `## Issues Found:\n${issueList}\n\n## Document:\n${content}`,
    });

    totalInputTokens += repairResult.inputTokens;
    totalOutputTokens += repairResult.outputTokens;
    content = autoRepair(repairResult.content);
    validation = validateArchDoc(content, docType);
  }

  return {
    content,
    inputTokens: totalInputTokens,
    outputTokens: totalOutputTokens,
    filesAnalyzed: ctx.files.length,
    model: result.model,
    validation,
    repairAttempts,
  };
}
