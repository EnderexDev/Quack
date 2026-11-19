# Quack app

Tray icon and window over the Quack hub (`src/hub`), in Tauri 2. The Rust side starts the hub when
nothing answers on its port (or uses the one running), polls `GET /api/state` once a second, swaps
the tray icon and relays the windows' calls: the hub refuses a web Origin, and the webview is one.
Quitting from the tray panel (either click on the icon opens it) stops the hub only if this app started it (`POST /api/shutdown`, so its
daemons stop too). Closing the window keeps it in the tray.

## Run, build, install

- Development: `npm run build` at the repo root (the hub), then `cargo run` in `app/src-tauri`. The
  debug build opens a console window; the UI is embedded at compile time, so a change in `ui/`
  needs a rebuild.
- Release and installer: `npx @tauri-apps/cli@2 build` in `app/`. It first runs
  `npm run bundle:hub` (tsc, then `scripts/bundle-hub.mjs`), which writes the hub and the daemon
  as two single files, `src-tauri/resources/hub/hub.mjs` and `daemon.mjs` (esbuild, version baked
  in), shipped inside the installer. Writes
  `src-tauri/target/release/bundle/nsis/Quack Dev_<version>_x64-setup.exe`; `/S` installs silently
  to `%LOCALAPPDATA%\Quack Dev` for the current user.
- Icons: `node app/scripts/icons.mjs` after changing `app/assets/*.svg`.

## Which hub runs

- Installed (release): `node %LOCALAPPDATA%\Quack Dev\resources\hub\hub.mjs`, its own copy, so a
  build in this repo does not change it; reinstalling does. It needs a `node` on PATH.
- Debug (`cargo run`): this repo's `dist/hub/main.js`, so hub changes need only `npm run build`.
- The terminal command ships the same way (`resources/hub/cli.mjs`). On start the release app
  writes `bin\quackdev.cmd` (Official: `bin\quack.cmd`) next to it, naming its flavor, and adds
  that `bin` to the user PATH once. Uninstalling leaves the PATH entry (it points at nothing).
- `hubEntry` in the settings overrides both. `%APPDATA%\quack\hub-app.log` (Dev: `hub-dev-app.log`) says which one each
  start used (`===== quack app starts <entry> =====`). The app uses a hub already answering on the
  port instead of starting its own, so after reinstalling, a hub from before keeps running until
  it stops.
- Defaults are the development hub: port 3826, registry `%APPDATA%\quack\hub-dev.json`.
- Settings: `%APPDATA%\dev.enderex.quack.dev\settings.json` (language, notifications, hub port,
  registry, hub entry, node). The daemon's own settings (`%APPDATA%\quack\config.json`) are shown
  read only: the standalone Quack on 3825 reads that file too.

## Checking the windows without the mouse

Start the app with `WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333`; the pages
(`http://tauri.localhost/` and `/tray.html`) then take DevTools protocol commands: evaluate a click,
capture a screenshot. Close it afterwards: that port lets any local process drive the windows.

`QUACK_TEST_PROFILE=<an existing absolute folder>` (with `QUACK_TEST_PORT`, default 3839; never
3825 or 3826) runs a build isolated from the installed apps: settings, approval token, hub log,
registry and the hub's own `%APPDATA%\quack` go under `<folder>\appdata` (its child processes get
that as `APPDATA`), WebView2 data under `<folder>\webview`, its single-instance key is its own,
and it copies no plugin, writes no command or PATH entry, adds no autostart entry, looks for no
update and shows no tray icon. Its windows open off screen, shown but never activated. Read only,
it still looks at the real Plugins folder (the plugin version in Settings), the editors installed
and the AI clients (Connect to AI lists them; connecting is refused). `src-tauri/src/test_profile.rs`.

`node app/harness/real-window.mjs --out <dir> [--build] [--example-place]` does it all: a profile
in the temp folder, a free hub port and debugging port, a capture of each page through DevTools,
then the app quit through its own command, any process it left ended by PID, and the profile
removed. It fails the run if the app ever owned the foreground window. With an empty registry the
tabs stay disabled; `--example-place` registers a made-up place in a folder of the profile, so
each tab opens (its daemon starts only when a Studio connects, which no Studio can: the plugins
reach only the hubs on 3825 and 3826). The hub's Open Cloud vault is the registry's folder, so a
test hub has no key.
