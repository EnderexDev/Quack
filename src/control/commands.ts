import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { CLIENTS, connectClients, defaultClientsEnv, listClients, serverName, type ClientsEnv, type ClientStatus, type ServerCommand } from "./connect.js";
import { HubClient, HubError, HubOffline, type FlavorInfo } from "./hubClient.js";
import { PLAY_TAB_HINT } from "../play/overlay.js";
import { rule, rulePrompt } from "./rule.js";
import {
  assetDetails, assetThumbnail, detailsText, docsText, imageIdLua, rememberImageId, RobloxError, robloxDocs, robloxEnv, searchAssets, searchText,
  uploadAsset, type RobloxEnv,
} from "./roblox.js";

/**
 * `quack` / `quackdev`: the hub from a terminal. Every command is one or a few calls to the
 * hub's HTTP API, the same the app makes; nothing here syncs or keeps state of its own.
 */

export const EXIT = { ok: 0, error: 1, offline: 2, timeout: 3 } as const;

export interface ControlContext {
  info: FlavorInfo;
  client: HubClient;
  out: (line: string) => void;
  err: (line: string) => void;
  /** Asks a yes/no question on the terminal; only called when `interactive` */
  confirm: (question: string) => Promise<boolean>;
  /** stdin is a terminal: a question can be answered */
  interactive: boolean;
  /** stdout is a terminal: colours and the daemon log's own colour codes */
  color: boolean;
  cwd: string;
  openUri: (uri: string) => Promise<void>;
  /** Where the app installed this command's files (BUILD, the plugins); unset from dist/ */
  bundleDir?: string;
  /** Poll interval for log -f, wait and restart-hub; shorter in tests */
  pollMs?: number;
  /** Who calls the Studio tools: each caller gets the play errors since its own previous call */
  caller?: string;
  /** How an AI client starts `mcp` (this same command); connect-ai needs it */
  server?: ServerCommand;
  /** Where the AI clients are; tests point it at a scratch home */
  clients?: ClientsEnv;
  /** The Roblox web tools' fetch, data folder and environment; tests replace them */
  roblox?: Partial<RobloxEnv>;
}

class UsageError extends Error {}
class Timeout extends Error {}
/** Said already, with its exit code: only the code is left to return */
class Done extends Error {
  constructor(readonly code: number) {
    super("done");
  }
}

interface Options {
  json: boolean;
  yes: boolean;
  follow: boolean;
  connected: boolean;
  /** wait: send the create of each script file with no instance in Studio again */
  fix: boolean;
  idle?: number;
  timeout?: number;
  name?: string;
  disk: boolean;
  keep: boolean;
  refresh: boolean;
  wait: boolean;
  /** restart-hub: replace the daemons too (each hands its tree to its successor) */
  daemons: boolean;
  /** play: the worktrees to play (default: the folder you are in); several share one play */
  worktrees: string[];
  help: boolean;
  /** The Studio tools (eval-server, exec, key, device...): their own values, given as --name=value */
  code?: string;
  file?: string;
  out?: string;
  cursor?: string;
  tail?: string;
  filter?: string;
  peer?: string;
  text?: string;
  action?: string;
  duration?: string;
  run: boolean;
  id?: string;
  orientation?: string;
  resolution?: string;
  density?: string;
  scaling?: string;
  stop: boolean;
  list: boolean;
  /** queue submit: a play of its own start */
  fresh: boolean;
  /** click, wait-for, record */
  method?: string;
  pattern?: string;
  interval?: string;
  tryTimeout?: string;
  seconds?: string;
  fps?: string;
  width?: string;
  /** gui, mouse, and the tools after them */
  depth?: string;
  limit?: string;
  hidden: boolean;
  button?: string;
  space?: string;
  path?: string;
  focus?: string;
  files?: string;
  class?: string;
  under?: string;
  line?: string;
  message?: string;
  condition?: string;
  parent?: string;
  /** A multiplayer test: which player's client; and how many players a start makes */
  player?: string;
  players?: string;
  /** inspect, set, simulate, tabs, devices, profile */
  all: boolean;
  props?: string;
  attrs?: string;
  network?: string;
  quality?: string;
  memory?: string;
  inbound?: string;
  outbound?: string;
  close?: string;
  closeEdited: boolean;
  devices?: string;
  /** rule: the rule with how an AI installs or updates it (what the app copies) */
  prompt: boolean;
  /** docs, asset, memory, profiler, scene */
  type?: string;
  section?: string;
  size?: string;
  at?: string;
  description?: string;
  user?: string;
  group?: string;
  force: boolean;
  roblox: boolean;
  tags?: string;
  frequency?: string;
  ms?: string;
  native: boolean;
  plugin: boolean;
  mode?: string;
  sort?: string;
}

function parse(argv: string[]): { command?: string; args: string[]; options: Options } {
  const { values, positionals } = parseArgs({
    args: argv,
    strict: true,
    allowPositionals: true,
    options: {
      json: { type: "boolean" },
      yes: { type: "boolean", short: "y" },
      follow: { type: "boolean", short: "f" },
      connected: { type: "boolean" },
      fix: { type: "boolean" },
      idle: { type: "string" },
      timeout: { type: "string" },
      name: { type: "string" },
      disk: { type: "boolean" },
      keep: { type: "boolean" },
      refresh: { type: "boolean" },
      wait: { type: "boolean" },
      daemons: { type: "boolean" },
      worktree: { type: "string", short: "w", multiple: true },
      help: { type: "boolean", short: "h" },
      code: { type: "string" },
      file: { type: "string" },
      out: { type: "string" },
      cursor: { type: "string" },
      tail: { type: "string" },
      filter: { type: "string" },
      peer: { type: "string" },
      text: { type: "string" },
      action: { type: "string" },
      duration: { type: "string" },
      run: { type: "boolean" },
      id: { type: "string" },
      orientation: { type: "string" },
      resolution: { type: "string" },
      density: { type: "string" },
      scaling: { type: "string" },
      stop: { type: "boolean" },
      list: { type: "boolean" },
      fresh: { type: "boolean" },
      method: { type: "string" },
      pattern: { type: "string" },
      interval: { type: "string" },
      "try-timeout": { type: "string" },
      seconds: { type: "string" },
      fps: { type: "string" },
      width: { type: "string" },
      depth: { type: "string" },
      limit: { type: "string" },
      hidden: { type: "boolean" },
      button: { type: "string" },
      space: { type: "string" },
      path: { type: "string" },
      focus: { type: "string" },
      files: { type: "string" },
      class: { type: "string" },
      under: { type: "string" },
      line: { type: "string" },
      message: { type: "string" },
      condition: { type: "string" },
      parent: { type: "string" },
      player: { type: "string" },
      players: { type: "string" },
      all: { type: "boolean" },
      props: { type: "string" },
      attrs: { type: "string" },
      network: { type: "string" },
      quality: { type: "string" },
      memory: { type: "string" },
      inbound: { type: "string" },
      outbound: { type: "string" },
      close: { type: "string" },
      "close-edited": { type: "boolean" },
      devices: { type: "string" },
      prompt: { type: "boolean" },
      type: { type: "string" },
      section: { type: "string" },
      size: { type: "string" },
      at: { type: "string" },
      description: { type: "string" },
      user: { type: "string" },
      group: { type: "string" },
      force: { type: "boolean" },
      roblox: { type: "boolean" },
      tags: { type: "string" },
      frequency: { type: "string" },
      ms: { type: "string" },
      native: { type: "boolean" },
      plugin: { type: "boolean" },
      mode: { type: "string" },
      sort: { type: "string" },
    },
  });
  const number = (name: "idle" | "timeout"): number | undefined => {
    const raw = values[name];
    if (raw === undefined) return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) throw new UsageError(`--${name} must be a number`);
    return value;
  };
  return {
    command: positionals[0],
    args: positionals.slice(1),
    options: {
      json: values.json === true,
      yes: values.yes === true,
      follow: values.follow === true,
      connected: values.connected === true,
      fix: values.fix === true,
      idle: number("idle"),
      timeout: number("timeout"),
      name: values.name,
      disk: values.disk === true,
      keep: values.keep === true,
      refresh: values.refresh === true,
      wait: values.wait === true,
      daemons: values.daemons === true,
      worktrees: values.worktree ?? [],
      help: values.help === true,
      code: values.code,
      file: values.file,
      out: values.out,
      cursor: values.cursor,
      tail: values.tail,
      filter: values.filter,
      peer: values.peer,
      text: values.text,
      action: values.action,
      duration: values.duration,
      run: values.run === true,
      id: values.id,
      orientation: values.orientation,
      resolution: values.resolution,
      density: values.density,
      scaling: values.scaling,
      stop: values.stop === true,
      list: values.list === true,
      fresh: values.fresh === true,
      method: values.method,
      pattern: values.pattern,
      interval: values.interval,
      tryTimeout: values["try-timeout"],
      seconds: values.seconds,
      fps: values.fps,
      width: values.width,
      depth: values.depth,
      limit: values.limit,
      hidden: values.hidden === true,
      button: values.button,
      space: values.space,
      path: values.path,
      focus: values.focus,
      files: values.files,
      class: values.class,
      under: values.under,
      line: values.line,
      message: values.message,
      condition: values.condition,
      parent: values.parent,
      player: values.player,
      players: values.players,
      all: values.all === true,
      props: values.props,
      attrs: values.attrs,
      network: values.network,
      quality: values.quality,
      memory: values.memory,
      inbound: values.inbound,
      outbound: values.outbound,
      close: values.close,
      closeEdited: values["close-edited"] === true,
      devices: values.devices,
      prompt: values.prompt === true,
      type: values.type,
      section: values.section,
      size: values.size,
      at: values.at,
      description: values.description,
      user: values.user,
      group: values.group,
      force: values.force === true,
      roblox: values.roblox === true,
      tags: values.tags,
      frequency: values.frequency,
      ms: values.ms,
      native: values.native === true,
      plugin: values.plugin === true,
      mode: values.mode,
      sort: values.sort,
    },
  };
}

