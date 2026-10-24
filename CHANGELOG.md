# Changelog

## 1.0.0 (2026-10-20)

Quack's own numbering starts here. The 2.4 plugin from before keeps connecting to a 1.0 hub
until its place is reopened with the new plugin.

- One hub for every Studio, a daemon per game, and the tray app (Official and Dev builds)
- Merges of edits that crossed between Studio and the disk, conflict view in the app
- One connection per folder and per place; taking one over is asked in the app
- Plugin: its own look and layout, a "Sync this place" switch, quieter pop-ups
- Sourcemaps are stamped `_quack` (folders stamped `_azul` before are still recognised); the
  place config lives in `ServerStorage.Quack` (`ServerStorage.Azul` is still read)
- No update check against npm
