# Changelog

All notable changes to this project are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - Unreleased

The first release.

### Added

- **`selfdocs build`** scans a repo and drafts five docs (architecture, schema, API, data flow, integrations)
  with the local `claude` CLI, run with `-p --output-format=json` and every tool disabled. `--type=` picks doc
  types; `--target=`, `--ignore=` and `--model=` narrow the run.
- **`--mock`**, an offline generator that drafts the same five docs from the file scan alone, with no CLI and no
  network.
- **The scan**: a recursive walk with content hashes, a `.gitignore` matcher written for this package, and
  detection of the project type, framework, test runner, CI and package manager.
- **Context selection** per doc type, with an estimated budget of 80,000 tokens, a 50,000-character cap per
  file, and `.env` values redacted before anything is sent.
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
- **Its own mark**: a page with two lines and a cursor, drawn in ink on a 16-unit grid. It sits left of the name
  in the viewer's brand row, is the viewer's favicon (an inline SVG, dark on a light browser and light on a dark
  one) and heads the README (`docs/mark.svg`). The viewer's footer has the licence and a Code link to the repo,
  and nothing else.
- **A public home** at [github.com/excellent-so/selfdocs](https://github.com/excellent-so/selfdocs):
  `homepage`, `repository` and `bugs` in `package.json`, the README's clone URL, the viewer's Code link and the
  link in the config `selfdocs init` writes. A test checks that every link to the repo matches `package.json`.
- **`selfdocs status`**, **`selfdocs doctor`** and **`selfdocs init`** (a starter config that links to the
  project page in `package.json`).
- **Tests**: `npm test` runs 28 offline tests with no dependencies. `npm run test:standalone` runs
  `build --mock` from the published files with an empty HOME, a reduced PATH and an environment built from
  scratch, with nothing else installed.