export function helpText(info: FlavorInfo): string {
  const q = info.command;
  return `${info.appName}: the hub on port ${info.port}, from a terminal.

Usage: ${q} <command> [place] [options]
  [place] is a place id or (part of) its name; left out, the place whose folder you are in,
  or the only one registered.

See
  status                    Hub, AI merge and every place: Studio connected, instances, conflicts
  places                    Registered places and their folders
  sessions                  Running daemons, one per place in use
  log [place] [-f]          The place's daemon log; -f keeps following it
  merges [place]            Recent merges
  conflicts [place]         Conflicts waiting (every place when none is named)
  conflict <id> [place]     A conflict's saved disk version and the script as it is now
  choices                   Connections waiting for a choice (folder in use, second Studio, Set up)
  doctor                    Checks the hub, its build, the plugin and the registered folders

Wait
  wait [place]              Until Studio is connected and nothing has synced for a while
      --connected             only until Studio is connected
      --fix                   send the create of each script file with no instance in Studio again
      --idle <ms>             quiet this long (default 1500), counted from the call too
      --timeout <s>           give up after this long (default 120), exit ${EXIT.timeout}

Play
  play [place] [-w <folder>]  A playtest with the scripts a git worktree's branch changed since
                            it forked (default: the worktree you are in); every other script
                            runs as Studio has it. The place in edit mode keeps its own; Studio
                            holds the branch's only while it copies the place (~1 to 2 s)
      -w <a> -w <b>           several worktrees in one play, when no two change the same
                            script; the check answers for each one

Studio (through the ${info.appName} plugin; the code goes as --code=<luau> or --file <path>)
  eval-server [place]       Luau in the play server's game VM, with the game's require cache;
                            prints what it printed and what it returned
  eval-client [place]       The same in the play client
  exec [place]              Luau in the edit plugin (Studio in edit mode)
  playtest start|stop|status [place] [--run] [--players <n>]   A solo play (--run: Run mode, no
                            client), or a multiplayer test with n players (Studio's Local Server);
                            stop returns once Studio is back in edit mode. In a multiplayer test,
                            --player <name> on any client command picks the player's client
  output [place] [--cursor <n>] [--tail <n>] [--filter <text>] [--peer server|client]
                            The play's output; the cursor it prints reads only what came after
  screenshot [place] [--out <file.png>] [--width <px>] [--focus <path>]
                            The viewport (the play client's while one runs); --focus on a GUI
                            object keeps only its part of the screen, on a part or model points
                            the camera at it for the capture
  key <KeyCode> [place] [--action tap|press|release] [--duration <s>] | key [place] --text=<text>
                            A key to the play client (edit mode when no play runs)
  device [place] [--id <device>] [--orientation <o>] [--resolution <w>x<h>] [--density <n>]
         [--scaling <mode>] [--stop] [--list]   The device simulator; no setting shows it
  click <path> [place] [--method auto|input|select]   A GUI button in the play client, by its
                            path (PlayerGui.Shop.Buy, StarterGui.Shop.Buy, Players.LocalPlayer...);
                            says whether its Activated fired and where it clicked
  wait-for [place] [--code=<luau> | --file <path>] [--pattern=<regex>] [--peer server|client]
           [--interval <ms>] [--timeout <s>] [--try-timeout <s>] [--cursor <n>]
                            Until the Luau (an expression, or code that returns) turns truthy in
                            the play, or a play output line matches; exit ${EXIT.timeout} once the
                            deadline (default 30 s, at most 600) passes
  record [place] [--seconds <s>] [--fps <n>] [--width <px>] [--out <file.gif>]
                            A GIF of the play view (default 3 s at 5 fps, 640 px wide; at most
                            15 s and 10 fps) and a contact sheet PNG of its frames
  gui [path] [place] [--depth <n>] [--limit <n>] [--hidden]
                            A GUI's tree as the player sees it (default PlayerGui in a play,
                            StarterGui in edit): class, text, image, place, hidden by what,
                            whether a button takes a click; deeper or hidden parts are counted
  verify [place] [--files <a,b>]   Whether Studio holds each synced script's disk text, in its
                            .Source and in an open tab (the text a play copies); the files
                            are paths from the sync folder (default every script)
  logpoint add|remove <file> | --path=<path> --line <n> [place] [--message=<luau values>] [--condition=<luau>]
  logpoint list|clear [place]
                            A script line that prints values each time it runs in the play, with
                            no edit to the script (needs Studio's beta "Studio Debugger Luau API")
  export <path>[,<path>...] [place] [--out <file.rbxm>]   Instances saved as an .rbxm file
  import <file.rbxm> [place] [--parent <path>]   An .rbxm's instances put in the place (edit
                            mode, default under Workspace); their scripts sync to disk
  perf [place] [--seconds <s>] [--peer server|client]
                            A few seconds of the play's performance in both peers: fps, frame
                            times p50 / p90 / p99 / max, hitches over 50 ms, memory by tag
  find [place] [--name <pattern>] [--class <A,B>] [--under <path>] [--limit <n>]
                            Instances of the synced tree (edit mode, as of the last sync) by
                            name (* and ?), class and where; scripts with their file
  inspect <path> [place] [--peer edit|server|client] [--all] [--hidden]
                            One instance read whole: properties that differ from a new one of
                            its class (--all: every one), attributes, tags, children
  set <path> [place] [--props=<json>] [--attrs=<json>] [--peer edit|server|client]
                            Change properties and attributes together, all or nothing; a value
                            takes the type there now, or names it: {"Vector3":[1,2,3]}
  simulate [place] [--network off|great|good|poor] [--inbound=<ms>,<jitter ms>,<loss %>]
           [--outbound=...] [--quality auto|1..21] [--memory <MB>]
                            Studio's network and performance simulation; nothing to set shows it
  tabs [place] [--close=<path>,<path>] [--close-edited]   Script tabs open in Studio, and the
                            edited ones (an edited tab gives a play its own text)
  devices [place] [--devices=<id>,<id>] [--orientation <o>] [--width <px>]
                            The view on several devices in one picture (default a small phone,
                            an iPhone, an iPad and no simulation), the simulator put back after
  profile save|restore [name] [place] | profile list [place]   The player's test profile kept and
                            put back through the prelude's __quackSaveProfile / __quackRestoreProfile
  mouse <x> <y> [place] | mouse --path=<path> [place] [--action click|double|down|up]
        [--button left|right|middle] [--space screen]
                            The play client's mouse at a point on the last screenshot (or the
                            screen's own pixels), or at a GuiObject's or a part's center
  memory [place] [--peer edit|server|client] [--tags <A,B>]
                            Memory by DeveloperMemoryTag and the total, in edit mode and each
                            play peer (a solo play is one process: the same total in each)
  profiler [place] [--peer server|client] [--ms <n>] [--frequency <n>] [--limit <n>]
           [--filter <text>] [--native] [--plugin] [--out <file.json>]
                            The script profiler on the play server (or client) for --ms (default
                            1000, at most 15000): the functions that took the most time
  scene [place] [--mode all|instance_composition|script_memory|unparented_instances|
        triangle_composition|animation_memory|audio_memory] [--peer edit|server|client] [--limit <n>]
                            Studio's Scene Analysis (a beta feature): the biggest entries of each
  asset preview <id> [place] [--depth <n>]   A Creator Store asset loaded and read, not inserted:
                            its classes, scripts (and what they call), PackageLinks, sounds, tree
  asset insert <id> [place] [--parent <path>] [--at=<x>,<y>,<z>]   The asset put in the place
                            (edit mode, one undo step) with every script and PackageLink removed

Roblox (no hub needed)
  docs <Name> [--type classes|enums|datatypes|libraries|globals] [--section <name>]
                            The engine reference's page (TweenService, Enum.KeyCode, Color3),
                            each member's security level first; cached a day
  asset search [query] [--type Model|Decal|Image|Audio|MeshPart|Video|Plugin|FontFamily|Particle|VFX]
               [--limit <n>] [--sort <category>] [--roblox]   The Creator Store; --roblox: made by Roblox
  asset details <id>        One asset on the Creator Store: creator, scripts, mesh size, votes
  asset thumbnail <id> [--size 150x150|420x420|768x432] [--out <file.png>]   Its thumbnail as a PNG
  asset upload <file> [place] --type Decal|Audio|Model|Animation|Video --name <name>
               [--description <text>] [--user <id> | --group <id>] [--force]
                            Open Cloud: the key and creator from ROBLOX_OPEN_CLOUD_API_KEY,
                            ROBLOX_CREATOR_USER_ID / _GROUP_ID or open-cloud.env next to the
                            registry; the same file uploaded again answers the asset it made
                            (--force posts anyway); a Decal also gets its image id

Studio queue (one per place: test jobs, the Studio lock and who waits for it)
  queue [place]             Who holds Studio and for how long, who waits (level, wait), the jobs
                            queued and running, the play, and today's speed
  queue submit <job.luau> [place] [-w <folder>] [--fresh] [--name <name>] [--timeout <min>]
                            A test job (setup, client, check, cleanup with ctx), run in the
                            place's play or a worktree's branch (-w; default: the folder you are
                            in); waits for its verdict. Exit 0 pass, 1 fail, ${EXIT.timeout} infra or no verdict
  queue release [place]     Free the Studio lock, whoever holds it
  queue settings            The queue's timings (the app's Settings change them)

Change${info.flavor === "official" ? " (each asks first; --yes to skip, required without a terminal)" : ""}
  pause | resume            Stop every daemon and turn Studios away / allow them again
  register <placeId> [folder] [--name <name>]   Link a folder (default: here) to a place
  unregister <place>
  resolve <id> --disk|--keep [place]   Put the saved disk version back, or keep what is there
  choose <id> continue|cancel          Answer a waiting connection
  ai [on|off|claude|codex]  The AI merge (no argument: show it; --refresh checks the CLIs again)
  open <place> [--wait]     Open the place in Studio; --wait until it connects
  restart-hub [--daemons]   Restart the hub (Studios stay connected); --daemons restarts the daemons too

AI
  mcp                       An MCP server on stdio for Claude Code, Cursor, Codex: status, wait, log,
                            conflicts, doctor, play and the Studio commands as tools, with how
                            to use ${info.appName} as its instructions
  rule [--prompt]           How an AI uses ${info.appName}, for its instructions file (CLAUDE.md, AGENTS.md);
                            --prompt adds how the AI puts it there or swaps an older copy
                            (the app's "Copy rule for AI" copies that)
  ai-clients                Claude Code, Cursor and Codex on this computer, and whether each has the MCP
  connect-ai [claude|cursor|codex|<id>]...   Add the MCP to each one named (default: every one installed).
                            Every config folder counts: CLAUDE_CONFIG_DIR / CODEX_HOME, ~/.claude-*,
                            ~/.codex-*, and each T3 Code provider's home

Every command takes --json. Exit codes: 0 ok, 1 error, ${EXIT.offline} hub not running, ${EXIT.timeout} wait timed out.
push, build and pack stay in the old command: node dist/cli.js.`;
}

const MUTATING = new Set(["pause", "resume", "register", "unregister", "resolve", "choose", "restart-hub"]);

export async function runControl(argv: string[], ctx: ControlContext): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    ctx.err(`${(error as Error).message}\nRun ${ctx.info.command} --help.`);
    return EXIT.error;
  }
  const { command, args, options } = parsed;
  if (!command || options.help || command === "help") {
    ctx.out(helpText(ctx.info));
    return EXIT.ok;
  }
  const notes: string[] = [];
  NOTES.set(ctx, notes);
  if (options.player !== undefined) PLAYER.set(ctx, options.player);
  try {
    const mutates = MUTATING.has(command) || (command === "ai" && args.length > 0);
    if (mutates && ctx.info.flavor === "official") await confirmOfficial(ctx, options, `${command} ${args.join(" ")}`.trim());
    const code = await dispatch(command, args, options, ctx);
    // After the command's own answer; --json carries them in its body instead
    if (!options.json) for (const note of notes) ctx.out(note);
    return code;
  } catch (error) {
    if (error instanceof Done) return error.code;
    if (options.json) ctx.out(JSON.stringify({ error: (error as Error).message }));
    else ctx.err((error as Error).message);
    if (error instanceof HubOffline) {
      if (!options.json) ctx.err(`Is ${ctx.info.appName} running?`);
      return EXIT.offline;
    }
    if (error instanceof Timeout) return EXIT.timeout;
    if (error instanceof RobloxError && error.pending) return EXIT.timeout;
    if (error instanceof UsageError) return EXIT.error;
    return EXIT.error;
  }
}

/** Official syncs the real games: a change there is the user's to make, never a script's by accident */
async function confirmOfficial(ctx: ControlContext, options: Options, what: string): Promise<void> {
  if (options.yes) return;
  if (!ctx.interactive) throw new UsageError(`${what} changes the Official hub (the real games): pass --yes to do it without a terminal.`);
  if (!(await ctx.confirm(`${what}: this changes the Official hub (the real games). Go on?`))) throw new Done(EXIT.error);
}

async function dispatch(command: string, args: string[], options: Options, ctx: ControlContext): Promise<number> {
  const { client } = ctx;
  const print = (value: unknown, text: () => string) => ctx.out(options.json ? JSON.stringify(value, null, 2) : text());
  switch (command) {
    case "status": {
      const state = await client.get("/api/state");
      print(state, () => formatStatus(ctx, state));
      return EXIT.ok;
    }
    case "places":
    case "ls": {
      const state = await client.get("/api/state");
      print(state.places, () =>
        state.places.length === 0
          ? "No place registered."
          : table(["PLACE", "ID", "FOLDER"], state.places.map((p: any) => [p.name ?? "", p.placeId, p.folder])));
      return EXIT.ok;
    }
    case "sessions": {
      const { sessions } = await client.get("/api/sessions");
      const now = Date.now();
      print(sessions, () =>
        sessions.length === 0
          ? "No daemon running."
          : table(["PLACE", "ID", "STUDIO", "DAEMON", "PID", "PORT"], sessions.map((s: any) => [
              s.name ?? "", s.placeId, s.studioConnected ? `connected ${ago(now, s.studioSince)}` : "-",
              `up ${ago(now, s.daemonSince)}`, String(s.daemonPid ?? "-"), String(s.daemonPort),
            ])));
      return EXIT.ok;
    }
    case "log":
      return log(ctx, options, args[0]);
    case "merges": {
      const place = await resolvePlace(ctx, args[0]);
      const merges = await client.get("/api/merges", { placeId: place.placeId });
      print(merges, () =>
        merges.entries.length === 0
          ? `No merges in ${placeLabel(place)}.`
          : `${merges.today} today in ${placeLabel(place)}\n` + table(["WHEN", "FILE", "METHOD", ""], merges.entries.slice(0, 30).map((m: any) => [
              when(m.t), m.file, m.method, m.agentVersion ? (m.resolved ? "conflict, seen" : "CONFLICT") : m.error ? `error: ${m.error}` : "",
            ])));
      return EXIT.ok;
    }
    case "conflicts": {
      const state = await client.get("/api/state");
      const places = args[0] ? [await resolvePlace(ctx, args[0], state)] : state.places;
      const found: any[] = [];
      for (const place of places) {
        if (!args[0] && !place.conflicts) continue;
        const merges = await client.get("/api/merges", { placeId: place.placeId });
        for (const c of merges.conflicts) found.push({ placeId: place.placeId, place: place.name, ...c });
      }
      print(found, () =>
        found.length === 0
          ? "No conflicts waiting."
          : table(["PLACE", "WHEN", "FILE", "ID"], found.map((c) => [c.place ?? c.placeId, when(c.t), c.file, c.agentVersion])) +
            `\n${ctx.info.command} conflict <id> shows one; ${ctx.info.command} resolve <id> --disk|--keep settles it.`);
      return EXIT.ok;
    }
    case "conflict": {
      const id = need(args[0], "conflict <id> [place]");
      const place = await placeOfConflict(ctx, id, args[1]);
      const view = await client.get("/api/conflict", { placeId: place.placeId, id });
      print(view, () => [
        `${view.file}  (${view.path})`,
        "",
        "--- saved disk version (not kept by the merge) ---",
        view.saved,
        "--- the script now ---",
        view.current ?? "(deleted)",
      ].join("\n"));
      return EXIT.ok;
    }
    case "resolve": {
      const id = need(args[0], "resolve <id> --disk|--keep [place]");
      if (options.disk === options.keep) throw new UsageError("say --disk (put the saved disk version back) or --keep (keep the script as it is)");
      const place = await placeOfConflict(ctx, id, args[1]);
      await client.post("/api/conflict/resolve", { placeId: place.placeId, id, action: options.disk ? "useDisk" : "keep" });
      print({ ok: true }, () => options.disk ? "The saved disk version is back; the daemon sends it to Studio." : "Kept the script as it is.");
      return EXIT.ok;
    }
    case "choices": {
      const state = await client.get("/api/state");
      print(state.pending, () =>
        state.pending.length === 0
          ? "No connection is waiting for a choice."
          : table(["ID", "PLACE", "WHAT", "FOLDER"], state.pending.map((c: any) => [c.id, c.placeName ?? c.placeId, choiceText(c), c.folder])) +
            `\n${ctx.info.command} choose <id> continue|cancel answers one. Set up is finished in the app.`);
      return EXIT.ok;
    }
    case "choose": {
      const id = need(args[0], "choose <id> continue|cancel");
      const decision = args[1];
      if (decision !== "continue" && decision !== "cancel") throw new UsageError("choose <id> continue|cancel");
      await client.post("/api/choice", { id, decision });
      print({ ok: true }, () => decision === "continue" ? "Done: that Studio takes over on its next try." : "Done: the other connection keeps it.");
      return EXIT.ok;
    }
    case "pause":
    case "resume": {
      await client.post("/api/pause", { paused: command === "pause" });
      print({ ok: true, paused: command === "pause" }, () => command === "pause" ? "Paused: every daemon stopped, Studios are turned away." : "Resumed: Studios connect again on their own.");
      return EXIT.ok;
    }
    case "register": {
      const placeId = need(args[0], "register <placeId> [folder] [--name <name>]");
      if (!/^\d+$/.test(placeId)) throw new UsageError("register takes the place id first: register <placeId> [folder]");
      const folder = path.resolve(ctx.cwd, args[1] ?? ".");
      await client.post("/api/registry", { placeId, folder, ...(options.name ? { name: options.name } : {}) });
      print({ ok: true, placeId, folder }, () => `Registered ${options.name ?? placeId} -> ${folder}`);
      return EXIT.ok;
    }
    case "unregister": {
      const place = await resolvePlace(ctx, need(args[0], "unregister <place>"));
      await client.post("/api/unregister", { placeId: place.placeId });
      print({ ok: true, placeId: place.placeId }, () => `Unregistered ${placeLabel(place)}; its folder stays as it is.`);
      return EXIT.ok;
    }
    case "ai":
      return ai(ctx, options, args[0]);
    case "open":
      return open(ctx, options, need(args[0], "open <place>"));
    case "wait":
      return wait(ctx, options, args[0]);
    case "doctor":
      return doctor(ctx, options);
    case "restart-hub":
      return restartHub(ctx, options);
    case "play":
      return play(ctx, options, args[0]);
    case "rule": {
      const { version, text } = rule(ctx.info);
      const body = options.prompt ? rulePrompt(ctx.info) : text;
      ctx.out(options.json ? JSON.stringify({ version, text: body }, null, 2) : body);
      return EXIT.ok;
    }
    case "ai-clients":
    case "connect-ai":
      return aiClients(ctx, options, command === "connect-ai", args);
    case "eval-server":
    case "eval-client":
    case "exec":
      return runLuau(ctx, options, command, args[0]);
    case "playtest":
      return playtest(ctx, options, args[0], args[1]);
    case "output":
      return output(ctx, options, args[0]);
    case "screenshot":
      return screenshot(ctx, options, args[0]);
    case "key":
      return key(ctx, options, args);
    case "device":
      return device(ctx, options, args[0]);
    case "click":
      return click(ctx, options, args);
    case "wait-for":
      return waitFor(ctx, options, args[0]);
    case "record":
      return record(ctx, options, args[0]);
    case "queue":
      return queue(ctx, options, args);
    case "gui":
      return gui(ctx, options, args);
    case "mouse":
      return mouse(ctx, options, args);
    case "verify":
      return verifySync(ctx, options, args[0]);
    case "perf":
      return perf(ctx, options, args[0]);
    case "logpoint":
      return logpoint(ctx, options, args);
    case "export":
      return exportRbxm(ctx, options, args);
    case "import":
      return importRbxm(ctx, options, args);
    case "inspect":
      return inspectInstance(ctx, options, args);
    case "set":
      return setProperties(ctx, options, args);
    case "simulate":
      return simulate(ctx, options, args[0]);
    case "tabs":
      return tabs(ctx, options, args[0]);
    case "devices":
      return devices(ctx, options, args[0]);
    case "profile":
      return profile(ctx, options, args);
    case "find":
      return findInstances(ctx, options, args[0]);
    case "docs":
      return docs(ctx, options, args);
    case "asset":
      return asset(ctx, options, args);
    case "memory":
      return memory(ctx, options, args[0]);
    case "profiler":
      return profiler(ctx, options, args[0]);
    case "scene":
      return scene(ctx, options, args[0]);
  }
  throw new UsageError(`unknown command ${command}. Run ${ctx.info.command} --help.`);
}

