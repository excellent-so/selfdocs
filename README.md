<img src="docs/mark.svg" width="40" height="40" alt="">

# selfdocs

Scans a repo and drafts five architecture docs with your local `claude` CLI, then serves them in a viewer. Your
own notes survive every regeneration.

Docs and how to use it: https://playbook.excellent.so/selfdocs

![The selfdocs viewer: the Architecture Overview of a small Express app, drafted offline, with one of your notes pinned under a paragraph](docs/screenshot.png)

Regenerating a doc from scratch throws away the one thing worth keeping: the note someone wrote about why
express is pinned to 4.x. selfdocs splits each doc into anchored blocks and pins your notes to them, so
regenerating updates the draft and leaves your notes where you put them.

## Install

Needs Node 20 or later. No runtime dependencies.

```sh
npm i -g @excellent-so/selfdocs    # adds a `selfdocs` command
```

Or run it without installing, with `npx @excellent-so/selfdocs <command>`, or pin it in a project with
`npm i -D @excellent-so/selfdocs`.

## Quick start

In the repo you want documented:

```sh
npx @excellent-so/selfdocs build --mock   # scan the repo and draft all five docs, offline
npx @excellent-so/selfdocs open           # serve the viewer and open it in your browser
```

`--mock` needs nothing else installed. To have the model write the docs, install the `claude` CLI, sign in, and
build without it:

```sh
npx @excellent-so/selfdocs build --type=architecture   # one doc first: one call to the model
npx @excellent-so/selfdocs build                       # all five
```

Each doc is one call to the model through your `claude` CLI, plus up to two more if its markdown needs repair. On a
small Express app, one doc took under a minute and all five took about five minutes.

The viewer runs at http://127.0.0.1:4630. In it you can read each doc, add a note under any paragraph, list,
table or code block, link a different repo, and generate again.

### From a clone

```sh
git clone https://github.com/excellent-so/selfdocs.git
cd selfdocs
node bin/selfdocs.mjs build --mock --target=fixture
node bin/selfdocs.mjs open --target=fixture
```

That documents `fixture/`, a small Express app the tests use.

## What it does

1. **Scans** the repo into a manifest of files with content hashes. It honours `.gitignore` and detects the
   project type, framework, test runner, CI and package manager.
2. **Drafts** five docs: architecture, schema, API, data flow and integrations. For each one it picks the files
   that match that doc's patterns and passes them to the `claude` CLI with a list of the repo's files and
   directories, and asks the model to name only what it was given. A doc whose patterns match no file (data flow
   in an app with no workers or queues, say) reads the entry points, routes and models instead.
3. **Checks** the markdown: one H1, the sections each doc needs, balanced code fences, tables with alignment rows,
   heading levels in order. It repairs what it can and asks the model to fix the rest, up to twice.
4. **Keeps your notes.** Each doc is split into blocks, and each block is anchored by its heading path. A note is
   pinned to the block above it. On a regeneration, drafted blocks update in place and notes stay with their
   anchors. If a section disappears, its notes move to a list of detached notes at the end of the doc, and each
   goes back in place if its section returns.
5. **Serves** the viewer: one HTML file with no external requests, on 127.0.0.1.

## Commands

| Command | What it does |
|---|---|
| `selfdocs build` | Scan the repo and draft its docs into `.selfdocs/` |
| `selfdocs build --mock` | The same, with the offline generator: no CLI, no network |
| `selfdocs build --type=architecture,api` | Only these doc types |
| `selfdocs serve` | Serve the viewer |
| `selfdocs open` | Serve the viewer and open it in your browser |
| `selfdocs status` | What's drafted, with block and note counts |
| `selfdocs doctor` | Check the `claude` CLI, the config and what the repo was detected as |
| `selfdocs init` | Write a starter `selfdocs.config.mjs` in the current directory (`--force` overwrites one) |
| `selfdocs --help` | The commands and their flags (also after any command, as in `selfdocs build --help`) |
| `selfdocs --version` | The version |

Every command except `init` takes `--target=DIR`, the repo to document (default: the current directory, or the
directory of the nearest config file). `build` also takes `--ignore=a,b` for extra ignore patterns and
`--model=NAME` (default `claude-sonnet-4-6`). `serve` and `open` listen on port 4630; set `PORT` or pass `--port=N`
to change it. If the port is taken they try the next one, up to 25 ports higher. A flag's value can follow `=` or a
space (`--type api`). An unknown command or flag stops with a message rather than being ignored.

The doc types are `architecture`, `schema`, `api`, `data-flow` and `integrations`.

## Configuration

