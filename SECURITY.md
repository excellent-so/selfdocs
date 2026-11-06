# Security

## Reporting a vulnerability

Please report security issues privately to **matt@excellent.so**. Do not open a public
issue.

Include a description of the issue, steps to reproduce, and any relevant version
information. You'll get a response within a few business days.

## Supported versions

The supported version is the **latest release on npm** (`@excellent-so/selfdocs`).
Older versions do not receive security fixes.

## Scope

`selfdocs` is a local-only CLI tool. It reads files under the target repo, writes only
to that repo's `.selfdocs/` directory, and serves a viewer bound to `127.0.0.1`. It has
no cloud component and no auth tokens.

- **Doc generation** shells out to the `claude` CLI already on your machine (or, with
  `--mock`, no external process at all). The CLI is spawned with all tools disabled
  (`--disallowedTools "*"`). `.env` values are redacted before any file content is
  sent to the model; `.env.example` / `.env.sample` templates are sent as-is.
- **The viewer server** binds to loopback only. Its mutating routes
  (`POST`/`PATCH`/`DELETE /api/blocks`) carry an Origin guard so a cross-origin web
  page can't drive annotation writes while the viewer is open. Static file serving is
  path-contained to the packaged `viewer/` directory.

Security issues most likely to matter: path traversal in config or static serving,
unsafe shell-out to a user-supplied binary (`SELFDOCS_CLAUDE_BIN`), unintended writes
outside `.selfdocs/`, or leaking secret file contents into a generated doc.
