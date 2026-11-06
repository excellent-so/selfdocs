# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - Unreleased

The first release.

### Added

- **`selfdocs build`** scans a repo and drafts five docs (architecture, schema, API, data flow, integrations)
  with the local `claude` CLI, run with `-p --output-format=json`, every tool disabled, no MCP servers
  (`--strict-mcp-config`) and none of your own CLAUDE.md, hooks or plugins (`--safe-mode`, dropped for a CLI too
  old to know it). `--type=` picks doc types; `--target=`, `--ignore=` and `--model=` narrow the run.
- **`--mock`**, an offline generator that drafts the same five docs from the file scan alone, with no CLI and no
  network.
- **The scan**: a recursive walk with content hashes, a `.gitignore` matcher written for this package, and
  detection of the project type, framework, test runner, CI and package manager.
- **Context selection** per doc type, with an estimated budget of 80,000 tokens, a 50,000-character cap per
  file, a list of the repo's files and directories, and `.env` values redacted before anything is sent. A doc
  whose patterns match no file reads the entry points, routes and models instead, and the prompt tells the model
  to name only what it was given.
- **Markdown checks and repair**: one H1, required sections, balanced code fences, table alignment rows and
  heading order, fixed in place where possible and sent back to the model up to twice.
- **Notes that survive regeneration.** Docs are stored as anchored blocks; a regeneration merges new blocks into
  the stored ones by anchor. A note whose section disappears is detached and listed at the end of the doc, and
  goes back in place when the section returns.
- **File-first storage** in `.selfdocs/` (`manifest.json` and `docs/<type>.json`), with no database.
- **The viewer** (`selfdocs serve`, `selfdocs open`): one HTML file with no external requests, on 127.0.0.1,
  port 4630 by default (`PORT` or `--port=`; it tries up to 25 ports higher when one is taken). It lists the doc
  types, renders each doc, adds, edits and deletes notes, links a different repo and generates from the browser.
  Its writes refuse other origins. It's built on [@excellent-so/kit](https://github.com/excellent-so/kit) 0.2.1
  (MIT): light by default with dark as the reader's choice, ink and greys for every state.
- The viewer embeds Geist and Geist Mono, so it looks the same on every machine and still makes no outside
  requests.
- **Its own mark**: a page with two lines and a cursor, drawn in ink on a 16-unit grid. It sits left of the name
  in the viewer's brand row, is the viewer's favicon (an inline SVG, dark on a light browser and light on a dark
  one) and heads the README (`docs/mark.svg`). The viewer's footer has the licence and a Code link to the repo,
  and nothing else.
- **A public home** at [github.com/excellent-so/selfdocs](https://github.com/excellent-so/selfdocs):
  `homepage`, `repository` and `bugs` in `package.json`, the README's clone URL, the viewer's Code link and the
  link in the config `selfdocs init` writes. A test checks that every link to the repo matches `package.json`.
- **`selfdocs status`**, **`selfdocs doctor`** and **`selfdocs init`** (a starter config that links to the
  project page in `package.json`; `--force` overwrites one), **`--help`** after any command, and **`--version`**.
- **Tests**: `npm test` runs 42 offline tests with no dependencies, using stand-in `claude` scripts where a test
  needs one. `npm run test:standalone` runs
  `build --mock` from the published files with an empty HOME, a reduced PATH and an environment built from
  scratch, with nothing else installed.

### Fixed

Found by testing the package the way a stranger would: installed from the tarball with an empty `HOME`, on Node
20, 22 and 24, against small public Express and Go apps, with the real `claude` CLI.

- Every mistake now gets one sentence, what to do, and exit 1, with no stack trace: an unknown command (it
  printed the help and exited 0), an unknown flag (it was ignored, so `build --mokc` started a real build), a flag
  with no value, a `--target` that isn't a folder, a config file that doesn't parse, an empty folder (it drafted
  five docs about nothing), and `--port=abc` or `--port=99999`.
- `selfdocs build --help` ran the build. `--help` now works after any command.
- A `claude` CLI that isn't signed in, can't use the model, has hit a usage limit, crashes, or answers with
  something other than JSON is reported with what to do (`claude auth login`, `--model`, wait, or `--mock`).
  The viewer's Generate shows the same hint.
- A context still too large at half the budget stopped with a stack trace; it now suggests `--ignore`.
- When the viewer's port was busy, it printed its address once per port tried, and `open` opened a browser
  tab for each.
- A symlink to a parent directory made the scan list the repo again at every level; with two, it never ended.
  Directory links aren't followed, and a file link counts only when it points inside the repo.
- Binary files with unfamiliar extensions (`.docx`, `.onnx`) were sent to the model as text.
- `.mjs`, `.cjs`, `.tsx` and `.jsx` files, root-level `routes/`, `models/` and `config/` directories, Go
  entry points and `routers.go` never matched a doc's patterns, so a Go project's architecture doc read no Go.
- With no matching files, the data-flow doc of an Express app described files that don't exist. The model now
  gets the entry points, routes and models, a list of every file, and a closing instruction to stay inside them.
- The tree sent to the model listed directories only, so it reported a missing Dockerfile that was there.
- The `claude` timeout was 3 minutes and one real doc took 2; it is now 10.
- gin, echo, fiber, chi and gorilla are detected from `go.mod`, and Django, FastAPI and Flask from
  `requirements.txt`, `setup.py`, `setup.cfg` and `Pipfile` as well as `pyproject.toml`.
- `.env` redaction covers `export KEY=value`, `key: value` and lowercase names.
- In the viewer, code in a narrow table column broke mid-word ("DELET E"), and a note that failed to save left
  an unhandled promise rejection in the console.
- `--mock` drafts named the repo root `(root)/`.
- Hints such as "view them: selfdocs open" named the installed command even when selfdocs ran through `npx` or
  from a clone, where that command doesn't exist. They now name the command the way you ran it.
