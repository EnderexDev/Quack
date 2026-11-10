# Changelog

All notable changes to Quack are listed here, newest first. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Versions are the tags of this repo; each one
has release notes with the details and the source commits.

## [Unreleased]

## [1.0.26] - 2026-11-10

### Fixed
- A `quack play` could leave the branch's text in the place: in a big Team Create place, Studio sometimes held a swapped script's branch text again a few seconds after the swap was undone, and the sync wrote it to the place's folder as an edit from Studio, where a commit could pick it up. The plugin now puts the place's text back and sends nothing. For 20 seconds after a play, the daemon refuses that exact text from Studio and sends the place's text back, also when another play started in between. The daemon log also lists the tabs the play closed before the swap.

## [1.0.25] - 2026-11-10

### Added
- Publishing goes through the Studio queue: `quack queue publish [place] [--commit <sha>] -- <command>` waits for Studio like any client, stops the queue's play first (Studio publishes nothing during a play), then runs the command that publishes. Studio publishes everything it holds, so one publish answers every client waiting to publish that it covers: a `--commit` already in the synced checkout it shipped, or a client that asked before it took Studio. Those exit 0 with that publish's version and run nothing. A failed publish covers nobody, and the next client in line publishes. A commit that is not in the synced checkout yet is refused, and one an earlier publish already shipped is answered at once.
- `quack queue` and the app's Queue tab show who is publishing, how many ride on that publish, and the last publish.

## [1.0.24] - 2026-11-10