async function aiClients(ctx: ControlContext, options: Options, connect: boolean, names: string[]): Promise<number> {
  const env = ctx.clients ?? defaultClientsEnv();
  const unknown = names.filter((n) => !CLIENTS.some((kind) => n === kind || (kind !== "cursor" && n.startsWith(`${kind}:`))));
  if (unknown.length) throw new UsageError(`connect-ai takes ${CLIENTS.join(", ")}, not ${unknown.join(", ")}`);
  let found: ClientStatus[];
  if (connect) {
    if (!ctx.server) throw new UsageError("connect-ai runs only from the installed command");
    found = await connectClients(ctx.info, ctx.server, env, names);
  } else found = await listClients(ctx.info, env);
  const name = serverName(ctx.info);
  ctx.out(options.json ? JSON.stringify({ server: name, clients: found }, null, 2) : found.map((c) =>
    `${c.label}: ${!c.installed ? "not installed" : c.connected ? `has ${name}` : `no ${name}`}${c.problem ? ` (${c.problem})` : ""}`).join("\n"));
  return found.some((c) => c.problem) ? EXIT.error : EXIT.ok;
}

function need(value: string | undefined, usage: string): string {
  if (!value) throw new UsageError(`usage: ${usage}`);
  return value;
}

interface Place {
  placeId: string;
  name?: string;
  folder: string;
  conflicts?: number;
}

const placeLabel = (place: Place) => (place.name ? `${place.name} (${place.placeId})` : place.placeId);

const sameOrInside = (folder: string, target: string) => {
  const rel = path.relative(folder, target);
  // "..cache" is a folder inside; only ".." itself or "../..." leaves
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
};