Every key is optional. selfdocs looks for `selfdocs.config.mjs`, `.js`, `.cjs` or `.json` in the current
directory and the ones above it. `selfdocs init` writes a starter file:

```js
// selfdocs.config.mjs
export default {
  // The repo to document, relative to this file. Default: this directory.
  target: ".",

  // Extra .gitignore-style patterns, on top of the built-in defaults and your .gitignore.
  ignore: ["examples/**", "*.generated.ts"],

  // Which doc types to generate. Default: all five.
  docTypes: ["architecture", "schema", "api", "data-flow", "integrations"],

  // The model passed to the claude CLI (ignored with --mock).
  model: "claude-sonnet-4-6",
};
```

Environment variables: `SELFDOCS_TARGET` (the repo to document), `SELFDOCS_CLAUDE_BIN` (the `claude` binary to
run), `PORT` (the viewer's port) and `SELFDOCS_DEBUG` (set it to print the stack trace of an unexpected error).

## Where the output goes

Everything is written to `.selfdocs/` in the repo being documented, as plain JSON:

```
.selfdocs/
  manifest.json            the latest scan: files, hashes, detected stack
  docs/architecture.json   drafted blocks and your notes, each anchored
  docs/schema.json
  docs/api.json
  docs/data-flow.json
  docs/integrations.json
```

Add `.selfdocs/` to `.gitignore` to keep it out of version control. To keep your notes in version control,
commit `.selfdocs/docs/` and ignore `.selfdocs/manifest.json`.

selfdocs writes nothing else: nothing in your home directory, and `selfdocs.config.mjs` only when you run
`selfdocs init`. The viewer keeps your light or dark choice in the browser's local storage.

## What goes over the network

selfdocs itself makes no network requests. The viewer listens on 127.0.0.1 only and loads nothing from outside:
its fonts are embedded. `--mock` stays on your machine.

A real build runs your `claude` CLI, which sends the files selfdocs picked to Anthropic under your Claude account
(your subscription or API key pays for it). Values in `.env` files are replaced with `<redacted>` first;
`.env.example` and `.env.sample` are sent as they are. Binary files are never sent. The CLI runs with every tool
disabled, with no MCP servers (`--strict-mcp-config`) and without your own CLAUDE.md, hooks and plugins
(`--safe-mode`, on CLIs new enough to have it), so the model sees only what selfdocs sends.

## Limits

- **Real drafts need the `claude` CLI**, installed and signed in, on your `PATH` or at `SELFDOCS_CLAUDE_BIN`.
  Without it, `selfdocs build` stops and suggests `--mock`, and the viewer's Generate button uses the offline
  generator. If the CLI isn't signed in, the build stops and says to run `claude auth login`. A call that hasn't
  answered after 10 minutes is stopped.
- **A real draft sends code to the model.** See [What goes over the network](#what-goes-over-the-network).
- **Large repos are read in part.** Each doc gets an estimated 80,000 tokens of source (320,000 characters),
  and any one file is cut at 50,000 characters. A doc reads its closest-matching files first, then looser
  matches, until that budget runs out. If the model says the context is too large, selfdocs retries once with
  half, and if that's still too large it stops and suggests `--ignore`. Symlinked directories aren't followed,
  and a symlinked file counts only if it points inside the repo.
- **The checks cover structure.** They don't check facts. A model given little code can still describe what
  projects like yours usually contain, so read the drafts against the code and put corrections in notes.
- **Notes follow position within a section.** A note is pinned to "the second paragraph under Overview", say. A
  regeneration that rewrites the section keeps the note under its second block, and one that renames or drops a
  heading detaches the notes under it until a heading of that name returns.
- **`--mock` drafts from the file scan alone**: file paths, file counts per directory and the detected stack.
  It doesn't read your code for meaning, so its docs are scaffolds that name what the scanner saw and say what
  it couldn't infer. It's there to try selfdocs, and for tests and CI.
- **The five doc types are fixed.**
- **The viewer has no login.** It listens on 127.0.0.1 only and refuses writes from other origins. It's meant for
  your own machine.

## Uninstall

```sh
npm rm -g @excellent-so/selfdocs   # or npm rm -D @excellent-so/selfdocs in a project
```

Then delete `.selfdocs/` (and `selfdocs.config.mjs`, if you made one) in each repo you documented. Nothing else is
left behind.

## Development

```sh
npm test                  # the test suite: offline, no dependencies
npm run test:standalone   # build --mock from the published files with HOME, PATH and the environment stripped
```

The viewer's look comes from [@excellent-so/kit](https://github.com/excellent-so/kit), written into
`viewer/index.html` between the `excellent-kit` markers. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## License

MIT. See [LICENSE](./LICENSE).