### Added
- `quack changes --balance` (the MCP's `studio_changes` with `balance`) lists the balance: files only Studio changed since the last commit, and only in numbers, a designer tuning values. `--commit-balance` (`commitBalance`) commits exactly those in their own "Balance: values tuned in Studio" commit, then pushes. Every other change, and whatever is staged, stays as it was. A file Studio writes again while the commit runs is named, and the push is skipped.

## [1.0.23] - 2026-11-10

### Added
- Settings shows the version of the Studio plugin ("Studio plugin"), next to the app's. Not every app update changes the plugin, so the two can differ.

### Changed
- The plugin's header shows its own version, the app version that last changed the plugin, instead of a fixed 1.0.0. An app update that leaves the plugin alone no longer rewrites it in Studio's Plugins folder. The plugin's new number shows after the place reopens.

## [1.0.22] - 2026-11-10

### Added
- `quack place versions` (and the MCP's `list_place_versions`) marks each version players got as `published`; the others were only saved. It tells a fix shipped to players from one only saved in Studio.

### Fixed
- The help of `quack asset upload` and the MCP's `upload_asset` still said the key came from an environment variable or a plain-text file. They now say Quack's hub uploads with the key it keeps encrypted, and the creator is the one in the app's Settings.

## [1.0.21] - 2026-11-10

### Changed
- Each GitHub release carries its version's section of this changelog as its notes, instead of only "Quack 1.0.N". This file now covers 1.0.7 to 1.0.20, which went out without it.

## [1.0.20] - 2026-11-10

### Fixed
- The value glued to an option was also read as if it were a command or a folder change, which could make the guard misjudge the words after it. A glued value is now checked as a path only, never as a command or a `cd`.
- `cd -Path` and `cd -LiteralPath` (and `Set-Location` with them), glued or not, now move the folder where the following words are judged, as a plain `cd` already did.

## [1.0.19] - 2026-11-10

### Fixed
- The guard did not read the value glued to an option (`-Path:$env:APPDATA/qua?k`, `--dir=...`) as a word, so a path to Quack's files written that way passed. It is now resolved and checked like any other path in the command.

## [1.0.18] - 2026-11-10

### Fixed
- A recursive `**` in a pattern had to match at least one folder, so `quack/**/open-clou?.key` passed although it names `quack/open-cloud.key`. `**` now matches zero folders too, and the command is refused.
- A wildcard that names a folder holding Quack's files (`qua?k`, `Roaming/*`, `quack*`) passed as the source of a recursive copy or an archive. It is now refused for `cp -r`, `Copy-Item -Recurse`, `tar`, `zip`, `robocopy` and the other archive and mirror commands, which now count as recursive.
- A command with 20,000 unclosed `[` brackets made the guard slow. It now answers in linear time.

## [1.0.17] - 2026-11-10

### Fixed
- The guard refused ordinary commands in a real session: a `grep` pattern with an escaped star, and a commit message that held a slash and a star, were each read as the root folder with a wildcard. A wildcard now counts only when it can match one of Quack's own files (the key vault, its old plain-text file and the two approval tokens), for this user or the user the path names. A backslash before a wildcard escapes it outside a Windows path.
- Code comments, search patterns, the top folder of a home and other files in AppData now pass. `quack*/*`, `App*/Roaming/quack/open*` and `Users/*/.../dev.enderex.quack*/*` are still refused.

## [1.0.16] - 2026-11-10

### Added
- The live game's Open Cloud, used by name through the hub: `datastore` (stores, keys, values by dot path, versions, set, increment, delete), `config` for experience configs (get, draft, set, publish), `universe`, `servers restart`, `message publish`, `memory-store`, `leaderboard` and `ban`. MCP tools: `datastore`, `experience_config`, `get_universe`, `update_universe`, `restart_servers`, `publish_message`, `memory_store_sorted_map`, `memory_store_queue`, `flush_memory_store`, `ordered_data_store` and `user_restriction`. Reads run at once. Ban lengths read as days, hours and minutes, not seconds.
- Badges, developer products, game passes, the localization table and the Analytics Query API as hub operations (`badge`, `product`, `gamepass`, `loc`, `analytics`; MCP `badges`, `developer_products`, `game_passes`, `localization`, `analytics_query`). A badge is refused when the free quota is 0 unless you pass `--spend`, and 100 Robux or more needs it too.
- `luau` / `luau_run` runs a script on a Roblox server through Open Cloud's Luau Execution API, on the latest saved version of a place or a version you name, and returns its output and return values.
- `cloud check` / `cloud_permissions` asks Roblox what the key may do and lists which Quack tools each missing scope leaves out.
- `changes [place] [--numbers-only]` / `studio_changes` lists the uncommitted files in a synced folder and marks each one `studio` (on disk as Studio wrote it), `mixed` or `other`. `--numbers-only` marks the Studio files that differ from the last commit only in numbers. The daemon records what it writes in `.quack/studio-writes.json`, up to 1000 texts per run of Studio writes, and the record survives a daemon or hub restart.
- `move_player` / `move` moves the character in a play by teleport, walk or path, until it arrives, gets stuck or times out (15 s by default). `find_instances` with a peer searches the running play by name, class, attribute and tag, 50 results by default.
- `import_rbxm` takes a whole place file: `list` reads it without Studio, `paths` brings back only the items you pick into their own parents, and a place with no paths lands under ServerStorage. Scripts in a place file land only with `scripts: true`. An XML model (`.rbxmx`) imports again like an `.rbxm`. An XML place (`.rbxlx`) is still refused, because it would skip the script check.
- More Studio and Open Cloud tools in the CLI and the MCP: `capture_micro_profiler`, `get_request_status`, `get_place_info`, `selection`, `generate_model`, `list_place_versions`, `download_place` and `open_place`. A call that timed out keeps its answer for 15 minutes, so `get_request_status` can read it instead of sending the call again.
- Connect to AI now sets up everything in one click: the MCP server, the rule written into Claude Code's `CLAUDE.md` and Codex's `AGENTS.md` (an older copy is replaced where you keep it, and the rest of the file is left alone), and the guard. Cursor gets the MCP server's instructions, since it keeps its rules in its own settings. Dev and Official keep separate rule blocks side by side. `ai-clients` reports the rule as current, outdated or missing, and the app shows "needs an update" for a client missing any part.
- Quack's guard: a hook that Connect to AI adds to each Claude Code folder's `settings.json`, one entry per flavor, with your other hooks kept and a broken `settings.json` never written over. It blocks an AI's shell commands and file tools that would read the key vault, the approval token or the old plain-text key file, decrypt with DPAPI, run the vault's code or automate Quack's app. A file tool is judged by where it points, not by the text it writes. Searches from Quack's folders or above them (AppData, Roaming, a home folder, a drive), wildcards, paths with `.`, `..`, `~` and `$env:APPDATA`, and PowerShell's encoded command (up to three levels deep) are checked. A folder connected before this shows "connected, no guard".

### Changed
- The Open Cloud key is kept encrypted with the Windows user's DPAPI and only the hub decrypts it. The CLI and the app can set it but never read it back. A plain key line in the old settings file moves into the encrypted store on first use. Upload, place versions and download now go through the hub, and the CLI says the key lives there when the hub is off.
- Every Open Cloud write waits for a yes in Quack's own app, one at a time. A chime plays, the window comes to the front minimized with a flashing taskbar icon, and a toast opens a window that shows the whole change, with Refuse as the default and Accept. No answer in 5 minutes counts as No. If the app is not running, the hub starts it and answers "Quack is opening: ask again". A change that does not fit in the window (2000 fields or 400,000 characters) is refused, not cut. Only the app can answer: the approval token never leaves the app and the hub.
- Before each write, the window shows every field that changes (before and after), names the experience, and says what the write costs players: a restart disconnects them, a private server removes everyone, a new private server price cancels every subscription, a ban also reaches alt accounts. Control, direction and zero-width characters show as `\u{XXXX}`, and a cloud Luau script that holds one is refused. A cloud script too long to show whole (over 40 lines or 4000 characters) is refused.
- A datastore save carries the version you saw, so a game save in between makes Roblox refuse it instead of being overwritten. A config publish carries the draft it showed and names the published keys the draft lacks. A delete reads the version again right before it.
- A write that got a 5xx answer, no answer or an answer that is not JSON now says it may have happened, instead of reporting a failure or an empty success.
- Quack needs Node 22.15 or newer: its zlib reads zstd, which newer `.rbxl` files use. `doctor` and the README say so.
- The rule and the MCP instructions name the new tools and say that Quack's app asks you before a write, not a window. A refusal is never retried.

### Fixed
- `micro` frame-time percentiles (p50, p90, p99) all read the slowest frame. They now read the right frame.
- `micro` could read frames from a capture made minutes earlier (a 500 ms capture read 255 frames, one of them far older, and a scope across the gap read as 166 s). It now reads only the frames of its own capture and says when an earlier one was left out.
- `micro` counted idle threads (Sleep on every worker, 53 ms a frame in an edit-mode place) in the scopes, groups and busy time. Idle scopes are left out unless you pass `--include-idle`, and a game's own scope named like Sleep is no longer dropped.
- `generate_model` rested the model on the wrong height when its primary part was tilted, and anchored nothing, so the parts fell apart. It rests on the world box, anchors the parts and keeps the pivot's rotation. The answer says its mesh has no asset id.
- `wait_for` reported its own limit (5000 ms) when a try was cut short by the deadline, even if the try had 400 ms. It now reports the time it had.
- A long wait made 120 entries in `get_request_status` and pushed a real call out of the 50 kept. `wait_for` tries no longer take an id.
- `move_player` could not find a target streamed out of the client. The server now finds the goal first.
- `download_place` promised an export from the file's Studio, which Quack's tools cannot reach. It now says to save what is missing and use `import_rbxm`.
- A `changes` commit in CRLF against Studio's LF made a long string look changed, and a number written like `1e1_0` read as two. Both read right now.
- A short saved Open Cloud key could show its last 4 characters as "undefined" (the CLI and Settings). A short key shows no end. An unreadable settings file is never replaced.

## [1.0.15] - 2026-11-09

### Added
- "Quack log in Output": a switch in the plugin (off by default, saved for every place) that also prints the daemon's log in Studio's Output. Warnings and errors print as warnings, and the rest follows the "Silent" setting. The daemon sends one message every 50 ms with at most 200 lines, and counts the rest (a first sync writes a line per script). An older daemon or plugin simply does not offer or ask for it.
- The "Open in editor" button opens the editor you work in: each VS Code fork (VS Code, Cursor, Windsurf, Antigravity and others), Zed and Sublime Text found on the machine. The one used last goes first, and an arrow beside the button lists the others. A pick is kept, and Settings > Code editor goes back to the one used last.
- `quack cloud` shows, sets and clears the Open Cloud key and the owner of uploads, keeping the settings file's other lines. The key comes on stdin (`--key-stdin`), never on the command line, and is never shown back, only its last 4 characters. Settings > Open Cloud does the same.
- A notice in the window asks you to give your AI the rule when it changed: a first install asks to teach the AI, and an update that changed the rule asks to pass on the new one. "I gave it to my AI" clears it.

### Changed
- An upload's error for a missing key or owner now points at the Open Cloud setting.
- The window redraws when the order of editors changes, not on every return from the editor.

## [1.0.14] - 2026-11-09

### Added
- `inspect_instance` / `inspect` shows the properties of an instance that differ from a new one of its class, plus attributes, tags, children, pivot and bounding box, in edit mode or in the play's server or client. `set_properties` / `set` changes properties and attributes together: everything is parsed first and put back if one fails, and it is one undo step in edit mode.
- `simulate_conditions` / `simulate` sets Studio's network simulation (delay, jitter, loss, with presets off, great, good and poor) and performance simulation (quality level and emulated memory), in edit mode and the play client.
- `script_tabs` / `tabs` lists the open script tabs and the edited ones, and closes them. `capture_devices` / `devices` takes a screenshot on each simulated device and joins them in one picture. `test_profile` / `profile` runs the place's profile save and restore functions.
- `get_roblox_docs` / `docs` reads an engine API page from create.roblox.com (one section at a time, cached for a day, cut at 50,000 characters with the list of sections). A name that does not exist gets the 5 nearest.
- `search_assets`, `get_asset_details` and `get_asset_thumbnail` search the Creator Store and read an asset's details and image. `preview_asset` loads an asset without keeping it and lists its scripts, flagging what a backdoor uses (`require` by id, `loadstring`, `getfenv`, `HttpService`). `insert_asset` inserts it with every script removed, as one undo step, and inserts nothing if a script is left.
- `upload_asset` uploads through Open Cloud and never uploads the same file twice: a log by file hash, type, name and creator returns the known asset or resumes its operation. An upload with no answer or a 5xx is not sent again without `force`, and the key is removed from every message.
- `get_memory_breakdown` shows memory by tag for the edit mode, server and client at once. `capture_script_profiler` lists the top functions by time with their share of the capture and saves the raw data under `.quack/profiler`. `get_scene_analysis` flattens Studio's six scene breakdowns, sorted.
- `quack rule` prints the rule for an AI, and Settings > "Your AI and Quack" copies it, with a prompt that tells the AI how to add it to its instructions file or replace an older copy. The MCP instructions are shorter (1.8 KB) and end by naming the rule's version.

### Changed
- `play` closes the open Studio tabs of the scripts it swaps and names them in its answer. A tab that was typed in gave the play its own text instead of the file's (31 plays in a month).

### Fixed
- Claude Code cut the MCP instructions at about 4 KB, in the middle of a sentence, so everything after `verify_sync` never reached the AI. They are now short and point to the full rule.
- `preview_asset` and `insert_asset` answered "User is not authorized to access Asset" for a free Creator Store model you do not own. They now load it the way the Toolbox does.
- `inspect` no longer lists derived read-only properties as differences.

## [1.0.13] - 2026-11-08

### Added
- `inspect_gui` / `quack gui` reads a GUI's tree, one line per object: class, text, image, position, modifiers, what hides it, and for a button whether a click reaches it. Children come in their layout's order; hidden subtrees and anything past the depth limit are counted. In a play it reads PlayerGui, in edit mode StarterGui.
- `simulate_mouse_input` / `quack mouse` clicks, double-clicks, presses or releases at a point on the last screenshot, or at the center of a GuiObject or a part. It answers with the GUI object under the point and the part a camera ray hits. There is no move or wheel, so no drag or scroll.
- `verify_sync` / `quack verify` checks that Studio holds the disk's text of each synced script, both the `.Source` and the open editor tab (the text a play copies), and lists only what differs: an older `.Source`, a tab with other text, an instance that is gone. It exits 1 when anything differs. With no file list it checks every script (1459 scripts in 612 to 700 ms in the Astral copy).
- `find_instances` / `quack find` searches the whole place by name (`*` and `?`, any case), by class and under a path, from the daemon's tree with no Studio call. Each script comes with its file.
- `perf_sample` / `quack perf` measures both play peers at once: client fps and frame time percentiles, server Heartbeat, hitches, memory by tag and engine Stats. A solo play runs both in one Studio process, and the answer says so.
- `set_logpoint` / `quack logpoint` prints Luau values when a script line runs, with no edit to the script. The script is named by its synced file or its instance path; add, remove, list and clear are supported. It needs a Studio beta feature and says so when it is off.
- `export_rbxm` / `quack export` writes instances to one `.rbxm` file (default `.quack/exports`). `import_rbxm` / `quack import` puts an `.rbxm`'s instances under a parent in one undo step, rolled back if one cannot be parented. Their scripts sync to disk.
- `solo_playtest` start takes `players` (1 to 8) and runs Studio's Local Server, returning once the server and every player's client are connected. The client tools (`eval_client_runtime`, keys, `click_gui`, `wait_for`, `inspect_gui`, the mouse and `perf_sample`) take `player`, by default the last client that joined; a player not in the test is refused with the ones that are. Screenshots and recordings are refused in a multiplayer test.
- Every Studio tool answer except the log's now ends with the play errors logged since that caller's previous call, grouped with a count and where the stack says they were thrown. An error already shown is only counted afterwards ("and N more of errors shown before"). A caller's first call reads from the start of the play, or from the oldest kept line when the play's start is no longer in the log.
- A file `quack-prelude/<peer>.luau` at the project root (outside `sync/` and `.quack/`, so git keeps it) runs before every `eval`, `exec` and `wait_for` try of that peer. Errors still name the code's own lines, and a prelude line is `prelude:N`.
- `capture_screenshot` takes a width and a focus: a GUI focus crops the capture to that object, and a part or model points the camera at it for the capture and restores it afterwards.
- The instructions the MCP server gives an AI name these tools.

### Fixed
- An error popup showed on every Windows shutdown: the hub ended with the session, and the tray app started a new one that could not initialise (0xc0000142). The app no longer restarts the hub while Windows shuts down; a crash and "Restart hub" restart it as before.
- `verify_sync` reported a script whose `.Source` has CRLF line endings as different from its file; the plugin now reads CRLF as the sync does.
- A cropped screenshot said it had been scaled down; it no longer does.
- The mouse tools named a full-screen frame in front of the point (the device simulator's TouchControlFrame); they now name the button or text box under it.
- `find` listed the first matches in the tree's order and not in path order.
- In edit mode, a path and `inspect_gui` took PlayerGui because Studio sets `Players.LocalPlayer` there too; they take PlayerGui only while a play runs, and StarterGui otherwise.

## [1.0.12] - 2026-11-08

### Added
- A Studio queue for each registered place. Clients submit test jobs (setup, client, check and cleanup steps) and take and release the Studio lock, and a waiting list ranks those who want Studio by rush, level with aging, the shorter hold, then arrival. The hub runs ready jobs in as few plays as it can: it joins the running play, shares one play among worktrees whose branches change different scripts, runs a shared failure again alone, waits for the play to be ready, retries infrastructure failures, and stands down for a client that wants Studio live. A hub restart keeps the jobs, the lock, the line and the play left up. Timings are hub settings and can be overridden per game in `.claude/studio-test.json`. History and verdicts are kept in the place's `.quack/queue/`, and `/api/state` lists `capabilities: ["queue"]`.
- `quack queue` shows the queue, submits a job and releases the lock. A job submitted from a terminal has no process id, so it stays queued after the command stops waiting.
- The app has a Queue tab (who holds Studio, who waits, tests, the play, today's speed, and a button to free the lock) and Settings > Queue with every timing.
- `click_gui` / `quack click` clicks a GUI button in the play by its path (`PlayerGui...`, `StarterGui...` for the player's copy, `Players.LocalPlayer...`), at the center, with virtual input. It refuses with the cause: not a GuiButton, hidden, a disabled ScreenGui, zero size, off screen, covered by another button, or clipped. It checks where the press landed and reports a press off the center as an error (60 to 94 ms measured).
- `wait_for` / `quack wait-for` runs Luau every `intervalMs` until a value is truthy, and/or waits for a play output line after a cursor that matches a regex. At the deadline it answers the last value or error and exits 3.
- `record` / `quack record` records the play as an animated GIF plus a contact sheet PNG under `.quack/recordings` (the last 10 are kept), at up to 10 fps at 640 px with no frame-rate cost. The MCP answer shows the sheet.

### Changed
- `exec` on a Studio whose plugin is older than the Studio tools (right after an update, before Studio reopens the place) now says so after 5 s, and no longer waits 30 s and blames the code. A timeout names an old plugin only when the edit-mode connection never answered; otherwise it says Studio is busy.

### Fixed
- `wait_for` with both code and a pattern ran an eval for every matching output line (43 evals in 1.3 s against a chatty play, with a 500 ms interval). It now evals on its interval and a line only checks the pattern.
- A screenshot where the edit DataModel's image budget refuses the read failed with an error about indexing nil; it now says the budget refused it.
- A click's wait for a frame is at most 0.5 s, so a window that stops drawing no longer leaves a probe in PlayerGui or hangs the call.

## [1.0.11] - 2026-11-08

### Added
- The Studio calls an AI makes most are now tools of Quack itself, each also a CLI command, going through the hub and the daemon to the plugin: `eval_server_runtime` / `eval-server`, `eval_client_runtime` / `eval-client`, `execute_luau` / `exec`, `solo_playtest` / `playtest`, `capture_screenshot` / `screenshot`, `get_runtime_logs` / `output`, `simulate_keyboard_input` / `key` and `set_device_simulator` / `device`.
- Evals run in the play's game VM with the game's require cache, and print, warn and the returned values come back. A compile error comes back as Luau's text.
- `solo_playtest` start returns once the server (and client) have connected; stop returns once the peers left and Studio is back in edit mode.
- A screenshot is a PNG written to `.quack/screenshots`, and the MCP answer carries it as an image. Measured on a test place: 724 ms for 1725x1063.
- The play's output is kept in the daemon (10,000 lines or 4 MB) for `get_runtime_logs`, with a cursor that survives a stop and a new play.
- Every refusal names its cause: Studio not connected, no play, no play client (Run mode), an older plugin, a minimized window, a timeout, or Luau's own error.
- Measured on a test place: `eval_server_runtime` 6.5 ms median, `eval_client_runtime` 6.3 ms, `execute_luau` 11.2 ms, play start 2.1 s, stop 2.0 s.

### Changed
- The play peers' output socket now carries tool calls both ways, and each peer says whether it is the server or a client when it connects. A plugin from before this version is detected, and the error says so. Reopen the place in Studio after updating.

### Fixed
- A Run-mode play in a big place (275k instances) loaded the plugin with `RunService:IsRunning()` still false, so it took the edit path: it asked the hub to sync the place as a second Studio (the app asked for a choice) and `playtest start --run` waited 60 s for a server that never came. Any DataModel that is not edit mode is now a play peer. Run-mode start answers in 4.1 to 7.3 s with no prompt.
- In a Run-mode play a screenshot waited 10 s and a key went to edit mode, where it does nothing. Both now say at once that the play has no client.
- An unfinished `1 +` reported line 2 `got 'end'`, the check's own closing line. It now says the code's last line, "at the end of the code".
- The compile check's own error showed in `get_runtime_logs`, and the MCP screenshot refusal came as `{ error }`; both are fixed.
- Eval tracebacks showed frames from Quack's wrapper; they keep only the code's own frames.

## [1.0.10] - 2026-11-08

### Fixed
- `quack wait` answered "kept syncing" until its timeout every time after Studio resumed its session, because a resume sends no snapshot and the sync time stayed at the tree built before the new connection. A resume now counts as synced at the moment it happens.

## [1.0.9] - 2026-11-08

### Added
- `quack play` can run several worktrees in one play when no two of them change the same script (by file or by instance path). The daemon merges their overlays into one swap, and the play's check and a refused swap are answered for each worktree. The CLI takes `-w` more than once. A hub or daemon that plays one worktree at a time says so. Before, each worktree needed its own play, about 13 s to start.

## [1.0.8] - 2026-11-08

### Fixed
- Each daemon start opened a Terminal window, left open by an error exit: the backstop watcher's default backend first runs `watchman` through cmd.exe, and a daemon has no console. The backstop now always uses the Windows backend and never looks for Watchman.

## [1.0.7] - 2026-11-08

### Added
- A second, lossless file watch runs beside `fs.watch`. Windows gives `fs.watch` a small buffer, so 50 deletes or 10 creates at once overflowed it, and so did reading the folder. `@parcel/watcher` (1 MB buffer, an overflow is reported as an error) now catches the paths an overflow lost, so an overflow no longer costs a full rescan. `fs.watch` stays the fast path (about 2 ms per save). In a copy of the Astral sync tree, reading every script gives no event and no rescan, and 200 scripts deleted at once arrive whole. The watch starts in about 120 ms instead of 75. On other platforms the watcher rescans on overflow, as before.
- The app installs a `quack` / `quackdev` command that works in Git Bash, beside the `.cmd`. Git Bash runs a `.cmd` through `cmd /c`, which stripped the quotes of an argument such as `--name "ANIME ASTRAL COPY"` and looked for a folder named `...\Local\Quack`.

### Changed
- A rescan after lost events says what it found; finding nothing is logged at info and no longer as a warning.
- The daemon runs the watcher binary from a copy named by its hash in `%APPDATA%\quack\native`, since a loaded DLL cannot be overwritten and the installer overwrites the files of a running hub.

## [1.0.6] - 2026-11-07

### Added
- The plugin keeps a copy, for 30 minutes, of a tree of 50 instances or more holding Parts, Models or GUIs that Studio deletes from the synced area (by a person, a plugin or a Team Create collaborator). A pop-up and the window's "Recently deleted in Studio" list restore it in one undo step. A tree destroyed with `Destroy()` is rebuilt from a clone of each instance, since its children are torn off before the plugin hears of it. A tree that comes back under another parent within 2 s raises no pop-up.

### Changed
- The daemon logs one line per deleted tree, with its count and who deleted it: "Deleted in Studio" or "Deleted by Quack (its file or folder left the disk)", instead of one line per instance in arrival order.

## [1.0.5] - 2026-11-06

### Changed
- A folder that leaves the disk no longer deletes, in Studio, a container that holds Parts, Models or GUIs: only its scripts go, and the log says the container was kept. The plugin refuses the same for a delete by path.
- The folder of an instance still in Studio stays on disk, empty, when its last script moves out.
- A late echo of the daemon's own change, an untracked folder deleted and a Folder created from disk are logged at info.

### Fixed
- Moving a Model that holds a script into a container with no script of its own, then back out, deleted the container in Studio (a world of stations and spawns, 82 instances). The echo of the daemon's own folder removal came after its 1 s suppression while a big place held the event loop; the window now opens when the loop is free.
- The same echo of a folder creation made an empty Folder next to each Model holding a script. A new folder that holds a synced script is no longer turned into a Folder.
- A script renamed on disk by a move (same-named siblings) had its old file's removal delivered late by a lost-events rescan and sent as a delete by path, which destroyed a same-named sibling in Studio. The daemon remembers for 60 s what it removed itself, and a `Name__suffix` file with no script is never deleted by path.

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

[Unreleased]: https://github.com/EnderexDev/Quack/compare/v1.0.26...HEAD
[1.0.26]: https://github.com/EnderexDev/Quack/compare/v1.0.25...v1.0.26
[1.0.25]: https://github.com/EnderexDev/Quack/compare/v1.0.24...v1.0.25
[1.0.24]: https://github.com/EnderexDev/Quack/compare/v1.0.23...v1.0.24
[1.0.23]: https://github.com/EnderexDev/Quack/compare/v1.0.22...v1.0.23
[1.0.22]: https://github.com/EnderexDev/Quack/compare/v1.0.21...v1.0.22
[1.0.21]: https://github.com/EnderexDev/Quack/compare/v1.0.20...v1.0.21
[1.0.20]: https://github.com/EnderexDev/Quack/compare/v1.0.19...v1.0.20
[1.0.19]: https://github.com/EnderexDev/Quack/compare/v1.0.18...v1.0.19
[1.0.18]: https://github.com/EnderexDev/Quack/compare/v1.0.17...v1.0.18
[1.0.17]: https://github.com/EnderexDev/Quack/compare/v1.0.16...v1.0.17
[1.0.16]: https://github.com/EnderexDev/Quack/compare/v1.0.15...v1.0.16
[1.0.15]: https://github.com/EnderexDev/Quack/compare/v1.0.14...v1.0.15
[1.0.14]: https://github.com/EnderexDev/Quack/compare/v1.0.13...v1.0.14
[1.0.13]: https://github.com/EnderexDev/Quack/compare/v1.0.12...v1.0.13
[1.0.12]: https://github.com/EnderexDev/Quack/compare/v1.0.11...v1.0.12
[1.0.11]: https://github.com/EnderexDev/Quack/compare/v1.0.10...v1.0.11
[1.0.10]: https://github.com/EnderexDev/Quack/compare/v1.0.9...v1.0.10
[1.0.9]: https://github.com/EnderexDev/Quack/compare/v1.0.8...v1.0.9
[1.0.8]: https://github.com/EnderexDev/Quack/compare/v1.0.7...v1.0.8
[1.0.7]: https://github.com/EnderexDev/Quack/compare/v1.0.6...v1.0.7
[1.0.6]: https://github.com/EnderexDev/Quack/compare/v1.0.5...v1.0.6
[1.0.5]: https://github.com/EnderexDev/Quack/compare/v1.0.4...v1.0.5
[1.0.4]: https://github.com/EnderexDev/Quack/compare/v1.0.3...v1.0.4
[1.0.3]: https://github.com/EnderexDev/Quack/compare/v1.0.2...v1.0.3
[1.0.2]: https://github.com/EnderexDev/Quack/compare/v1.0.1...v1.0.2
[1.0.1]: https://github.com/EnderexDev/Quack/compare/v1.0.0...v1.0.1
[1.0.0]: https://github.com/EnderexDev/Quack/releases/tag/v1.0.0