/** An id, a name or part of one; none: the place whose folder holds the cwd, or the only one */
async function resolvePlace(ctx: ControlContext, query: string | undefined, state?: any): Promise<Place> {
  state ??= await ctx.client.get("/api/state");
  const places: Place[] = state.places;
  if (places.length === 0) throw new UsageError(`No place is registered with ${ctx.info.appName}.`);
  const list = () => places.map((p) => `  ${placeLabel(p)}`).join("\n");
  if (!query) {
    const cwd = process.platform === "win32" ? ctx.cwd.toLowerCase() : ctx.cwd;
    const here = places
      .filter((p) => sameOrInside(process.platform === "win32" ? p.folder.toLowerCase() : p.folder, cwd))
      .sort((a, b) => b.folder.length - a.folder.length)[0];
    if (here) return here;
    if (places.length === 1) return places[0];
    throw new UsageError(`Which place? Name one, or run this inside its folder:\n${list()}`);
  }
  const byId = places.find((p) => p.placeId === query);
  if (byId) return byId;
  if (/^\d+$/.test(query)) throw new UsageError(`Place ${query} is not registered with ${ctx.info.appName}:\n${list()}`);
  const lower = query.toLowerCase();
  const exact = places.filter((p) => p.name?.toLowerCase() === lower);
  if (exact.length === 1) return exact[0];
  const partial = places.filter((p) => p.name?.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  if (partial.length > 1) throw new UsageError(`"${query}" names more than one place:\n${partial.map((p) => `  ${placeLabel(p)}`).join("\n")}`);
  throw new UsageError(`No place called "${query}":\n${list()}`);
}

/** A conflict id names no place: the one named, else the place whose merges hold it */
async function placeOfConflict(ctx: ControlContext, id: string, query: string | undefined): Promise<Place> {
  if (query) return resolvePlace(ctx, query);
  const state = await ctx.client.get("/api/state");
  for (const place of state.places as Place[]) {
    const merges = await ctx.client.get("/api/merges", { placeId: place.placeId });
    if (merges.conflicts.some((c: any) => c.agentVersion === id) || merges.entries.some((e: any) => e.agentVersion === id)) return place;
  }
  throw new UsageError(`No place has a conflict ${id}. ${ctx.info.command} conflicts lists them.`);
}

function choiceText(choice: any): string {
  if (choice.kind === "setup") return "Set up asked in Studio";
  if (choice.kind === "secondStudio") return "a second Studio wants this place";
  const other = choice.other ?? {};
  return other.kind === "standalone" ? `folder synced by a standalone Quack (pid ${other.pid})` : `folder synced by another hub (port ${other.port})`;
}

function aiText(ai: any): string {
  if (!ai) return "checking";
  switch (ai.state) {
    case "ready":
      return `on, ${ai.provider}`;
    case "off":
      return "off";
    case "none":
      return "off (neither Claude Code nor Codex is installed and logged in)";
    case "choose":
      return "waiting for a choice between claude and codex";
  }
  return String(ai.state);
}

function formatStatus(ctx: ControlContext, state: any): string {
  const now = Date.now();
  // A hub from an older install may not report its build or the AI yet
  const lines = [`${ctx.info.appName} hub on ${ctx.client.port}, build ${state.build ?? "unknown"}${state.paused ? ", PAUSED" : ""}`];
  if ("ai" in state) lines.push(`AI merge: ${aiText(state.ai)}`);
  lines.push("");
  const sessions = new Map<string, any>(state.sessions.map((s: any) => [s.placeId, s]));
  if (state.places.length === 0) lines.push("No place registered.");
  else {
    lines.push(table(["PLACE", "ID", "STUDIO", "INSTANCES", "SCRIPTS", "CONFLICTS"], state.places.map((p: any) => {
      const s = sessions.get(p.placeId);
      const studio = !s ? "-" : s.studioConnected ? `connected ${ago(now, s.studioSince)}` : "daemon only";
      return [p.name ?? "", p.placeId, studio, s?.instances?.toLocaleString("en-US") ?? "", s?.scripts?.toLocaleString("en-US") ?? "", p.conflicts ? String(p.conflicts) : ""];
    })));
  }
  for (const choice of state.pending) lines.push(`Waiting for a choice: ${choice.placeName ?? choice.placeId}, ${choiceText(choice)} (${ctx.info.command} choices)`);
  for (const refusal of state.refused) lines.push(`Refused ${ago(now, refusal.at)} ago: ${refusal.placeName ?? refusal.placeId}: ${refusal.why}`);
  return lines.join("\n");
}

async function log(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  const place = await resolvePlace(ctx, query);
  const ansi = ctx.color && !options.json ? 1 : undefined;
  let chunk = await ctx.client.get("/api/log", { placeId: place.placeId, ansi });
  const emit = (text: string) => {
    if (!text) return;
    if (!options.json) {
      ctx.out(text.replace(/\n$/, ""));
      return;
    }
    for (const line of text.split("\n")) if (line) ctx.out(JSON.stringify({ line }));
  };
  emit(chunk.text);
  if (!options.follow) return EXIT.ok;
  for (;;) {
    await sleep(ctx.pollMs ?? 500);
    chunk = await ctx.client.get("/api/log", { placeId: place.placeId, from: chunk.next, ansi });
    if (chunk.reset && !options.json) ctx.out("----- the log was cut or replaced -----");
    emit(chunk.text);
  }
}

async function ai(ctx: ControlContext, options: Options, choice: string | undefined): Promise<number> {
  let status;
  if (choice === undefined) status = await ctx.client.get("/api/ai", { refresh: options.refresh ? 1 : undefined });
  else if (choice === "on" || choice === "off") status = await ctx.client.post("/api/ai", { ai: choice === "on" });
  else if (choice === "claude" || choice === "codex") status = await ctx.client.post("/api/ai", { ai: true, provider: choice });
  else throw new UsageError("ai [on|off|claude|codex]");
  const detected = Object.entries(status.detected as Record<string, any>).map(([name, d]) =>
    `  ${name}: ${!d.installed ? "not installed" : !d.loggedIn ? "not logged in" : `ready${d.model ? `, ${d.model}` : ""}`}${d.problem ? ` (${d.problem})` : ""}`);
  ctx.out(options.json ? JSON.stringify(status, null, 2) : [`AI merge: ${aiText(status.effective)}`, ...detected, `Settings: ${status.file}`].join("\n"));
  return EXIT.ok;
}

async function open(ctx: ControlContext, options: Options, query: string): Promise<number> {
  // An unregistered id opens too: the plugin's Set up registers it from there
  let place: Place;
  try {
    place = await resolvePlace(ctx, query);
  } catch (error) {
    if (!/^\d+$/.test(query) || error instanceof HubOffline) throw error;
    place = { placeId: query, folder: "" };
  }
  await ctx.openUri(`roblox-studio:1+task:EditPlace+placeId:${place.placeId}+universeId:0`);
  if (!options.json) ctx.out(`Opening ${placeLabel(place)} in Studio.`);
  if (!options.wait) {
    if (options.json) ctx.out(JSON.stringify({ ok: true, placeId: place.placeId }));
    return EXIT.ok;
  }
  return wait(ctx, { ...options, connected: true, timeout: options.timeout ?? 300 }, place.placeId);
}

/**
 * Until the place's Studio is connected and, unless --connected, nothing has crossed between
 * it and its daemon for --idle ms. The quiet is counted from the call too: a save just made
 * waits out the watcher's debounce before its patch counts as the last activity.
 */
async function wait(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  let place: Place;
  try {
    place = await resolvePlace(ctx, query);
  } catch (error) {
    // A place id not registered yet (open --wait before Set up): its session shows up once it is
    if (!query || !/^\d+$/.test(query) || error instanceof HubOffline) throw error;
    place = { placeId: query, folder: "" };
  }
  const idle = options.idle ?? 1500;
  const timeoutMs = (options.timeout ?? 120) * 1000;
  const started = Date.now();
  let quietFrom = started;
  let fixed: string[] | undefined;
  let said = false;
  for (;;) {
    const { sessions } = await ctx.client.get("/api/sessions");
    const session = sessions.find((s: any) => s.placeId === place.placeId);
    const now = Date.now();
    if (session?.studioConnected) {
      const quietSince = Math.max(quietFrom, session.lastActivity ?? 0, session.studioSince ?? 0);
      // A hub from before syncedAt sends none (undefined): there only the quiet counts
      const synced = session.syncedAt === undefined || (session.syncedAt !== null && session.syncedAt >= (session.studioSince ?? 0));
      if (options.connected) {
        const result = { ok: true, placeId: place.placeId, instances: session.instances, scripts: session.scripts, waitedMs: now - started };
        ctx.out(options.json ? JSON.stringify(result) : `${placeLabel(place)} is connected.`);
        return EXIT.ok;
      }
      if (synced && now - quietSince >= idle) {
        // Script files with no instance in Studio: a new file the sync never created (a merge
        // whose watcher events were lost) shows here instead of at the next play. A hub from
        // before the check answers 404: nothing to list
        const unsynced: string[] | undefined = await ctx.client
          .get("/api/unsynced", { placeId: place.placeId })
          .then((answer: any) => answer.files, () => undefined);
        // --fix: the daemon sends their creates again, once; then the quiet is waited for anew
        if (options.fix && fixed === undefined && unsynced?.length) {
          await ctx.client.post("/api/unsynced", { placeId: place.placeId });
          fixed = unsynced;
          quietFrom = Date.now();
          if (!options.json) ctx.out(`Sending the create of ${unsynced.length} script file(s) again...`);
          await sleep(ctx.pollMs ?? 250);
          continue;
        }
        const repaired = fixed?.filter((file) => !unsynced?.includes(file));
        const result = { ok: true, placeId: place.placeId, instances: session.instances, scripts: session.scripts, waitedMs: now - started, unsynced, ...(fixed ? { repaired } : {}) };
        if (options.json) {
          ctx.out(JSON.stringify(result));
        } else if (unsynced?.length) {
          if (repaired?.length) ctx.out(`${repaired.length} script file(s) now have their instance in Studio.`);
          ctx.out(`${placeLabel(place)} is connected, but ${unsynced.length} script file(s) on disk have no instance in Studio the sync knows:`);
          for (const file of unsynced) ctx.out(`  ${file}`);
          // Saving it again is an edit of a file nothing maps: only a create maps it
          if (!options.fix) ctx.out(`Run \`${ctx.info.command} wait --fix\` to send their creates again (Studio reuses a script already there, no duplicate).`);
        } else {
          if (repaired?.length) ctx.out(`${repaired.length} script file(s) now have their instance in Studio.`);
          ctx.out(`${placeLabel(place)} is connected and in sync.`);
        }
        return EXIT.ok;
      }
    } else if (!said && !options.json) {
      ctx.out(`Waiting for Studio to connect ${placeLabel(place)}...`);
      said = true;
    }
    if (now - started > timeoutMs) {
      throw new Timeout(session?.studioConnected
        ? `${placeLabel(place)} kept syncing for ${options.timeout ?? 120} s.`
        : `Studio did not connect ${placeLabel(place)} within ${options.timeout ?? 120} s.`);
    }
    await sleep(ctx.pollMs ?? 250);
  }
}

interface Check {
  ok: boolean | "warn";
  what: string;
  detail?: string;
}

async function doctor(ctx: ControlContext, options: Options): Promise<number> {
  const checks: Check[] = [];
  const [major, minor] = process.versions.node.split(".").map(Number);
  checks.push({ ok: major > 20 || (major === 20 && minor >= 19), what: `Node ${process.versions.node}`, detail: "Quack needs 20.19 or newer" });

  let state: any;
  try {
    state = await ctx.client.get("/api/state");
    checks.push({ ok: true, what: `Hub answers on ${ctx.client.port}, build ${state.build ?? "unknown"}` });
  } catch (error) {
    checks.push({ ok: false, what: `Hub on ${ctx.client.port}`, detail: `${(error as Error).message}. Is ${ctx.info.appName} running?` });
  }

  const installed = ctx.bundleDir ? readText(path.join(ctx.bundleDir, "BUILD")) : undefined;
  if (state && installed) {
    checks.push(state.build === installed
      ? { ok: true, what: "The hub is the one this install ships" }
      : { ok: "warn", what: "The hub running is from another install", detail: `running ${state.build}, installed ${installed}: Restart hub in the app, or ${ctx.info.command} restart-hub` });
  }

  const plugins = path.join(process.env.LOCALAPPDATA ?? path.join(os.homedir(), "AppData", "Local"), "Roblox", "Plugins");
  const pluginFile = path.join(plugins, ctx.info.plugin);
  const shipped = ctx.bundleDir ? path.join(ctx.bundleDir, "..", "plugin", ctx.info.plugin) : undefined;
  if (!fs.existsSync(pluginFile)) checks.push({ ok: false, what: `Plugin ${ctx.info.plugin}`, detail: `not in ${plugins}: ${ctx.info.appName} installs it when it starts` });
  else if (shipped && fs.existsSync(shipped) && !fs.readFileSync(shipped).equals(fs.readFileSync(pluginFile))) {
    checks.push({ ok: "warn", what: `Plugin ${ctx.info.plugin} differs from the one ${ctx.info.appName} ships`, detail: "restart the app to install it, then reopen the places in Studio" });
  } else checks.push({ ok: true, what: `Plugin ${ctx.info.plugin} installed` });

  if (state) {
    for (const place of state.places as Place[]) {
      if (!fs.existsSync(place.folder)) checks.push({ ok: false, what: `${placeLabel(place)}: folder missing`, detail: place.folder });
    }
    if (state.places.length) checks.push({ ok: true, what: `${state.places.length} place(s) registered` });
    if (state.paused) checks.push({ ok: "warn", what: "The hub is paused", detail: `${ctx.info.command} resume` });
    for (const choice of state.pending) checks.push({ ok: "warn", what: `${choice.placeName ?? choice.placeId} waits for a choice`, detail: choiceText(choice) });
    const conflicts = state.places.reduce((n: number, p: any) => n + (p.conflicts ?? 0), 0);
    if (conflicts) checks.push({ ok: "warn", what: `${conflicts} conflict(s) waiting`, detail: `${ctx.info.command} conflicts` });
  }

  if (options.json) ctx.out(JSON.stringify(checks, null, 2));
  else for (const c of checks) ctx.out(`${c.ok === true ? "ok  " : c.ok === "warn" ? "warn" : "FAIL"}  ${c.what}${c.detail && c.ok !== true ? `\n      ${c.detail}` : ""}`);
  return checks.some((c) => c.ok === false) ? EXIT.error : EXIT.ok;
}

/** The hub stops with its daemons; the app sees it gone and starts the hub it ships */
async function restartHub(ctx: ControlContext, options: Options): Promise<number> {
  const before = await ctx.client.get("/api/state");
  try {
    // A restart: the daemons keep running, and a Studio connected to its daemon keeps syncing
    await ctx.client.post("/api/shutdown", { handoff: true, ...(options.daemons ? { replaceDaemons: true } : {}) });
  } catch (error) {
    if (error instanceof HubError && error.status === 404) throw new Error("This hub was not started by the app and cannot be stopped from here.");
    throw error;
  }
  if (!options.json) ctx.out(`Stopping the hub (build ${before.build})...`);
  const poll = ctx.pollMs ?? 250;
  const stopBy = Date.now() + 15_000;
  // Gone, or already replaced between two polls (a new hub has another startedAt)
  for (;;) {
    let state: any;
    try {
      state = await ctx.client.get("/api/state");
    } catch (error) {
      if (error instanceof HubOffline) break;
      throw error;
    }
    // A hub from before startedAt existed reports none: the new one reporting one is a change too
    if (state.startedAt !== before.startedAt) break;
    if (Date.now() > stopBy) throw new Error("The hub did not stop within 15 s.");
    await sleep(poll);
  }
  const startBy = Date.now() + (options.timeout ?? 30) * 1000;
  for (;;) {
    try {
      const state = await ctx.client.get("/api/state");
      ctx.out(options.json ? JSON.stringify({ ok: true, before: before.build, after: state.build }) : `The hub is back, build ${state.build}. Studios reconnect on their own.`);
      return EXIT.ok;
    } catch (error) {
      if (!(error instanceof HubOffline)) throw error;
    }
    if (Date.now() > startBy) throw new Timeout(`The hub stopped and nothing started it again: is ${ctx.info.appName} running?`);
    await sleep(poll);
  }
}

function readText(file: string): string | undefined {
  try {
    return fs.readFileSync(file, "utf8").trim() || undefined;
  } catch {
    return undefined;
  }
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function ago(now: number, since: number | undefined): string {
  if (!since) return "";
  const s = Math.max(0, Math.round((now - since) / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m`;
  if (s < 86400) return `${Math.floor(s / 3600)}h${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}`;
  return `${Math.floor(s / 86400)}d`;
}

function when(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(date.getDate())}/${pad(date.getMonth() + 1)} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

function table(header: string[], rows: string[][]): string {
  const widths = header.map((h, i) => Math.max(h.length, ...rows.map((r) => (r[i] ?? "").length)));
  const line = (cells: string[]) => cells.map((c, i) => (i === cells.length - 1 ? c : (c ?? "").padEnd(widths[i]))).join("  ").trimEnd();
  return [line(header), ...rows.map(line)].join("\n");
}

/** The place a worktree belongs to: the registered folder of the same git repository */
async function placeOfWorktree(ctx: ControlContext, worktree: string): Promise<Place> {
  const { execFileSync } = await import("node:child_process");
  const common = (dir: string): string | undefined => {
    try {
      const out = execFileSync("git", ["-C", dir, "rev-parse", "--path-format=absolute", "--git-common-dir"], { encoding: "utf8", windowsHide: true, timeout: 10_000, stdio: ["ignore", "pipe", "ignore"] }).trim();
      return process.platform === "win32" ? path.resolve(out).toLowerCase() : path.resolve(out);
    } catch {
      return undefined;
    }
  };
  const mine = common(worktree);
  if (!mine) throw new UsageError(`${worktree} is not inside a git repository. Run ${ctx.info.command} play inside a worktree, or pass -w <folder>.`);
  const state = await ctx.client.get("/api/state");
  const matches = (state.places as Place[]).filter((p) => fs.existsSync(p.folder) && common(p.folder) === mine);
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) throw new UsageError(`No place registered with ${ctx.info.appName} syncs a folder of this repository.`);
  throw new UsageError(`More than one place syncs this repository; name one:\n${matches.map((p) => `  ${placeLabel(p)}`).join("\n")}`);
}

/** A hub or daemon from before 08/11/26 plays one worktree at a time: the executor reads this line */
export const ONE_AT_A_TIME = "plays one worktree at a time";

async function play(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  const list = [...new Set((options.worktrees.length ? options.worktrees : ["."]).map((w) => path.resolve(ctx.cwd, w)))];
  const worktree = list[0];
  const several = list.length > 1;
  const place = query ? await resolvePlace(ctx, query) : await placeOfWorktree(ctx, worktree);
  let started: any;
  try {
    ({ play: started } = await ctx.client.post("/api/play", several ? { placeId: place.placeId, worktrees: list } : { placeId: place.placeId, worktree }, 70_000));
  } catch (error) {
    // A hub from before 08/11/26 reads only `worktree` and answers 400 to a list
    if (several && error instanceof HubError && error.status === 400 && /worktree must be an absolute path/.test(error.message)) {
      throw new Error(`The hub ${ONE_AT_A_TIME} (it is older than this command): restart the hub, or play each worktree on its own.`);
    }
    throw error;
  }
  if (several && !Array.isArray(started?.worktrees)) {
    // A daemon from before 08/11/26 behind a newer hub: it played the first worktree only
    ctx.err(`The place's daemon ${ONE_AT_A_TIME} (it is older than this command): only ${started?.worktree ?? worktree} is in this play.`);
  }
  if (!started?.result?.ok) {
    const why = started?.result?.error ?? "the swap did not finish";
    if (options.json) ctx.out(JSON.stringify({ play: started }, null, 2));
    else {
      ctx.err(`Play of ${list.join(", ")} in ${placeLabel(place)} failed: ${why}`);
      // Which scripts, as Studio said it (before 25/10/26 only "could not be swapped in" came out)
      for (const line of started?.result?.failed ?? []) ctx.err(`  ${line}`);
      for (const line of started?.conflicts ?? []) ctx.err(`  conflict: ${line}`);
      if (several) for (const part of started?.worktrees ?? []) if (part.swapFailed?.length) ctx.err(`  refused for ${part.worktree}: ${part.swapFailed.length} script(s)`);
    }
    return EXIT.error;
  }
  // The play session's check comes once its plugin loads (seconds after the game's scripts)
  const deadline = Date.now() + (options.timeout ?? 60) * 1000;
  let state = started;
  while (!state.verify && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, ctx.pollMs ?? 500));
    const latest = (await ctx.client.get("/api/play", { placeId: place.placeId })).play;
    // Another play of this place started meanwhile: its result is not this one's
    if (latest && latest.id !== started.id) throw new Error("another play of this place started before this one's check came back");
    if (latest) state = latest;
  }
  const parts: any[] = Array.isArray(state.worktrees) && state.worktrees.length > 1 ? state.worktrees : [];
  if (options.json) {
    ctx.out(JSON.stringify({ play: state }, null, 2));
  } else if (parts.length) {
    ctx.out(`Playing ${parts.length} worktrees in ${placeLabel(place)}: ${state.patches} changed, ${state.creates} new, ${state.disables} turned off.`);
    ctx.out(`The place in edit mode held the branches for ${Math.round(state.result.windowMs ?? 0)} ms, and has its own scripts again.`);
    if (state.result.closedTabs?.length) ctx.out(`Closed the Studio tab of ${state.result.closedTabs.join(", ")} first, so the play takes the branch's text.`);
    if (!state.verify) ctx.err("The play session did not report its check (closed early, or a plugin without play support).");
    for (const part of parts) {
      ctx.out(`${part.worktree}: ${part.patches} changed, ${part.creates} new, ${part.disables} turned off.`);
      if (part.checks === 0) ctx.out("  The branch brings no script change since it forked from the place's folder.");
      for (const line of part.skipped ?? []) ctx.out(`  not carried: ${line}`);
      for (const line of part.conflicts ?? []) ctx.out(`  conflict: ${line}`);
      if (!part.verify) continue;
      if (part.verify.ok) ctx.out(`  Checked inside the play: ${part.verify.passed} of ${part.checks} have the branch.`);
      else {
        ctx.err(`  The play session does NOT have ${part.worktree}'s branch: ${part.verify.failed.slice(0, 10).join("; ")}`);
        if (part.verify.failed.some((line: string) => line.includes("has the place's text"))) ctx.err(`  Likely cause: ${PLAY_TAB_HINT}.`);
      }
      if (part.verify.unverified?.length) ctx.out(`  ${part.verify.unverified.length} swapped script(s) were gone before the check (the game removed them), so not checked.`);
    }
  } else {
    ctx.out(`Playing ${state.worktree} in ${placeLabel(place)}: ${state.patches} changed, ${state.creates} new, ${state.disables} turned off.`);
    if (state.checks === 0) ctx.out("The branch brings no script change since it forked from the place's folder: this play runs the place as Studio has it.");
    ctx.out(`The place in edit mode held the branch for ${Math.round(state.result.windowMs ?? 0)} ms, and has its own scripts again.`);
    if (state.result.closedTabs?.length) ctx.out(`Closed the Studio tab of ${state.result.closedTabs.join(", ")} first, so the play takes the branch's text.`);
    for (const line of state.skipped ?? []) ctx.out(`  not carried: ${line}`);
    for (const line of state.conflicts ?? []) ctx.out(`  conflict: ${line}`);
    // A hub from before 25/10/26 does not say how many checks it sent
    const total = state.checks ?? state.verify?.passed;
    if (!state.verify) ctx.err("The play session did not report its check (closed early, or a plugin without play support).");
    else if (state.verify.ok) ctx.out(`Checked inside the play: ${state.verify.passed} of ${total} have the branch.`);
    else {
      ctx.err(`The play session does NOT have the branch: ${state.verify.failed.slice(0, 10).join("; ")}`);
      if (state.verify.failed.some((line: string) => line.includes("has the place's text"))) ctx.err(`  Likely cause: ${PLAY_TAB_HINT}.`);
    }
    if (state.verify?.unverified?.length) ctx.out(`  ${state.verify.unverified.length} swapped script(s) were gone before the check (the game removed them), so not checked.`);
  }
  if (!state.verify) return EXIT.timeout;
  // Several worktrees: ok only when every one of them is in the play
  if (several && !(Array.isArray(state.worktrees) && state.worktrees.length === list.length)) return EXIT.error;
  return state.verify.ok ? EXIT.ok : EXIT.error;
}

/**
 * One Studio tool call through the hub (`/api/studio`), answered by the place's daemon once
 * Studio has. `waitMs` is how long the tool itself may take; the hub and daemon add their margin.
 */
async function studio(ctx: ControlContext, place: Place, tool: string, args: Record<string, unknown>, waitMs = 60_000): Promise<any> {
  try {
    const player = PLAYER.get(ctx);
    const result = (await ctx.client.post("/api/studio", { placeId: place.placeId, tool, args: { ...args, caller: ctx.caller ?? "cli", ...(player ? { player } : {}) } }, waitMs + 40_000)).result;
    if ((Array.isArray(result?.newErrors) && result.newErrors.length) || result?.repeatedErrors) NOTES.get(ctx)?.push(newErrorsText(result.newErrors ?? [], result.repeatedErrors));
    return result;
  } catch (error) {
    if (error instanceof HubError && error.status === 404 && error.message === "not found") {
      throw new Error(`The hub is older than this command: restart it (${ctx.info.command} restart-hub).`);
    }
    if (error instanceof HubError && /daemon answered 404|no Studio tools/.test(error.message)) {
      throw new Error(`The daemon of ${placeLabel(place)} is older than this command: ${ctx.info.command} restart-hub --daemons.`);
    }
    if (error instanceof HubError) throw new Error(`${placeLabel(place)}: ${error.message}`);
    throw error;
  }
}

/** Lines a command prints after its own answer (the play's new errors), per call */
const NOTES = new WeakMap<ControlContext, string[]>();
/** --player: the client a multiplayer test's call goes to */
const PLAYER = new WeakMap<ControlContext, string>();

/** The play errors logged since the caller's previous Studio call, one line each */
export function newErrorsText(errors: { source: string; message: string; count: number; at?: string }[], repeated = 0): string {
  const again = repeated ? `${repeated} more of errors shown before` : "";
  if (!errors.length) return `The play logged ${again} since the last call.`;
  const lines = errors.map((e) => `  [${e.source}] ${e.message}${e.at && !e.message.includes(e.at) ? ` (at ${e.at})` : ""}${e.count > 1 ? ` (x${e.count})` : ""}`);
  if (again) lines.push(`  (and ${again})`);
  return [`New error${errors.length === 1 && errors[0].count === 1 ? "" : "s"} in the play since the last call (get_runtime_logs has the rest of each):`, ...lines].join("\n");
}

function luauCode(ctx: ControlContext, options: Options): string {
  if (options.code !== undefined && options.file !== undefined) throw new UsageError("give --code or --file, not both");
  if (options.file !== undefined) {
    try {
      return fs.readFileSync(path.resolve(ctx.cwd, options.file), "utf8");
    } catch (error) {
      throw new UsageError(`cannot read ${options.file}: ${(error as Error).message}`);
    }
  }
  if (options.code === undefined || options.code.trim() === "") throw new UsageError("give the Luau as --code=<luau> or --file <path>");
  return options.code;
}

const PEER_NAME: Record<string, string> = { server: "the play server", client: "the play client", edit: "the edit plugin" };

/** eval-server, eval-client and exec: what the code printed, then what it returned or its error */
async function runLuau(ctx: ControlContext, options: Options, command: string, query: string | undefined): Promise<number> {
  const code = luauCode(ctx, options);
  const place = await resolvePlace(ctx, query);
  const timeoutMs = (options.timeout ?? 30) * 1000;
  const result = command === "exec"
    ? await studio(ctx, place, "exec", { code, timeoutMs }, timeoutMs)
    : await studio(ctx, place, "eval", { code, peer: command === "eval-client" ? "client" : "server", timeoutMs }, timeoutMs);
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return result.ok ? EXIT.ok : EXIT.error;
  }
  for (const line of result.output ?? []) ctx.out(String(line));
  if (result.ok) {
    const values: string[] = result.values ?? [];
    ctx.out(values.length ? `=> ${values.join(", ")}` : "=> (nothing returned)");
    ctx.out(`(${result.ms} ms in ${PEER_NAME[result.peer] ?? result.peer})`);
    return EXIT.ok;
  }
  ctx.err(`Luau error in ${PEER_NAME[result.peer] ?? result.peer}: ${result.error}`);
  return EXIT.error;
}

