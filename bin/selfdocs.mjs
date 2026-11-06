#!/usr/bin/env node
// selfdocs — the codebase that documents itself.
// Thin bin shim → the CLI. One `bin` (npx errors on ambiguous multi-bin), ESM.
import "../src/cli.mjs";
