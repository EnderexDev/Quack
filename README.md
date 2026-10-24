# Quack

Two-way sync between Roblox Studio and your files, for people who work on more than one game at
a time. Studio is the source of truth: the folder on disk mirrors what is in Studio, and a save
on disk goes back into Studio as you type.

Quack started as a fork of [Azul](https://github.com/Ransomwave/azul). If you already use Azul,
the sync works the same way; what Quack adds is everything around it.

## What Quack adds

- **One hub for every Studio.** No terminal per game and no port per place: the hub listens on
  one port and runs a sync for each game, so several places sync at once, each into its own
  folder.
- **Merges, not overwrites.** When Studio and the disk change the same script at once, Quack
  merges them, by text first and, when that cannot, by AI (optional, see below). The disk
  version it did not use is kept under `.quack/conflicts/`, so no edit is ever lost.
- **A tray app.** Each game's output, playtest log, merges and conflicts in one window, and a
  question before one connection takes a folder or a place from another.
- **The Studio plugin connects on its own** to registered places, and a place can be told to
  never sync.
- **Terminal control.** `quack status`, `quack wait`, `quack conflicts` and more, with `--json`
  on every command, for scripts and editors.

Everything Azul's sync does is still there: the full DataModel mirrored as folders, `build`,
`push` and `pack`, the Studio console streamed to the terminal, Rojo import, and a
Rojo-compatible `sourcemap.json` for luau-lsp.

## Install (Windows)

1. Install [Node.js](https://nodejs.org) 20.19 or newer. The hub runs on it.
2. Download the installer from the
   [latest release](https://github.com/EnderexDev/quack-releases/releases/latest) and run it.
   The app installs the Studio plugin for you and updates itself.
3. Open your place in Studio. The plugin connects, and the app asks where the game's folder
   goes: pick an existing folder or let Quack make one.

From then on, opening that place syncs it. The scripts live in the folder's `sync/`, and
Quack's own files (the log, the saved conflict copies) in `.quack/`.

### The AI merge (optional)

When a text merge cannot settle a conflict, Quack can hand it to an AI coding CLI already
installed and logged in on your computer: [Claude Code](https://claude.com/claude-code) or
[Codex](https://github.com/openai/codex). It uses your own account, with no extra key. Without
either, Quack keeps Studio's version and saves yours under `.quack/conflicts/`. Turn it on or
off in the app or with `quack ai on|off`.

## Commands

The app puts `quack` on your PATH. It talks to the hub the app runs.

```
quack status                 the hub, the AI merge and every place: Studio connected, conflicts
quack log <place> -f         a place's log, followed (a place is an id or part of its name;
                             left out, the place whose folder you are in)
quack wait <place>           until Studio is connected and nothing synced for 1.5 s
quack conflicts              then: conflict <id>, resolve <id> --disk|--keep
quack doctor                 checks the hub, the plugin and the registered folders
quack play [-w <folder>]     a playtest with the scripts of a git worktree
quack register | unregister | pause | resume | open | ai | restart-hub
```

`quack --help` lists every option. Exit codes: 0 ok, 1 error, 2 hub not running, 3 `wait` timed
out. Commands that change something ask first; `--yes` skips the question.

`build`, `push` and `pack` work as in Azul, from the sync CLI (`node dist/cli.js`, see
`--help`). They listen for the plugin themselves, so they run while no hub holds the port.

## Build from source

```
npm ci
npm test                     builds and runs every test
node plugin/scripts/build-rbxmx.mjs [out.rbxmx]
                             the Studio plugin; with no path it goes straight into
                             Studio's Plugins folder, replacing the installed one
```

The tray app is Tauri 2 (Rust): see `app/README.md`. The repo has two builds side by side, the
official one (port 3825, `quack`) and a development one (port 3826, `quackdev`), so a change can
be tried without touching the installed app.

| | |
|---|---|
| `src/` | the sync of one game, the hub (`src/hub/`), the CLIs |
| `app/` | the tray app |
| `plugin/` | the Studio plugin |

## License and origin

Quack is a modified version of [Azul](https://github.com/Ransomwave/azul) by Ransomwave, forked
in October 2026 and changed since (the hub, the app, merges, the plugin and most of the sync).
Like Azul it is licensed under the GNU General Public License v3.0, in `LICENSE`.