async function playtest(ctx: ControlContext, options: Options, action: string | undefined, query: string | undefined): Promise<number> {
  if (action !== "start" && action !== "stop" && action !== "status") throw new UsageError("usage: playtest start|stop|status [place] [--run]");
  const place = await resolvePlace(ctx, query);
  const timeoutMs = options.timeout === undefined ? undefined : options.timeout * 1000;
  const players = action === "start" ? positiveInt(options.players, "players") : undefined;
  const result = await studio(ctx, place, "playtest", { action, ...(action === "start" ? { mode: options.run ? "run" : "play" } : {}), ...(players ? { players } : {}), ...(timeoutMs ? { timeoutMs } : {}) }, timeoutMs ?? (players ? 120_000 : 60_000));
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  if (action === "status") {
    if (!result.editConnected) ctx.out(`${placeLabel(place)}: Studio is not connected.`);
    else if (!result.playing) ctx.out(`${placeLabel(place)}: no play is running.`);
    else ctx.out(`${placeLabel(place)}: a play is running (server: ${result.server}, client: ${result.client}).`);
    return EXIT.ok;
  }
  if (action === "start" && Array.isArray(result.players)) ctx.out(`${placeLabel(place)}: the multiplayer test is running, server and ${result.players.join(", ")} connected in ${result.ms} ms (--player <name> picks a client).`);
  else if (action === "start") ctx.out(`${placeLabel(place)}: the ${result.mode === "run" ? "Run-mode " : ""}play is running, server${result.mode === "run" ? "" : " and client"} connected in ${result.ms} ms.`);
  else ctx.out(`${placeLabel(place)}: the play stopped and Studio is back in edit mode (${result.ms} ms).`);
  return EXIT.ok;
}

function positiveInt(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) throw new UsageError(`--${name} must be a whole number above 0`);
  return n;
}

async function output(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  const place = await resolvePlace(ctx, query);
  if (options.peer !== undefined && options.peer !== "server" && options.peer !== "client") throw new UsageError("--peer must be server or client");
  if (options.cursor !== undefined && !/^\d+$/.test(options.cursor)) throw new UsageError("--cursor must be the number a previous read printed");
  const result = await studio(ctx, place, "logs", { cursor: options.cursor, tail: positiveInt(options.tail, "tail"), filter: options.filter, peer: options.peer }, 5000);
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  if (result.dropped) ctx.out(`(${result.dropped} line(s) after the cursor were dropped from the buffer)`);
  if (result.skipped) ctx.out(`(${result.skipped} earlier line(s) left out; --tail or a newer --cursor reads fewer)`);
  const level: Record<string, string> = { MessageWarning: "WARN ", MessageError: "ERROR ", MessageInfo: "INFO " };
  for (const e of result.entries) {
    const time = new Date(e.t).toTimeString().slice(0, 8);
    ctx.out(`${time} ${e.source === "quack" ? "" : `[${e.source}] `}${level[e.type] ?? ""}${String(e.message).replace(/\r?\n/g, "\n    ")}`);
  }
  if (!result.entries.length) ctx.out(result.playing ? "(nothing new)" : "(nothing new; no play is running)");
  ctx.out(`cursor: ${result.cursor}`);
  return EXIT.ok;
}

async function screenshot(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  const place = await resolvePlace(ctx, query);
  const result = await studio(ctx, place, "screenshot", { focus: options.focus, width: positiveInt(options.width, "width") }, 40_000);
  if (options.out) {
    const target = path.resolve(ctx.cwd, options.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(result.file, target);
    result.file = target;
  }
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  const scaled = !result.crop && result.width !== result.nativeWidth ? `, scaled down from ${result.nativeWidth}x${result.nativeHeight}` : "";
  const focused = result.focus ? ` (${result.crop ? "cropped to" : "camera on"} ${result.focus})` : "";
  ctx.out(`Screenshot of ${result.peer === "client" ? "the play client" : "Studio in edit mode"}${focused}: ${result.width}x${result.height}${scaled}, ${(result.bytes / 1024).toFixed(0)} KB PNG, ${result.ms} ms`);
  ctx.out(result.file);
  return EXIT.ok;
}

async function key(ctx: ControlContext, options: Options, args: string[]): Promise<number> {
  // key <KeyCode> [place], or key [place] --text=<text>
  const keyCode = options.text === undefined ? need(args[0], "key <KeyCode> [place] | key [place] --text=<text>") : undefined;
  const place = await resolvePlace(ctx, options.text === undefined ? args[1] : args[0]);
  const duration = options.duration === undefined ? undefined : Number(options.duration);
  if (duration !== undefined && !Number.isFinite(duration)) throw new UsageError("--duration must be a number of seconds");
  if (options.peer !== undefined && options.peer !== "client" && options.peer !== "edit") throw new UsageError("--peer must be client or edit");
  const result = await studio(ctx, place, "key", { keyCode, text: options.text, action: options.action, duration, peer: options.peer }, 15_000 + (duration ?? 0) * 1000);
  if (options.json) ctx.out(JSON.stringify(result, null, 2));
  else ctx.out(`${options.text !== undefined ? `Typed ${JSON.stringify(options.text)}` : `${options.action ?? "tap"} ${keyCode}`}: sent to ${PEER_NAME[result.peer] ?? result.peer}.`);
  return EXIT.ok;
}

async function device(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  const place = await resolvePlace(ctx, query);
  let resolution: { width: number; height: number } | undefined;
  if (options.resolution !== undefined) {
    const match = /^(\d+)x(\d+)$/.exec(options.resolution);
    if (!match) throw new UsageError("--resolution is <width>x<height>, e.g. 1920x1080");
    resolution = { width: Number(match[1]), height: Number(match[2]) };
  }
  const density = options.density === undefined ? undefined : Number(options.density);
  if (density !== undefined && !(density > 0)) throw new UsageError("--density must be a number above 0");
  const result = await studio(ctx, place, "device", {
    deviceId: options.id, orientation: options.orientation, scalingMode: options.scaling, resolution, pixelDensity: density,
    stop: options.stop, list: options.list,
  }, 20_000);
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  if (result.applied && Object.keys(result.applied).length) ctx.out(`Applied ${JSON.stringify(result.applied)}.`);
  const state = result.after ?? result;
  const resolutionText = state.resolution ? ` at ${state.resolution.width}x${state.resolution.height}` : "";
  ctx.out(state.isSimulating
    ? `Simulating ${state.activeDeviceId}${resolutionText}${state.orientation ? `, ${state.orientation}` : ""}${state.scalingMode ? `, ${state.scalingMode}` : ""}${state.pixelDensity ? `, density ${state.pixelDensity}` : ""}.`
    : "The device simulator is off.");
  if (Array.isArray(result.devices)) ctx.out(`Devices: ${result.devices.join(", ")}`);
  return EXIT.ok;
}

async function click(ctx: ControlContext, options: Options, args: string[]): Promise<number> {
  const target = need(args[0], "click <path> [place]");
  if (options.method !== undefined && !["auto", "input", "select"].includes(options.method)) throw new UsageError("--method must be auto, input or select");
  const place = await resolvePlace(ctx, args[1]);
  const result = await studio(ctx, place, "click", { path: target, method: options.method }, 20_000);
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  ctx.out(clickSummary(result));
  return EXIT.ok;
}

/** One line on a click: where, how, and which of the button's signals fired */
export function clickSummary(result: any): string {
  const signals = [result.activated ? "Activated" : "", result.mouseButton1Click ? "MouseButton1Click" : ""].filter(Boolean).join(" and ");
  const how = result.method === "select"
    ? "selected it and pressed Return"
    : `clicked at (${result.x}, ${result.y}) on a ${result.screen?.width}x${result.screen?.height} screen`;
  return `${result.path}: ${how}; ${signals} fired (${result.ms} ms).`;
}

/** The tree of the gui command, one line an object, indented by depth */
export function guiText(result: any): string {
  const lines: string[] = [];
  const screen = result.screen ? `, screen ${result.screen.width}x${result.screen.height}` : "";
  lines.push(`${result.root} (${result.peer === "edit" ? "edit mode" : "the play client"}${screen}; positions in GUI pixels, below the top bar)`);
  for (const node of result.nodes ?? []) {
    const parts = [`${"  ".repeat(node.d)}${node.n} [${node.c}]`];
    if (typeof node.t === "string") parts.push(JSON.stringify(node.t));
    if (node.img) parts.push(`img ${node.img}`);
    if (Array.isArray(node.r)) parts.push(`at ${node.r[0]},${node.r[1]} ${node.r[2]}x${node.r[3]}`);
    if (node.off) parts.push(`hidden (${node.off})`);
    else if (node.btn === true) parts.push("clickable");
    else if (typeof node.btn === "string" && node.btn !== "hidden") parts.push(`not clickable: ${node.btn}`);
    if (Array.isArray(node.scroll) && (node.scroll[0] || node.scroll[1])) parts.push(`scrolled to ${node.scroll[0]},${node.scroll[1]}`);
    if (node.m) parts.push(`{${node.m}}`);
    if (node.more) parts.push(`+${node.more} inside`);
    lines.push(parts.join("  "));
  }
  if (result.truncated) lines.push(`(stopped at ${result.nodes.length} objects: a higher limit, or a deeper path)`);
  return lines.join("\n");
}

async function gui(ctx: ControlContext, options: Options, args: string[]): Promise<number> {
  // gui [path] [place]: an argument with a dot, or a GUI root's name, is a path; else a place
  const looksLikePath = (value: string | undefined) => value !== undefined && /[.]|^(PlayerGui|StarterGui)$/.test(value);
  // A place name with a dot in it stays a place: the argument is a path only when no place answers to it
  let positional = options.path === undefined && looksLikePath(args[0]) ? args[0] : undefined;
  if (positional !== undefined && args[1] === undefined) {
    const isPlace = await resolvePlace(ctx, positional).then(() => true, () => false);
    if (isPlace) positional = undefined;
  }
  const target = options.path ?? positional;
  const place = await resolvePlace(ctx, positional === undefined ? args[0] : args[1]);
  const result = await studio(ctx, place, "gui", { path: target, depth: wholeOption(options.depth, "depth"), limit: positiveInt(options.limit, "limit"), hidden: options.hidden }, 20_000);
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  ctx.out(guiText(result));
  return EXIT.ok;
}

function wholeOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0) throw new UsageError(`--${name} must be a whole number, 0 or more`);
  return n;
}

/** One line on a mouse press: where it went and what was under it */
export function mouseSummary(result: any): string {
  const what = result.action === "double" ? "double-clicked" : result.action === "down" ? "pressed" : result.action === "up" ? "released" : "clicked";
  const target = result.target ? ` ${result.target}` : "";
  const under = [result.under ? `GUI under it: ${result.under}` : "no GUI under it", result.hit ? `world: ${result.hit}` : ""].filter(Boolean).join("; ");
  const button = result.button && result.button !== "left" ? `${result.button} button ` : "";
  return `${button}${what}${target} at (${result.x}, ${result.y}) on the ${result.screen?.width}x${result.screen?.height} screen (GUI ${result.gui?.x},${result.gui?.y}); ${under} (${result.ms} ms).`;
}

