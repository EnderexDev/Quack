import type { FlavorInfo } from "./hubClient.js";

/**
 * The rule: how an AI uses Quack, written once here. Three readers share it:
 * - "Connect to AI" (`quack connect-ai`) writes it into each AI's instructions file itself
 *   (connect.ts), replacing an older copy where it is; `quack rule --prompt` is the text a user
 *   pastes into any other AI.
 * - the MCP server's `instructions` carry a short form (`instructions()`), since clients cut a
 *   long one: Claude Code cut Quack's at ~4 KB, mid-sentence. Its last line names the rule's
 *   version, so an AI holding an older copy tells the user.
 * Only facts about Quack: nothing about one user's own workflow.
 */

/**
 * The markers around the rule in an instructions file. Each flavor has its own, so Quack Dev's
 * rule (quackdev, quack-dev) sits next to the Official's instead of replacing it.
 */
export function markers(info: FlavorInfo): { begin: string; end: string } {
  const tag = info.flavor === "official" ? "quack-rule" : "quackdev-rule";
  return { begin: `<!-- ${tag}`, end: `<!-- /${tag} -->` };
}

/** FNV-1a of the rule's body: changes exactly when the text does, so "outdated" is never a guess */
function hash(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

function body(info: FlavorInfo): string {
  const q = info.command;
  const app = info.appName;
  const server = info.flavor === "official" ? "quack" : "quack-dev";
  return `# ${app}: Roblox Studio synced with disk

${app} syncs Roblox places in Studio with folders on disk, both ways. One hub runs one daemon per registered place. The MCP server \`${server}\` has the tools below; the terminal command \`${q}\` does the same and more (\`${q} --help\`). Scripts are files: \`.luau\` is a ModuleScript, \`.server.luau\` a Script, \`.client.luau\` a LocalScript. \`status\` (or \`${q} places\`) says which folder syncs which place. Every Studio tool takes \`place\` (id or part of its name); left out, it is the place whose folder you run in.

## Editing in the synced folder

- A saved file reaches Studio in milliseconds while Studio has the place open and connected. Check \`status\` first: with no Studio connected, edits wait, and when the place is opened again Studio's copy of every script wins, so disk edits made meanwhile come back reverted.
- Edit scripts as files on disk (your own read, search and edit tools). Do not edit a script's text in Studio while working on disk: an edit made in Studio sends the whole script back to disk, over a disk edit that had not arrived yet.
- A new script: create the file, one at a time (not a burst of files at once), then confirm it exists in Studio (\`verify_sync\` or \`find_instances\`). A file the sync never created in Studio stays frozen there at its first version.
- After a batch of edits: \`wait\`, then \`verify_sync\`. It says, per script, whether Studio holds the disk's text in its \`.Source\` and in its open tab (the text a play copies). Prove a change arrived by a snippet of the newest edit, never by disk and Studio being equal: both sides can agree on the old version.
- \`analyze\` (\`${q} analyze [files]\`) checks the scripts on disk with the place's tree in seconds, no Studio needed: a module member a caller uses that the module no longer has, a \`WaitForChild\` of a child the tree lacks, a member an instance's class does not have, a remote fired with no listener, a player data key the profile template lacks, and its own linter's errors (syntax, an undefined variable, a wrong argument count, \`table.remove\` in a forward loop). Run it on the files you changed before a playtest; it stays quiet where it cannot be sure, so read what it reports.
- \`probe\` (\`${q} probe <place>\`) presses every button and requires every module in a play already running, and lists each new error with its file and line: only in a test place (it buys, opens and resets as a player would), never where the play's data is real, and it never starts a play.
- \`production_errors\` (\`${q} errors [place]\`) lists the live game's most frequent errors of the last days, with count, side, message and the script file and line: start a production bug hunt there.
- A script edited in Studio and on disk at once is merged; a disk version the merge did not keep goes to \`conflicts\`. Check it after a batch of edits. Which side wins is the user's call.
- Do not use Studio's Undo (Ctrl+Z, ChangeHistoryService:Undo) with the sync on: it also undoes the sync's own steps, and a created file gets deleted from disk too.
- Maps, models and UI layout live in the place, not on disk: change them with \`set_properties\`, \`execute_luau\` or \`import_rbxm\`, and carry them between places with \`export_rbxm\` / \`import_rbxm\`. \`selection\` reads or sets Studio's selection and points the edit camera at something (then \`capture_screenshot\` shows it); \`get_place_info\` names the place, its version and owner; \`generate_model\` makes a 3D model from a prompt or an image with Roblox's generation (minutes).
- Instances the sync deleted with no copy in git: \`list_place_versions\`, \`download_place\` (an .rbxl of a saved version), then \`import_rbxm\` of that .rbxl with \`paths\` (Workspace.Map, StarterGui.Shop: each goes back to its own service; \`list\` shows what the file holds first). A place's scripts come in only with \`scripts\`: a downloaded place is untrusted.
- \`studio_changes\` says which uncommitted files came from Studio (a designer's numbers, an edit made there) and which were edited on disk: read it before committing a synced folder, instead of guessing whose changes they are. With \`balance\` it lists the balance: files only Studio changed, and only in numbers (comments ignored; a string counts when its whole text is a number). \`commitBalance\` (\`${q} changes --commit-balance\`) commits exactly those in their own "Balance: values tuned in Studio" commit and pushes, leaving every other change and whatever is staged as it was; a file Studio wrote again during the commit is named and the push skipped. Files marked \`mixed\` or \`other\` are someone's work: never in that commit. Commit the balance only when the user's instructions say to; otherwise say what is there.

## The test cycle

1. \`solo_playtest\` stop (it returns once Studio is back in edit mode). Stopping play comes before every batch of edits, not once at the start of the work: check \`solo_playtest\` status after any interruption.
2. Edit the files.
3. \`wait\` (Studio connected and nothing synced for a moment), then \`verify_sync\`.
4. \`solo_playtest\` start, then drive and read the game (below).

Each cycle costs a play stop and load: change everything you can, then test it all in one play.

## Testing inside the running game

- \`eval_server_runtime\` / \`eval_client_runtime\` run Luau inside the play, with the game's own require cache and capabilities: require a service and call it, read the player's live data, fire a remote from the real client. A line a LocalScript runs is tested here or by the real button, never by \`execute_luau\`.
- \`execute_luau\` runs in the edit plugin: its \`require\` gives fresh copies of modules (services come back uninitialised) and it runs with plugin capability, so a write a LocalScript cannot make succeeds there and fails in the game. Use it to read and change the place in edit mode, never as proof of game behaviour. What it changes syncs to disk.
- A player's action: \`click_gui\` presses a button by its path and says whether it fired (or what hides or covers it); \`simulate_keyboard_input\` sends keys (and text to the focused TextBox, in its own call); \`simulate_mouse_input\` clicks a point of the last screenshot or an object's center. It cannot drag or scroll: scroll a ScrollingFrame by setting CanvasPosition from \`eval_client_runtime\`.
- Moving the player: \`move_player\` teleports the character to a position or an object, or walks it there (straight or by pathfinding) and says where it stopped and why; no eval that sets the HumanoidRootPart.
- Waiting: \`wait_for\` (Luau that turns truthy, or an output line) instead of sleeping or repeating an eval.
- Reading: \`get_runtime_logs\` with the cursor of the previous read; \`inspect_gui\` for a GUI as the player sees it; \`inspect_instance\` for one instance whole (properties, attributes, tags, children); \`find_instances\` to search the place by name, class and path with no Studio call, or the running game with \`peer\` (also by attribute and tag) instead of an eval walking GetDescendants.
- Looking: \`capture_screenshot\` (\`width\` caps the cost, \`focus\` crops to a GUI or points the camera at a part); \`record\` for animation and VFX (a GIF and a contact sheet); \`capture_devices\` for phones and a tablet in one picture; \`set_device_simulator\` for one device.
- Instrumenting without editing: \`set_logpoint\` prints values from a script line each time it runs (no edit, no sync cycle); its lines reach \`get_runtime_logs\`.
- Performance: \`perf_sample\` before and after a change in the same play (fps, frame times, hitches, memory, network); \`capture_script_profiler\` for the Luau functions that took the time; \`capture_micro_profiler\` for the engine's own scopes (physics, render, network, jobs) and the slowest frames, which the script profiler cannot see; \`get_memory_breakdown\` for memory by tag; \`get_scene_analysis\` for instance, triangle, script, animation and audio memory (Studio's Scene Analysis beta). A minimized or unfocused Studio throttles its frames, so frame numbers from automation are not the player's; memory and network still read true. In a solo play every peer is one Studio process, so memory reads the same in each.
- Conditions: \`simulate_conditions\` sets Studio's network lag and loss and the graphics quality; put it back when done, it is Studio's own setting and stays.
- Two or more players: \`solo_playtest\` start with \`players\`; the client tools then take \`player\`.
- Test data: \`test_profile\` save before a test that spends or grants and restore after, through the game's \`__quackSaveProfile\` / \`__quackRestoreProfile\` in \`quack-prelude/server.luau\`.
- \`quack-prelude/server.luau\`, \`client.luau\` and \`edit.luau\` at the project's root (next to the sync folder, kept in git) run before every eval of that peer: name the game's player, services and modules there once.
- Every Studio answer lists the play's errors logged since your previous call ("New errors in the play..."): read them before going on.
- A call that times out names its request id: the code may still be running in Studio. \`get_request_status\` with that id gives the answer that came later; check it before sending the same call again, or it runs twice.
- A purchase prompt is Roblox's CoreGui: no capture shows it and no tool closes it until play stops. Prove a purchase on the server (the game's receipt handler with a made-up receipt).

## The engine reference and assets

- \`get_roblox_docs\` reads Roblox's engine reference for a class, enum, datatype or library, with each property's read and write security: check it instead of guessing an API, and before trusting a write.
- \`search_assets\`, \`get_asset_details\` and \`get_asset_thumbnail\` look in the Creator Store with no Studio. \`preview_asset\` loads a model without placing it and lists its scripts (a backdoor scan); \`insert_asset\` puts it in the place with every script stripped.
- \`upload_asset\` uploads a file through Open Cloud, with the key and the owner the user saved in ${app}'s Settings (Open Cloud); without them it says so, and the key is the user's to give there, never yours to ask for in chat. It keeps a log by the file's hash: a repeat answers the asset already uploaded, or keeps waiting on the same upload, instead of making a duplicate. A Decal's answer includes the image id that goes in \`rbxassetid://\`.

## The live game through Open Cloud

- ${app} keeps the user's Open Cloud key encrypted, and only its hub uses it: never look for the key, read it or ask for it in chat. Never read its key file or its app's approval token, decrypt either, or script clicks or keys into ${app}'s app: in Claude Code, ${app}'s guard (installed with its MCP server) refuses those calls, and a refusal is final. A tool refused for a permission names it; \`cloud_permissions\` lists what the key lacks, and the user adds it in the Creator Hub.
- Reading is free: \`datastore\` (stores, keys, an entry or a few of its fields, versions), \`experience_config\` (get, draft), \`get_universe\`, \`badges\` / \`developer_products\` / \`game_passes\` (lists), \`localization\` (info, check), \`analytics_query\`, \`memory_store_sorted_map\`, \`ordered_data_store\`, \`user_restriction\` (list, logs), \`list_place_versions\`.
- Every change to the live game is a write: a DataStore save, increment or delete, a config publish, a badge, product or pass created or changed, translations pushed, servers restarted, the experience's settings, a message published, MemoryStore and leaderboard changes, a ban, Luau run in the cloud (\`luau_run\`). Make one only when the user asked for that exact change; otherwise refuse and ask first. Even then ${app}'s app asks the user (a notification, a sound and a popup listing what changes) and nothing happens without their Accept; no answer in 5 minutes is a No. Say so and wait for the answer. A refused write changed nothing: never retry it, ask the user. An answer saying ${app} is opening means its app was closed: ask again in a few seconds.
- A badge, a developer product and a game pass can never be deleted; a badge past the day's free quota costs Robux. Create them in the published game's experience, never a test place's.

## Git in the synced folder

Every file git writes goes to Studio. A merge or fast-forward is fine. Never switch branches, checkout, reset or stash there: the moment the tree rewinds becomes deletions in Studio, and pausing the sync does not protect it. After any git operation there: \`wait\`, then \`log\` for a deleted script the operation did not mean to delete. A deleted one comes back by writing it from git (\`git show HEAD:<path> > <path>\`). \`wait\` lists script files on disk with no instance in Studio (a merge's new script the sync missed): \`wait\` with fix sends their creates again; saving such a file again does nothing.

## Another branch: a git worktree and \`play\`

- A worktree's edits never reach Studio. Do not change scripts in Studio for that work (that writes to the synced folder's branch).
- Test with \`play\` (the worktree's path). A new file needs \`git add\` first, or the play leaves it out. The answer says 'N of M have the branch'; compare 'N changed, N new' with what the branch touched. To change code: stop the play, edit, \`play\` again.
- A 'conflict:' line is a script the branch changed that Studio also holds changed by someone else. 'has the place's text' means a tab open and edited in that Studio beat the swap: closing the tab (\`script_tabs\`) fixes the next play.
- Maps, models and UI layout are not carried by a play.
- The branch reaches the place by a merge or fast-forward in the synced folder, then \`wait\` and \`log\`.

## When something is off

- \`doctor\` checks the hub, its build against the installed app, the Studio plugin and the folders.
- An error says its cause: no Studio connected, no play running, no play client (Run mode), an older plugin (reopen the place), the window minimized, or Luau's own error. An older plugin is updated only when Studio reopens the place.
- Settling a conflict, pausing, registering a place and restarting the hub are the user's: the app or the terminal, never on your own.

## This rule

The copy of this rule in your instructions file is the block between the two ${markers(info).begin.slice(5)} comment markers (the opening one carries the version). ${app}'s app writes it there and replaces it when it changes (Settings, "Connect to AI"). The MCP server's instructions name the current version: when yours is another, tell the user once to click "Connect to AI" in ${app}'s Settings.`;
}

/** The rule between its markers, as it goes in an instructions file */
export function rule(info: FlavorInfo): { version: string; text: string } {
  const text = body(info);
  const version = hash(text);
  const { begin, end } = markers(info);
  return { version, text: `${begin} ${version} -->\n${text}\n${end}` };
}

/** What the app copies: the rule, and how the AI puts it in place or swaps the old copy */
export function rulePrompt(info: FlavorInfo): string {
  const { text } = rule(info);
  const { begin: BEGIN, end: END } = markers(info);
  return `Put the ${info.appName} rule below in the instructions file you load in every session, for every project (Claude Code: ~/.claude/CLAUDE.md; Codex: ~/.codex/AGENTS.md; another AI: its global rules file). First search your instruction files (and the rule files they load) for a block from "${BEGIN}" to "${END}": if one exists, replace that whole block with this one where it is and change nothing else; otherwise add it at the end of that instructions file. Then tell me which file you changed and whether it was an update or a new rule.

${text}`;
}

/** The MCP instructions: the essentials first (a client may cut the rest), then where the rule is */
export function instructions(info: FlavorInfo): string {
  const { version } = rule(info);
  return `${info.appName} syncs Roblox places in Studio with folders on disk, both ways; \`status\` lists each place and its folder. Scripts are files: .luau is a ModuleScript, .server.luau a Script, .client.luau a LocalScript. Every Studio tool takes \`place\`; left out, it is the place whose folder you run in.

- Check \`status\` before editing: with no Studio connected, edits wait, and Studio's copy wins when the place reopens.
- Edit scripts as files. Create new files one at a time. After edits: \`wait\`, then \`verify_sync\` (Studio holds the disk's text?). \`conflicts\` lists disk edits a merge did not keep; which side wins is the user's call.
- Test cycle: \`solo_playtest\` stop, edit, \`wait\`, \`verify_sync\`, \`solo_playtest\` start.
- \`eval_server_runtime\` / \`eval_client_runtime\` run inside the play (the game's require cache). \`execute_luau\` is the edit plugin: never proof of game behaviour; what it changes syncs to disk.
- In the play: \`click_gui\` (a button by path), \`simulate_keyboard_input\`, \`wait_for\` instead of sleeping, \`get_runtime_logs\` with a cursor, \`inspect_gui\`, \`capture_screenshot\`, \`set_logpoint\` (no edit). Every Studio answer lists the play's new errors: read them. A call that timed out names a request id: \`get_request_status\` before sending it again.
- \`get_roblox_docs\` for an engine API instead of guessing; assets through \`search_assets\`, \`preview_asset\`, \`insert_asset\` (scripts stripped) and \`upload_asset\` (never uploads the same file twice).
- The live game's Open Cloud (DataStores, configs, badges, products, servers, bans...): the key stays in Quack, never ask for it. Read freely; write only when the user asked for that exact change, and Quack still asks them in its app first (Accept or Refuse; never retry a refusal).
- Never Undo in Studio with the sync on. In the synced folder git may merge or fast-forward, never checkout, reset or stash; after any git operation: \`wait\`, then \`log\` for deletions.
- Before committing a synced folder: \`studio_changes\` says which files Studio wrote; \`commitBalance\` commits only Studio's numbers-only files (a designer's tuning) and pushes, when the user's instructions say to.
- Another branch lives in a git worktree and is tested with \`play\` (its path; \`git add\` new files first).
- Settling conflicts, pausing, registering and restarting the hub are the user's.

The full rule (every tool, the traps, worktrees) is \`${info.command} rule\`, version ${version}. If your instructions hold a "${markers(info).begin.slice(5)}" block with another version, or none and this is a recurring project, tell the user once: "Connect to AI" in ${info.appName}'s Settings installs or updates it.`;
}
