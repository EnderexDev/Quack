# Changelog

All notable changes to Quack are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are the tags of this repo; each one
has release notes with the details and the source commits.

## [1.0.4] - 2026-10-27

### Added
- `quack wait` lists script files on disk that have no instance in Studio the sync knows (new `GET /api/unsynced` on the hub).
- `quack wait --fix` sends the create of each listed file again, once; Studio reuses a script already there, so nothing is duplicated. The MCP `wait` tool takes `fix` too.
- The daemon sends a script create again when Studio has not answered it after 3 s, up to 3 tries, then logs an error.

### Changed
- A file created or deleted from outside, and an instance deleted from outside, are logged at info like an edit.

### Fixed
- After the native watcher overflowed, the rescan skipped known folders, so a new script in an existing folder (a git merge or fast-forward) never reached Studio. The rescan now walks known folders too.
- A create answered while another operation held the plugin's outbound sync off (a `quack play` of another session) made the script in Studio but never mapped it. The reply to a create or move from disk now goes out anyway.

## [1.0.3] - 2026-10-26

### Changed
- `connect-ai` and `ai-clients` treat every Claude Code and Codex config folder as its own target: the default one, `CLAUDE_CONFIG_DIR` / `CODEX_HOME`, `~/.claude-*` and `~/.codex-*` folders, and each T3 Code provider's home. A Claude folder pointed at CLIProxyAPI (`localhost:8317`) is labeled as such.
- `connect-ai` takes a kind (every folder of it) or one target's id (`claude:<folder>`, `codex:<folder>`); the `--json` output gains `id` and `dir`.
- Each call sets `CLAUDE_CONFIG_DIR` or `CODEX_HOME` for its target, and the default target unsets the variable so it never lands in the calling session's folder.

### Fixed
- An MCP added to the default Claude Code or Codex folder never reached sessions that run in another config folder.

## [1.0.2] - 2026-10-26

### Added
- `quack mcp` / `quackdev mcp`: an MCP server on stdio with the tools `status`, `wait`, `log`, `conflicts`, `conflict`, `doctor` and `play`, and instructions on how to use Quack. Changing the hub stays out of it on purpose.
- `quack ai-clients` and `quack connect-ai [claude|cursor|codex]...` list and configure Claude Code, Cursor and Codex. An unreadable `~/.cursor/mcp.json` is never written over.
- Settings has a "Your AI and Quack" card with a `Connect to AI` button (first click looks, second connects).

### Changed
- The name is drawn as the logo's lockup (the Q mark beside "Quack" in Fredoka with a gold gradient, green in Dev) in the app, the tray header and the plugin's top bar. The tray head loses the sky and the avatar.

### Fixed
- The tray footer's three buttons needed 299 px of the panel's 290, so `Quit` spilled past the edge.

## [1.0.1] - 2026-10-25

### Added
- `quack play` reports conflicts: a script the branch changed that Studio holds with other text is listed with its reason, and the play still runs the branch's text.
- `quack play` names the likely cause when its check fails on a script with the place's text (a tab open and edited in the Studio running the play).

### Changed
- `quack play` swaps only what the branch changed since it forked (the worktree's diff against the merge-base with the registered checkout). Studio's own uncommitted edits, and what main gained after the fork, are no longer reverted or turned off.
- A branch with no script change since it forked says so.

### Fixed
- The check line read `N of N`; it now divides by the checks sent.
- A swap Studio refused printed only "could not be swapped in"; it now lists the failed scripts.

## [1.0.0] - 2026-10-25

First tagged release. Quack 1.0 itself is the root commit of this repo (see the history below).

### Added
- Release workflow (`.github/workflows/release.yml`): a pushed `v*` tag runs the tests, builds the signed Official app and publishes the installer, its signature and `latest.json` as a release of this repo. It can also run by hand as a draft.
- `QuackService.isTeamCreate()`.

### Changed
- The Official updater reads `latest.json` from the latest release of `EnderexDev/Quack` instead of `EnderexDev/quack-releases`.
- Snapshot scripts are written 32 at a time (20 writes in Team Create: 5.3 s in sequence, 281 ms side by side).

### Fixed
- In Team Create, writing a script by `.Source` left a collaborator's open tab on the old text, and their next keystroke wrote it all back. Existing scripts now go through the editor or `UpdateSourceAsync` there; `.Source` stays outside Team Create and for new instances.
- Text typed while a Team Create write was in flight could be overwritten; it is now sent for a merge instead.
- Patches of one script are applied one at a time, in arrival order, so a write that yields no longer lets the next patch read stale text.

## History

What follows is the changelog as it stood before the tagged releases, kept as it was.

### 1.0.0 (2026-10-20)

Quack's own numbering starts here. The 2.4 plugin from before keeps connecting to a 1.0 hub
until its place is reopened with the new plugin.

- One hub for every Studio, a daemon per game, and the tray app (Official and Dev builds)
- Merges of edits that crossed between Studio and the disk, conflict view in the app
- One connection per folder and per place; taking one over is asked in the app
- Plugin: its own look and layout, a "Sync this place" switch, quieter pop-ups
- Sourcemaps are stamped `_quack` (folders stamped `_azul` before are still recognised); the
  place config lives in `ServerStorage.Quack` (`ServerStorage.Azul` is still read)
- No update check against npm

[1.0.4]: https://github.com/EnderexDev/Quack/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/EnderexDev/Quack/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/EnderexDev/Quack/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/EnderexDev/Quack/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/EnderexDev/Quack/releases/tag/v1.0.0