async function mouse(ctx: ControlContext, options: Options, args: string[]): Promise<number> {
  let x: number | undefined;
  let y: number | undefined;
  let rest = args;
  if (options.path === undefined) {
    x = Number(need(args[0], "mouse <x> <y> [place] | mouse --path=<path> [place]"));
    y = Number(need(args[1], "mouse <x> <y> [place]"));
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new UsageError("x and y must be numbers (pixels on the last screenshot)");
    rest = args.slice(2);
  }
  if (options.space !== undefined && options.space !== "screen" && options.space !== "screenshot") throw new UsageError("--space must be screenshot or screen");
  const place = await resolvePlace(ctx, rest[0]);
  const result = await studio(ctx, place, "mouse", { x, y, path: options.path, action: options.action, button: options.button, space: options.space }, 15_000);
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  ctx.out(mouseSummary(result));
  return EXIT.ok;
}

/** verify's answer: a line per script that differs, then the count */
export function verifyText(result: any): string {
  const how: Record<string, string> = {
    source: "Studio's .Source is not the disk's text",
    tab: "the .Source matches, but an open tab in Studio holds other text (a play copies the tab's)",
    both: "neither the .Source nor the open tab is the disk's text",
    missing: "its instance is gone from Studio",
    unreadable: "Studio could not read its Source",
  };
  const lines: string[] = [];
  for (const d of result.differ ?? []) {
    const sizes = d.diskLen !== undefined ? ` (disk ${d.diskLen} bytes, Studio ${d.studioLen}${d.tabLen !== undefined ? `, tab ${d.tabLen}` : ""})` : "";
    lines.push(`${d.file}: ${how[d.state] ?? d.state}${sizes}${d.error ? `: ${d.error}` : ""}`);
  }
  for (const file of result.unmapped ?? []) lines.push(`${file}: no instance in Studio (wait --fix sends its create again)`);
  for (const file of result.unreadable ?? []) lines.push(`${file}: could not be read from disk`);
  const problems = (result.differ?.length ?? 0) + (result.unmapped?.length ?? 0) + (result.unreadable?.length ?? 0);
  lines.push(problems
    ? `${result.same} of ${result.checked} scripts match the disk; ${problems} do not (${result.ms} ms).`
    : `All ${result.checked} scripts in Studio match the disk (${result.ms} ms).`);
  return lines.join("\n");
}

async function verifySync(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  const place = await resolvePlace(ctx, query);
  const files = options.files === undefined ? undefined : options.files.split(",").map((f) => f.trim()).filter(Boolean);
  const result = await studio(ctx, place, "verify", { ...(files?.length ? { files } : {}) }, 150_000);
  const ok = !result.differ?.length && !result.unmapped?.length && !result.unreadable?.length;
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return ok ? EXIT.ok : EXIT.error;
  }
  ctx.out(verifyText(result));
  return ok ? EXIT.ok : EXIT.error;
}

/** perf's answer: two lines a peer */
export function perfText(result: any): string {
  const lines: string[] = [];
  for (const peer of ["server", "client"]) {
    const p = result[peer];
    if (!p) continue;
    const f = p.frameMs ?? {};
    const physics = p.physicsFps !== undefined ? `, physics ${p.physicsFps} fps` : "";
    lines.push(`${peer}: ${p.fps} ${p.signal === "Heartbeat" ? "heartbeats" : "frames"} a second over ${p.seconds} s${physics}; frame ms p50 ${f.p50}, p90 ${f.p90}, p99 ${f.p99}, max ${f.max}; ${p.hitches} over 50 ms${p.warning ? ` (${p.warning})` : ""}`);
    const tags = (p.memoryTags ?? []).slice(0, 5).map((t: any) => `${t.tag} ${t.mb}`).join(", ");
    const net = p.stats?.DataReceiveKbps !== undefined ? `; receive ${p.stats.DataReceiveKbps} kbps, send ${p.stats.DataSendKbps}` : "";
    lines.push(`  memory ${p.memoryMb} MB (${p.memoryChangeMb >= 0 ? "+" : ""}${p.memoryChangeMb} during)${tags ? `: ${tags}` : ""}; ${p.stats?.InstanceCount ?? "?"} instances${net}`);
  }
  if (result.note) lines.push(`(${result.note})`);
  return lines.join("\n");
}

async function perf(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  const seconds = secondsOption(options.seconds, "seconds") ?? 3;
  if (options.peer !== undefined && options.peer !== "server" && options.peer !== "client") throw new UsageError("--peer must be server or client");
  const place = await resolvePlace(ctx, query);
  const result = await studio(ctx, place, "perf", { seconds, peer: options.peer }, seconds * 1000 + 20_000);
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  ctx.out(perfText(result));
  return EXIT.ok;
}

async function logpoint(ctx: ControlContext, options: Options, args: string[]): Promise<number> {
  const action = need(args[0], "logpoint add|remove|list|clear ...");
  if (!["add", "remove", "list", "clear"].includes(action)) throw new UsageError("logpoint add|remove <file or path> --line <n> [place], or logpoint list|clear [place]");
  const needsScript = action === "add" || action === "remove";
  // The script: a file from the sync folder as the argument, or --path=<instance path>
  const file = needsScript && options.path === undefined ? need(args[1], `logpoint ${action} <file> --line <n> [place], or --path=<instance path>`) : undefined;
  const place = await resolvePlace(ctx, file !== undefined ? args[2] : args[1]);
  const line = needsScript ? positiveInt(need(options.line, "--line <n>"), "line") : undefined;
  const result = await studio(ctx, place, "logpoint", {
    action, line, message: options.message, condition: options.condition,
    ...(file !== undefined ? { file } : needsScript ? { path: options.path } : {}),
  }, 20_000);
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  if (action === "list") {
    for (const lp of result.logpoints ?? []) ctx.out(`${lp.path}:${lp.line}${lp.message ? `  ${lp.message}` : ""}${lp.condition ? `  if ${lp.condition}` : ""}`);
    if (!result.logpoints?.length) ctx.out("No logpoints set (by this plugin since Studio opened).");
  } else if (action === "clear") ctx.out(`Removed ${result.removed} logpoint(s).`);
  else if (action === "remove") ctx.out(`Removed the logpoint at ${result.path}:${result.line}.`);
  else {
    const moved = result.requestedLine ? ` (Studio moved it from line ${result.requestedLine})` : "";
    ctx.out(`Logpoint at ${result.path}:${result.line}${moved}: its lines show in the play's output as "[logpoint ...]".${result.note ? ` Studio: ${result.note}` : ""}`);
  }
  return EXIT.ok;
}

async function exportRbxm(ctx: ControlContext, options: Options, args: string[]): Promise<number> {
  const paths = need(args[0], "export <path>[,<path>...] [place] [--out <file.rbxm>]").split(",").map((p) => p.trim()).filter(Boolean);
  const place = await resolvePlace(ctx, args[1]);
  if (options.out !== undefined && !/\.rbxm$/i.test(options.out)) throw new UsageError("--out must be an .rbxm file");
  const result = await studio(ctx, place, "exportRbxm", { paths, ...(options.out ? { out: path.resolve(ctx.cwd, options.out) } : {}) }, 130_000);
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  ctx.out(`Saved ${result.instances.join(", ")} as ${(result.bytes / 1024).toFixed(0)} KB (${result.ms} ms):`);
  ctx.out(result.file);
  return EXIT.ok;
}

async function importRbxm(ctx: ControlContext, options: Options, args: string[]): Promise<number> {
  const file = path.resolve(ctx.cwd, need(args[0], "import <file.rbxm> [place] [--parent <path>]"));
  const place = await resolvePlace(ctx, args[1]);
  const result = await studio(ctx, place, "importRbxm", { file, parent: options.parent }, 130_000);
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  ctx.out(`Put ${result.placed.join(", ")} in the place${result.scripts ? `; its ${result.scripts} script(s) sync to disk` : ""} (${result.ms} ms).`);
  return EXIT.ok;
}

function jsonOption(value: string | undefined, name: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  try {
    const parsed = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    return parsed;
  } catch (error) {
    throw new UsageError(`--${name} must be a JSON object of name: value (${(error as Error).message})`);
  }
}

/** inspect's answer: the instance, then a line a property, attribute and tag */
export function inspectText(result: any): string {
  const lines = [`${result.path} [${result.className}] in ${PEER_NAME[result.peer] ?? result.peer}`];
  if (result.pivot) lines.push(`  pivot: ${result.pivot}`);
  if (result.boundingBox) lines.push(`  bounding box: ${result.boundingBox}`);
  if (result.properties?.length) {
    lines.push(result.defaultsLeftOut ? "Properties (the ones not at their default):" : "Properties:");
    for (const p of result.properties) lines.push(`  ${p.name} = ${p.value}  (${p.type})`);
  }
  if (result.attributes?.length) {
    lines.push("Attributes:");
    for (const a of result.attributes) lines.push(`  ${a.name} = ${a.value}  (${a.type})`);
  }
  if (result.tags?.length) lines.push(`Tags: ${result.tags.join(", ")}`);
  if (result.childCount) lines.push(`Children (${result.childCount}): ${result.children.join(", ")}${result.childCount > result.children.length ? ", ..." : ""}`);
  if (result.unread) lines.push(`(${result.unread} properties a plugin cannot read were left out)`);
  return lines.join("\n");
}

async function inspectInstance(ctx: ControlContext, options: Options, args: string[]): Promise<number> {
  const target = need(args[0], "inspect <path> [place]");
  const place = await resolvePlace(ctx, args[1]);
  const result = await studio(ctx, place, "inspect", { path: target, peer: options.peer, all: options.all, hidden: options.hidden }, 20_000);
  if (options.json) ctx.out(JSON.stringify(result, null, 2));
  else ctx.out(inspectText(result));
  return EXIT.ok;
}

async function setProperties(ctx: ControlContext, options: Options, args: string[]): Promise<number> {
  const target = need(args[0], "set <path> [place] --props=<json> --attrs=<json>");
  const properties = jsonOption(options.props, "props");
  const attributes = jsonOption(options.attrs, "attrs");
  if (!properties && !attributes) throw new UsageError("give --props=<json> and/or --attrs=<json>");
  const place = await resolvePlace(ctx, args[1]);
  const result = await studio(ctx, place, "setProps", { path: target, peer: options.peer, properties, attributes }, 20_000);
  if (options.json) ctx.out(JSON.stringify(result, null, 2));
  else {
    ctx.out(`${result.path} in ${PEER_NAME[result.peer] ?? result.peer}:`);
    for (const c of result.changed) ctx.out(`  ${c.kind === "attribute" ? "attribute " : ""}${c.name}: ${c.before} -> ${c.after}`);
  }
  return EXIT.ok;
}

function sideOption(value: string | undefined, name: string): Record<string, number> | undefined {
  if (value === undefined) return undefined;
  const [latencyMs, jitterMs, lossPercent] = value.split(",").map((v) => (v.trim() === "" ? undefined : Number(v)));
  const side: Record<string, number> = {};
  for (const [key, n] of Object.entries({ latencyMs, jitterMs, lossPercent })) {
    if (n === undefined) continue;
    if (!Number.isFinite(n) || n < 0) throw new UsageError(`--${name} is <latency ms>,<jitter ms>,<loss %>, each a number 0 or more`);
    side[key] = n;
  }
  return side;
}

/** simulate's answer: the network both ways, the quality, the memory */
export function simulationText(state: any): string {
  if (!state) return "(no state)";
  const side = (prefix: string) => `${state[`${prefix}NetworkMinDelayMs`]} ms, jitter ${state[`${prefix}NetworkJitterMs`]} ms, loss ${state[`${prefix}NetworkLossPercent`]}%`;
  const memory = typeof state.EmulatedTotalMemoryInMB === "number" ? `${Math.round(state.EmulatedTotalMemoryInMB / 1024 * 10) / 10} GB` : "?";
  return `inbound ${side("Inbound")}; outbound ${side("Outbound")}; graphics ${state.QualityLevel}; device memory ${memory}`;
}

async function simulate(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  const place = await resolvePlace(ctx, query);
  const quality = options.quality === undefined ? undefined : options.quality === "auto" ? "auto" : Number(options.quality);
  const memoryMb = options.memory === undefined ? undefined : Number(options.memory);
  const result = await studio(ctx, place, "simulate", {
    network: options.network, inbound: sideOption(options.inbound, "inbound"), outbound: sideOption(options.outbound, "outbound"), quality, memoryMb,
  }, 20_000);
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  const changed = JSON.stringify(result.edit?.before) !== JSON.stringify(result.edit?.after);
  ctx.out(`${changed ? "Now" : "Simulation"}: ${simulationText(result.edit?.after)}`);
  if (changed) ctx.out(`Was: ${simulationText(result.edit?.before)}`);
  if (result.client?.error) ctx.out(`The play client did not take it: ${result.client.error}`);
  else if (result.client) ctx.out("The play client has it too.");
  return EXIT.ok;
}

async function tabs(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  const place = await resolvePlace(ctx, query);
  const close = options.close === undefined ? undefined : options.close.split(",").map((p) => p.trim()).filter(Boolean);
  const result = await studio(ctx, place, "tabs", { close, closeEdited: options.closeEdited }, 40_000);
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  for (const c of result.closed ?? []) ctx.out(`closed ${c.path}${c.edited ? " (it was edited)" : ""}${c.ok ? "" : `: failed, ${c.error}`}`);
  for (const t of result.tabs ?? []) ctx.out(`${t.edited ? "EDITED " : ""}${t.path}`);
  if (!result.tabs?.length && !result.closed?.length) ctx.out("No script tab is open in this Studio.");
  return EXIT.ok;
}

async function devices(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  const place = await resolvePlace(ctx, query);
  const list = options.devices === undefined ? undefined : options.devices.split(",").map((d) => d.trim()).filter(Boolean);
  const width = positiveInt(options.width, "width");
  const result = await studio(ctx, place, "devices", { devices: list, orientation: options.orientation, ...(width ? { width } : {}) }, 120_000);
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  ctx.out(`${result.shots.length} devices in one picture, ${result.width}x${result.height}, left to right: ${result.shots.map((s: any) => `${s.device} (${s.width}x${s.height})`).join(", ")} (${result.ms} ms)`);
  ctx.out(result.sheet);
  return EXIT.ok;
}

async function profile(ctx: ControlContext, options: Options, args: string[]): Promise<number> {
  const action = need(args[0], "profile save|restore [name] [place] | profile list [place]");
  if (!["save", "restore", "list"].includes(action)) throw new UsageError("profile save|restore [name] [place] | profile list [place]");
  // profile save [name] [place]: one argument is the name when no place answers to it
  let name = action === "list" ? undefined : args[1];
  let query = action === "list" ? args[1] : args[2];
  if (name !== undefined && query === undefined && (await resolvePlace(ctx, name).then(() => true, () => false))) {
    query = name;
    name = undefined;
  }
  const place = await resolvePlace(ctx, query);
  const result = await studio(ctx, place, "profile", { action, ...(name ? { name } : {}) }, 60_000);
  if (options.json) ctx.out(JSON.stringify(result, null, 2));
  else if (action === "list") ctx.out(result.profiles.length ? result.profiles.join("\n") : "No profile kept yet.");
  else ctx.out(`${action === "save" ? "Kept" : "Put back"} the profile ${result.name} (${result.bytes} bytes): ${result.file}`);
  return EXIT.ok;
}

async function findInstances(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  const place = await resolvePlace(ctx, query);
  const limit = positiveInt(options.limit, "limit");
  const result = await studio(ctx, place, "find", { name: options.name, className: options.class, under: options.under, ...(limit ? { limit } : {}) }, 30_000);
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  for (const f of result.found) ctx.out(`${f.path} [${f.className}]${f.file ? `  ${f.file}` : ""}`);
  const more = result.total > result.found.length ? `, the first ${result.found.length} shown (--limit for more)` : "";
  ctx.out(`${result.total} found among ${result.scanned} instances${more}${result.studioConnected ? "" : "; Studio is not connected, so this is the tree as last synced"} (${result.ms} ms).`);
  return EXIT.ok;
}

function secondsOption(value: string | undefined, name: string): number | undefined {
  if (value === undefined) return undefined;
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) throw new UsageError(`--${name} must be a number above 0`);
  return n;
}

async function waitFor(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  const code = options.code !== undefined || options.file !== undefined ? luauCode(ctx, options) : undefined;
  if (code === undefined && !options.pattern) throw new UsageError("give the Luau as --code=<luau> or --file <path>, a --pattern=<regex> for a play output line, or both");
  if (options.peer !== undefined && options.peer !== "server" && options.peer !== "client") throw new UsageError("--peer must be server or client");
  if (options.cursor !== undefined && !/^\d+$/.test(options.cursor)) throw new UsageError("--cursor must be the number a previous read printed");
  const place = await resolvePlace(ctx, query);
  const timeoutMs = Math.min(options.timeout ?? 30, 600) * 1000;
  const intervalMs = secondsOption(options.interval, "interval");
  const tryTimeout = secondsOption(options.tryTimeout, "try-timeout");
  const result = await studio(ctx, place, "waitFor", {
    code,
    pattern: options.pattern,
    peer: options.peer,
    cursor: options.cursor,
    timeoutMs,
    ...(intervalMs !== undefined ? { intervalMs } : {}),
    ...(tryTimeout !== undefined ? { tryTimeoutMs: tryTimeout * 1000 } : {}),
  }, timeoutMs);
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return result.met ? EXIT.ok : EXIT.timeout;
  }
  const where = PEER_NAME[result.peer] ?? "the play";
  const tries = `${result.tries} ${result.tries === 1 ? "try" : "tries"}`;
  if (result.met && result.by === "pattern") {
    ctx.out(`Matched after ${result.ms} ms (${tries}): [${result.line.source}] ${result.line.message}`);
  } else if (result.met) {
    for (const line of result.output ?? []) ctx.out(String(line));
    ctx.out(`Truthy after ${result.ms} ms, ${tries} in ${where}${result.values?.length ? `: => ${result.values.join(", ")}` : ""}`);
  } else {
    ctx.err(`Not met in ${(result.ms / 1000).toFixed(1)} s (${tries}${code !== undefined ? ` in ${where}` : ""}).`);
    if (result.last?.error) ctx.err(`Last try: ${result.last.error}`);
    else if (result.last) ctx.err(`Last try: => ${result.last.values?.length ? result.last.values.join(", ") : "(nothing returned)"}`);
  }
  ctx.out(`cursor: ${result.cursor}`);
  return result.met ? EXIT.ok : EXIT.timeout;
}

async function record(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  const span = secondsOption(options.seconds, "seconds") ?? 3;
  const fps = secondsOption(options.fps, "fps") ?? 5;
  const width = positiveInt(options.width, "width");
  if (options.out !== undefined && !/\.gif$/i.test(options.out)) throw new UsageError("--out must be a .gif file");
  const place = await resolvePlace(ctx, query);
  // The frames are read after the capture: ~0.1 s each in PA, more in a big place
  const timeoutMs = span * 1000 + 180_000;
  const result = await studio(ctx, place, "record", { seconds: span, fps, ...(width ? { width } : {}), timeoutMs }, timeoutMs);
  if (options.out) {
    const target = path.resolve(ctx.cwd, options.out);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.copyFileSync(result.file, target);
    result.file = target;
  }
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  ctx.out(recordSummary(result));
  ctx.out(result.file);
  ctx.out(result.sheet);
  return EXIT.ok;
}

/** One line on a recording: what was captured, how fast, how big */
export function recordSummary(result: any): string {
  const source = result.peer === "client" ? "the play client" : "Studio in edit mode";
  const skipped = result.skipped ? `, ${result.skipped} unreadable` : "";
  return `Recorded ${result.frames} frames of ${source} in ${result.seconds} s: ${result.fps} fps real (asked ${result.targetFps}${skipped}; ${result.peer === "client" ? "the game" : "Studio"} drew ${result.gameFps} fps meanwhile), ${result.width}x${result.height} GIF, ${(result.bytes / 1024).toFixed(0)} KB, ${result.ms} ms in all.`;
}

// ---------------------------------------------------------------------------------------
// Roblox: the engine reference and the Creator Store (no hub), and the Studio tools on assets,
// memory, the script profiler and scene analysis

/** The Roblox web tools' world: %APPDATA%\quack (next to the registry) unless a test says otherwise */
function rbx(ctx: ControlContext): RobloxEnv {
  return robloxEnv(ctx.roblox?.dataDir ?? path.dirname(ctx.info.registry), ctx.roblox);
}

async function docs(ctx: ControlContext, options: Options, args: string[]): Promise<number> {
  const name = need(args[0], "docs <Name> [--type classes|enums|datatypes|libraries|globals] [--section <name>]");
  const answer = await robloxDocs(rbx(ctx), { name, type: options.type, section: options.section });
  ctx.out(options.json ? JSON.stringify(answer, null, 2) : docsText(answer));
  return answer.suggestions ? EXIT.error : EXIT.ok;
}

const ASSET_USAGE = "asset search|details|thumbnail|preview|insert|upload ... (see --help)";

async function asset(ctx: ControlContext, options: Options, args: string[]): Promise<number> {
  const action = need(args[0], ASSET_USAGE);
  const print = (value: unknown, text: () => string) => ctx.out(options.json ? JSON.stringify(value, null, 2) : text());
  switch (action) {
    case "search": {
      const limit = positiveInt(options.limit, "limit");
      const result = await searchAssets(rbx(ctx), { type: options.type, query: args.slice(1).join(" "), limit, sort: options.sort, robloxOnly: options.roblox });
      print(result, () => searchText(result));
      return EXIT.ok;
    }
    case "details": {
      const result = await assetDetails(rbx(ctx), need(args[1], "asset details <id>"));
      print(result, () => detailsText(result));
      return EXIT.ok;
    }
    case "thumbnail": {
      const result: Record<string, unknown> = await assetThumbnail(rbx(ctx), { id: need(args[1], "asset thumbnail <id> [--size 150x150|420x420|768x432] [--out <file.png>]"), size: options.size });
      if (options.out) {
        if (!/\.png$/i.test(options.out)) throw new UsageError("--out must be a .png file");
        const target = path.resolve(ctx.cwd, options.out);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.copyFileSync(String(result.file), target);
        result.file = target;
      }
      print(result, () => `Thumbnail of asset ${result.assetId} (${result.size}), ${Math.round(Number(result.bytes) / 1024)} KB PNG:\n${result.file}`);
      return EXIT.ok;
    }
    case "preview": {
      const id = need(args[1], "asset preview <id> [place] [--depth <n>]");
      const place = await resolvePlace(ctx, args[2]);
      const result = await studio(ctx, place, "assetPreview", { assetId: Number(id), depth: wholeOption(options.depth, "depth") }, 60_000);
      print(result, () => previewText(result));
      return EXIT.ok;
    }
    case "insert": {
      const id = need(args[1], "asset insert <id> [place] [--parent <path>] [--at=<x>,<y>,<z>]");
      let position: number[] | undefined;
      if (options.at !== undefined) {
        position = options.at.split(",").map((v) => Number(v.trim()));
        if (position.length !== 3 || !position.every(Number.isFinite)) throw new UsageError("--at is <x>,<y>,<z> in studs, as --at=0,5,-10");
      }
      const place = await resolvePlace(ctx, args[2]);
      const result = await studio(ctx, place, "assetInsert", { assetId: Number(id), parent: options.parent, ...(position ? { position } : {}) }, 60_000);
      print(result, () => insertText(result));
      return EXIT.ok;
    }
    case "upload":
      return uploadCommand(ctx, options, args);
  }
  throw new UsageError(`usage: ${ASSET_USAGE}`);
}

async function uploadCommand(ctx: ControlContext, options: Options, args: string[]): Promise<number> {
  const file = path.resolve(ctx.cwd, need(args[1], "asset upload <file> [place] --type Decal|Audio|Model|Animation|Video --name <display name> [--description <text>] [--user <id> | --group <id>] [--force]"));
  if (!options.type) throw new UsageError("--type is required: Decal, Audio, Model, Animation or Video");
  if (!options.name) throw new UsageError("--name is required: the asset's display name on Roblox");
  if (options.user !== undefined && options.group !== undefined) throw new UsageError("give --user or --group, not both");
  const env = rbx(ctx);
  const result: Record<string, any> = await uploadAsset(env, {
    file, assetType: options.type, displayName: options.name, description: options.description, userId: options.user, groupId: options.group, force: options.force,
  });
  // A Decal's own id is not the image's: scripts and ImageLabels need the image id inside it
  if (options.type === "Decal" && result.assetId && !result.imageId) {
    const found = await decalImageId(ctx, env, String(result.assetId), args[2]);
    if (found.imageId) {
      result.imageId = found.imageId;
      rememberImageId(env, result.key, found.imageId);
    } else result.imageIdHow = found.how;
  }
  delete result.key;
  if (options.json) {
    ctx.out(JSON.stringify(result, null, 2));
    return EXIT.ok;
  }
  const what = `${result.assetType} "${result.displayName}" for ${result.creator}`;
  if (result.reused === "done") ctx.out(`Already uploaded (the upload log knows this file as ${what}): asset ${result.assetId}. --force uploads it again.`);
  else ctx.out(`Uploaded ${path.basename(file)} as ${what}${result.reused === "resumed" ? " (an earlier upload of it finished processing)" : ""}: asset ${result.assetId} (operation ${result.operationId}).`);
  if (options.type === "Decal") {
    ctx.out(result.imageId
      ? `Image id ${result.imageId} (rbxassetid://${result.imageId}): what an ImageLabel or a Decal's Texture takes; ${result.assetId} is the Decal.`
      : `The image id is not known yet (${result.imageIdHow}). With the place open in Studio, run the same upload again (it is not posted twice), or read InsertService:LoadAsset(${result.assetId})'s Decal.Texture.`);
  }
  return EXIT.ok;
}

/** A decal's image id: the Creator Store says it for a public one, else the place's Studio loads the decal */
async function decalImageId(ctx: ControlContext, env: RobloxEnv, decalId: string, query: string | undefined): Promise<{ imageId?: string; how: string }> {
  try {
    const details = await assetDetails(env, decalId);
    if (details.imageId) return { imageId: String(details.imageId), how: "the Creator Store" };
  } catch {
    // a fresh decal is often not on the store yet: Studio next
  }
  try {
    const place = await resolvePlace(ctx, query);
    const result = await studio(ctx, place, "exec", { code: imageIdLua(decalId), prelude: false, timeoutMs: 30_000 }, 30_000);
    const value = result?.ok ? String(result.values?.[0] ?? "") : "";
    if (/^\d+$/.test(value)) return { imageId: value, how: `Studio (${placeLabel(place)})` };
    return { how: `Studio could not read it: ${result?.ok ? value.replace(/^error: /, "") : result?.error}` };
  } catch (error) {
    return { how: (error as Error).message.split("\n")[0] };
  }
}

/** preview's answer: what the asset holds, its scripts first */
export function previewText(r: any): string {
  const classes = (r.classes ?? []).slice(0, 12).map((c: any) => `${c.class} ${c.count}`).join(", ");
  const lines = [`Asset ${r.assetId}: ${r.total} instances (${classes}${(r.classes?.length ?? 0) > 12 ? ", ..." : ""}), ${r.ms} ms`];
  if (r.scripts?.length) {
    lines.push(`Scripts (${r.scripts.length}; insert_asset removes every one):`);
    for (const s of r.scripts) lines.push(`  ${s.path} [${s.className}]${s.lines !== undefined ? `, ${s.lines} lines` : ""}${s.enabled === false ? ", disabled" : ""}${s.uses?.length ? `, uses ${s.uses.join(", ")}` : ""}`);
  } else lines.push("No scripts.");
  if (r.packageLinks?.length) lines.push(`PackageLinks (${r.packageLinks.length}; removed on insert): ${r.packageLinks.join(", ")}`);
  if (r.sounds?.length) lines.push(`Sounds (${r.sounds.length}): ${r.sounds.slice(0, 10).map((s: any) => `${s.path} ${s.soundId}`).join(", ")}${r.sounds.length > 10 ? ", ..." : ""}`);
  lines.push("Tree:");
  for (const n of r.nodes ?? []) lines.push(`  ${"  ".repeat(n.d)}${n.n} [${n.c}]${n.more ? ` +${n.more} inside` : ""}`);
  if (r.truncated) lines.push(`  (stopped at ${r.nodes.length} objects)`);
  return lines.join("\n");
}

/** insert's answer: what came in, where, and what was taken out */
export function insertText(r: any): string {
  const inserted = (r.inserted ?? []).map((i: any) => `${i.path} (${i.className})`).join(", ");
  const moved = Array.isArray(r.moved) ? ` at ${r.moved.join(", ")}` : "";
  const removed = [r.removedScripts?.length ? `${r.removedScripts.length} script(s): ${r.removedScripts.join(", ")}` : "", r.removedPackageLinks?.length ? `${r.removedPackageLinks.length} PackageLink(s)` : ""].filter(Boolean).join("; ");
  return `Inserted ${inserted} under ${r.parent}${moved}, one undo step, selected (${r.ms} ms).\n${removed ? `Removed before the insert: ${removed}. Quack never inserts a Store asset's scripts: they would sync to disk and run in the game.` : "It held no script."}`;
}

async function memory(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  if (options.peer !== undefined && !["edit", "server", "client"].includes(options.peer)) throw new UsageError("--peer must be edit, server or client");
  const place = await resolvePlace(ctx, query);
  const tags = options.tags === undefined ? undefined : options.tags.split(",").map((t) => t.trim()).filter(Boolean);
  const result = await studio(ctx, place, "memory", { peer: options.peer, ...(tags?.length ? { tags } : {}) }, 20_000);
  if (options.json) ctx.out(JSON.stringify(result, null, 2));
  else ctx.out(memoryText(result));
  return EXIT.ok;
}

export function memoryText(result: any): string {
  const lines: string[] = [];
  for (const peer of ["edit", "server", "client"]) {
    const p = result[peer];
    if (!p) continue;
    if (p.error) {
      lines.push(`${peer}: ${p.error}`);
      continue;
    }
    const tracking = p.trackingEnabled === false ? " (memory tracking is off: tags may read 0)" : "";
    lines.push(`${peer}: ${p.totalMb} MB in all${tracking}; ${(p.tags ?? []).slice(0, 12).map((t: any) => `${t.tag} ${t.mb}`).join(", ") || "no tag above 0"}`);
  }
  if (result.note) lines.push(`(${result.note})`);
  return lines.join("\n");
}

async function profiler(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  if (options.peer !== undefined && options.peer !== "server" && options.peer !== "client") throw new UsageError("--peer must be server or client");
  if (options.out !== undefined && !/\.json$/i.test(options.out)) throw new UsageError("--out must be a .json file");
  const durationMs = positiveInt(options.ms, "ms") ?? 1000;
  const place = await resolvePlace(ctx, query);
  const result = await studio(ctx, place, "profiler", {
    peer: options.peer, durationMs, frequency: positiveInt(options.frequency, "frequency"), maxFunctions: positiveInt(options.limit, "limit"),
    filter: options.filter, includeNative: options.native, includePlugin: options.plugin, ...(options.out ? { out: path.resolve(ctx.cwd, options.out) } : {}),
    timeoutMs: durationMs + 30_000,
  }, durationMs + 30_000);
  if (options.json) ctx.out(JSON.stringify(result, null, 2));
  else ctx.out(profilerText(result));
  return EXIT.ok;
}

export function profilerText(r: any): string {
  const omitted = Object.entries(r.omitted ?? {}).filter(([, n]) => Number(n) > 0).map(([k, n]) => `${n} ${k === "quack" ? "Quack's own" : k}`).join(", ");
  const lines = [`${PEER_NAME[r.peer] ?? r.peer}${r.player ? ` (${r.player})` : ""}: ${r.durationMs} ms at ${r.frequency} samples a second; ${r.counted} functions, ${r.kept} kept${omitted ? ` (left out: ${omitted})` : ""}`];
  for (const f of r.functions ?? []) {
    const where = f.source ? `  ${f.source}${f.line ? `:${f.line}` : ""}` : "";
    lines.push(`${String(f.rank).padStart(3)}. ${String(f.pct).padStart(6)}%  ${(f.totalUs / 1000).toFixed(2).padStart(9)} ms  ${f.name}${f.native ? " (native)" : ""}${where}`);
  }
  if (!r.functions?.length) lines.push("  (no function sampled: the game ran almost no Luau, or the filter left none)");
  if (r.file) lines.push(`Raw profile: ${r.file}`);
  return lines.join("\n");
}

async function scene(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  if (options.peer !== undefined && !["edit", "server", "client"].includes(options.peer)) throw new UsageError("--peer must be edit, server or client");
  const place = await resolvePlace(ctx, query);
  const all = options.mode === undefined || options.mode === "all";
  const timeoutMs = (options.timeout ?? (all ? 300 : 120)) * 1000;
  const result = await studio(ctx, place, "scene", { mode: options.mode, peer: options.peer, topN: positiveInt(options.limit, "limit"), timeoutMs }, timeoutMs);
  const failed = Object.values(result.modes ?? {}).some((m: any) => m?.error);
  if (options.json) ctx.out(JSON.stringify(result, null, 2));
  else ctx.out(sceneText(result));
  return failed && Object.values(result.modes ?? {}).every((m: any) => m?.error) ? EXIT.error : EXIT.ok;
}

export function sceneText(r: any): string {
  const lines = [`Scene analysis of ${PEER_NAME[r.peer] ?? r.peer} (${r.ms} ms):`];
  const size = (s: any) => (typeof s === "number" ? `${Math.round(s * 100) / 100}` : s === undefined || s === null ? "" : JSON.stringify(s));
  for (const mode of r.order ?? Object.keys(r.modes ?? {})) {
    const m = r.modes?.[mode];
    if (!m) continue;
    if (m.error) {
      lines.push(`${mode}: ${m.error}`);
      continue;
    }
    lines.push(`${mode}: ${m.root?.leaves ?? 0} entries${m.root?.size !== undefined ? `, ${size(m.root.size)} in all` : ""}${m.root?.sizes ? ` ${size(m.root.sizes)}` : ""} (${m.ms} ms)`);
    for (const e of m.top ?? []) lines.push(`  ${e.name ?? "?"}  ${mode === "triangle_composition" && e.sizes ? size(e.sizes) : size(e.size)}${e.assetId ? `  asset ${e.assetId}` : ""}`);
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------------------
// The Studio queue

const minutes = (ms: number | null | undefined) => (ms == null ? "-" : ms < 60_000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 6000) / 10} min`);
const clientLabel = (c: any) => (c?.name ? `${c.name} (${c.id})` : (c?.id ?? "?"));

export function queueText(q: any): string {
  const lines: string[] = [`${q.name ?? q.placeId}: ${q.phase}`];
  if (q.holder) {
    const asked = q.holder.requestedMin ? `, asked ${q.holder.requestedMin} min` : "";
    lines.push(`  Studio: held by ${q.holder.runner ? "the queue" : clientLabel(q.holder.client)} for ${minutes(q.holder.heldMs)}${asked}, last call ${minutes(q.holder.idleMs)} ago (${q.holder.tool})`);
  } else lines.push("  Studio: free");
  if (q.cap?.active) lines.push(`  capped: ${q.cap.clientId} gets Studio again after the queue's next batch`);
  if (q.waiters?.length) {
    lines.push(`  waiting for Studio (${q.waiters.length}), next first:`);
    q.waiters.forEach((w: any, i: number) =>
      lines.push(
        `    ${i + 1}. ${w.rush ? "RUSH " : ""}${w.effectiveLevel}${w.effectiveLevel !== w.level ? ` (was ${w.level})` : ""}, ~${w.holdMin} min, waiting ${minutes(w.waitedMs)}${w.exclusive ? ", live" : ""}: ${clientLabel(w.client)}${w.task ? `: ${w.task}` : ""}`,
      ),
    );
  }
  if (q.running) lines.push(`  running: ${q.running.name} (${clientLabel(q.running.client)}), ${minutes(q.running.ms)}`);
  const queued = (q.jobs ?? []).filter((j: any) => j.state === "pending");
  if (queued.length) {
    lines.push(`  jobs queued (${queued.length}):`);
    for (const j of queued) lines.push(`    ${j.name} (${clientLabel(j.client)}), ${minutes(j.waitedMs)}${j.infra ? `, infra try ${j.infra.tries}, again in ${minutes(j.infra.retryInMs)}` : ""}${j.alone ? ", again alone" : ""}`);
  }
  if (q.play) lines.push(`  play: ${q.play.roots.join(", ")}, ${q.play.jobs} job(s), up ${minutes(Date.now() - q.play.since)}${q.play.held ? `, held for ${q.play.held.client} (${minutes(q.play.held.leftMs)} left)` : ""}`);
  const t = q.today;
  if (t) {
    const fails = Object.entries(t.failures ?? {})
      .map(([k, n]) => `${k} ${n}`)
      .join(", ");
    lines.push(
      `  today: ${t.jobs} job(s), ${t.passed} passed, ${t.plays} play(s) (${t.sharedPlays} shared), ${t.jobsPerPlay ?? "-"} jobs per play, queue p50 ${minutes(t.queueP50Ms)} p90 ${minutes(t.queueP90Ms)}${fails ? `, failed: ${fails}` : ""}, ${t.grants} hold(s) by clients${t.grantsCapped ? ` (${t.grantsCapped} capped)` : ""}`,
    );
  }
  return lines.join("\n");
}

/** A verdict as the CLI prints it */
export function verdictText(r: any): string {
  const lines = [`${r.pass ? "PASS" : r.infra ? "INFRA" : r.dropped ? "DROPPED" : "FAIL"}  ${r.name}${r.play ? `  (${r.play})` : ""}`];
  if (r.dropped) lines.push(`  ${r.dropped}`);
  if (r.reason) lines.push(`  reason: ${r.reason}`);
  if (r.infra) lines.push("  not a verdict on the job: Studio, the daemon or the play failed (retried first). Submit again once the reason is gone.");
  if (r.infraRetried) lines.push(`  ran after infra failures: ${r.infraRetried}`);
  if (r.held) lines.push(`  the play is held ${r.held} s for this client: fix the job and submit it again now to run in the same play`);
  if (r.sharedWith) lines.push(`  ran in a play shared with ${r.sharedWith.join(", ")} and was not run again alone (no error outside this job's files; sharedRetry: foreign)`);
  if (r.firstRun) {
    lines.push(`  first run FAILED in a play shared with ${r.firstRun.with.join(", ")}: ${r.firstRun.reason || "see the phases"}`);
    lines.push(`  this verdict is the run in a play of this branch alone${r.pass ? ": the shared failure came from the other branch(es)" : ""}`);
  }
  if (r.notYours) lines.push(`  NOT YOURS: ${r.notYours}`);
  for (const [phase, p] of Object.entries<any>(r.phases ?? {})) {
    const checks = p.checks ?? [];
    const bad = checks.filter((c: any) => !c.ok);
    lines.push(`  ${phase}: ${p.ok === false ? "ERROR" : "ok"}${checks.length ? `, ${checks.length - bad.length}/${checks.length} checks` : ""}${p.value != null ? `, returned ${p.value}` : ""}`);
    if (p.error) lines.push(`    ${String(p.error).split("\n").slice(0, 6).join("\n    ")}`);
    for (const c of bad) lines.push(`    FAILED ${c.label}${c.expected !== undefined ? `: expected ${c.expected}, got ${c.actual}` : c.detail ? `: ${c.detail}` : ""}`);
  }
  for (const q of r.quackPlay ?? []) lines.push(`  quack play: ${q}`);
  for (const w of r.syncWarnings ?? []) lines.push(`  warning: ${w}`);
  if (r.console?.length) {
    lines.push(`  console (${r.console.length} lines during this job):`);
    for (const l of r.console.slice(0, 40)) lines.push(`    ${l}`);
    if (r.console.length > 40) lines.push(`    ... ${r.console.length - 40} more in the result file`);
  }
  lines.push(`  ${r.ms ?? 0} ms running, ${Math.round((r.queuedMs ?? 0) / 1000)} s in the queue`);
  return lines.join("\n");
}

async function queue(ctx: ControlContext, options: Options, args: string[]): Promise<number> {
  const [sub, ...rest] = args;
  const showStatus = async (query: string | undefined) => {
    const place = await resolvePlace(ctx, query);
    const status = await ctx.client.get("/api/queue", { placeId: place.placeId });
    ctx.out(options.json ? JSON.stringify(status, null, 2) : queueText(status));
    return EXIT.ok;
  };
  if (sub === "status") return showStatus(rest[0]);
  if (sub === "settings") {
    const answer = await ctx.client.get("/api/queue/settings");
    ctx.out(
      options.json
        ? JSON.stringify(answer, null, 2)
        : `${Object.entries(answer.settings)
            .map(([k, v]) => `${k}: ${JSON.stringify(v)}`)
            .join("\n")}\n(${answer.file})`,
    );
    return EXIT.ok;
  }
  if (sub === "release") {
    const place = await resolvePlace(ctx, rest[0]);
    if (ctx.info.flavor === "official") await confirmOfficial(ctx, options, `queue release ${placeLabel(place)}`);
    const answer = await ctx.client.post("/api/queue/force-release", { placeId: place.placeId });
    ctx.out(
      options.json
        ? JSON.stringify(answer, null, 2)
        : answer.released
          ? `Studio lock of ${placeLabel(place)} freed (was ${clientLabel(answer.was.client)}).`
          : `Studio lock of ${placeLabel(place)} was already free.`,
    );
    return EXIT.ok;
  }
  if (sub !== "submit") return showStatus(sub);
  const file = need(rest[0], "queue submit <job.luau> [place] [-w <folder>]");
  let source: string;
  try {
    source = fs.readFileSync(path.resolve(ctx.cwd, file), "utf8");
  } catch (error) {
    throw new UsageError(`cannot read ${file}: ${(error as Error).message}`);
  }
  const root = path.resolve(ctx.cwd, options.worktrees[0] ?? ".");
  let place: Place;
  if (rest[1]) place = await resolvePlace(ctx, rest[1]);
  else {
    const state = await ctx.client.get("/api/state");
    const inside = (state.places as Place[]).find((p) => sameOrInside(p.folder, root));
    place = inside ?? (await placeOfWorktree(ctx, root));
  }
  // A job runs the folder it names: the place's own, or a worktree's top folder (its branch)
  const folder = sameOrInside(place.folder, root) ? place.folder : worktreeTop(root);
  // No pid: the job is not this process's, so it stays queued when the command gives up waiting
  const client = { id: `cli-${process.pid}`, name: "quack queue submit" };
  const job = { root: folder, source, ...(options.fresh ? { fresh: true } : {}), ...(options.name ? { name: options.name } : {}) };
  const { id } = await ctx.client.post("/api/queue/submit", { placeId: place.placeId, client, job });
  if (!options.json) ctx.out(`Submitted to ${placeLabel(place)}${folder !== place.folder ? ` (the branch of ${folder})` : ""}. Waiting for the verdict...`);
  const deadline = Date.now() + (options.timeout ?? 20) * 60_000;
  for (;;) {
    const answer = await ctx.client.get("/api/queue/job", { placeId: place.placeId, id });
    if (answer.state === "done") {
      const verdict = answer.verdict;
      ctx.out(options.json ? JSON.stringify(verdict, null, 2) : verdictText(verdict));
      return verdict.pass ? EXIT.ok : verdict.infra ? EXIT.timeout : EXIT.error;
    }
    if (Date.now() > deadline) {
      ctx.err(`No verdict yet; the job stays queued (${id}).`);
      return EXIT.timeout;
    }
    await new Promise((r) => setTimeout(r, ctx.pollMs ?? 500));
  }
}

/** The top folder of the git checkout holding `dir` */
function worktreeTop(dir: string): string {
  let at = path.resolve(dir);
  for (;;) {
    if (fs.existsSync(path.join(at, ".git"))) return at;
    const up = path.dirname(at);
    if (up === at) return path.resolve(dir);
    at = up;
  }
}
