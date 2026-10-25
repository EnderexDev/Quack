import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { HubClient, HubError, HubOffline, type FlavorInfo } from "./hubClient.js";
import { PLAY_TAB_HINT } from "../play/overlay.js";

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
  idle?: number;
  timeout?: number;
  name?: string;
  disk: boolean;
  keep: boolean;
  refresh: boolean;
  wait: boolean;
  /** restart-hub: replace the daemons too (each hands its tree to its successor) */
  daemons: boolean;
  /** play: the worktree to play (default: the folder you are in) */
  worktree?: string;
  help: boolean;
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
      idle: { type: "string" },
      timeout: { type: "string" },
      name: { type: "string" },
      disk: { type: "boolean" },
      keep: { type: "boolean" },
      refresh: { type: "boolean" },
      wait: { type: "boolean" },
      daemons: { type: "boolean" },
      worktree: { type: "string", short: "w" },
      help: { type: "boolean", short: "h" },
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
      idle: number("idle"),
      timeout: number("timeout"),
      name: values.name,
      disk: values.disk === true,
      keep: values.keep === true,
      refresh: values.refresh === true,
      wait: values.wait === true,
      daemons: values.daemons === true,
      worktree: values.worktree,
      help: values.help === true,
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
      --idle <ms>             quiet this long (default 1500), counted from the call too
      --timeout <s>           give up after this long (default 120), exit ${EXIT.timeout}

Play
  play [place] [-w <folder>]  A playtest with the scripts a git worktree's branch changed since
                            it forked (default: the worktree you are in); every other script
                            runs as Studio has it. The place in edit mode keeps its own; Studio
                            holds the branch's only while it copies the place (~1 to 2 s)

Change${info.flavor === "official" ? " (each asks first; --yes to skip, required without a terminal)" : ""}
  pause | resume            Stop every daemon and turn Studios away / allow them again
  register <placeId> [folder] [--name <name>]   Link a folder (default: here) to a place
  unregister <place>
  resolve <id> --disk|--keep [place]   Put the saved disk version back, or keep what is there
  choose <id> continue|cancel          Answer a waiting connection
  ai [on|off|claude|codex]  The AI merge (no argument: show it; --refresh checks the CLIs again)
  open <place> [--wait]     Open the place in Studio; --wait until it connects
  restart-hub [--daemons]   Restart the hub (Studios stay connected); --daemons restarts the daemons too

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
  try {
    const mutates = MUTATING.has(command) || (command === "ai" && args.length > 0);
    if (mutates && ctx.info.flavor === "official") await confirmOfficial(ctx, options, `${command} ${args.join(" ")}`.trim());
    return await dispatch(command, args, options, ctx);
  } catch (error) {
    if (error instanceof Done) return error.code;
    if (options.json) ctx.out(JSON.stringify({ error: (error as Error).message }));
    else ctx.err((error as Error).message);
    if (error instanceof HubOffline) {
      if (!options.json) ctx.err(`Is ${ctx.info.appName} running?`);
      return EXIT.offline;
    }
    if (error instanceof Timeout) return EXIT.timeout;
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
  }
  throw new UsageError(`unknown command ${command}. Run ${ctx.info.command} --help.`);
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
  let said = false;
  for (;;) {
    const { sessions } = await ctx.client.get("/api/sessions");
    const session = sessions.find((s: any) => s.placeId === place.placeId);
    const now = Date.now();
    if (session?.studioConnected) {
      const quietSince = Math.max(started, session.lastActivity ?? 0, session.studioSince ?? 0);
      // A hub from before syncedAt sends none (undefined): there only the quiet counts
      const synced = session.syncedAt === undefined || (session.syncedAt !== null && session.syncedAt >= (session.studioSince ?? 0));
      if (options.connected || (synced && now - quietSince >= idle)) {
        const result = { ok: true, placeId: place.placeId, instances: session.instances, scripts: session.scripts, waitedMs: now - started };
        ctx.out(options.json ? JSON.stringify(result) : options.connected ? `${placeLabel(place)} is connected.` : `${placeLabel(place)} is connected and in sync.`);
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

async function play(ctx: ControlContext, options: Options, query: string | undefined): Promise<number> {
  const worktree = path.resolve(ctx.cwd, options.worktree ?? ".");
  const place = query ? await resolvePlace(ctx, query) : await placeOfWorktree(ctx, worktree);
  const { play: started } = await ctx.client.post("/api/play", { placeId: place.placeId, worktree }, 70_000);
  if (!started?.result?.ok) {
    const why = started?.result?.error ?? "the swap did not finish";
    if (options.json) ctx.out(JSON.stringify({ play: started }, null, 2));
    else {
      ctx.err(`Play of ${worktree} in ${placeLabel(place)} failed: ${why}`);
      // Which scripts, as Studio said it (before 25/10/26 only "could not be swapped in" came out)
      for (const line of started?.result?.failed ?? []) ctx.err(`  ${line}`);
      for (const line of started?.conflicts ?? []) ctx.err(`  conflict: ${line}`);
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
  if (options.json) {
    ctx.out(JSON.stringify({ play: state }, null, 2));
  } else {
    ctx.out(`Playing ${state.worktree} in ${placeLabel(place)}: ${state.patches} changed, ${state.creates} new, ${state.disables} turned off.`);
    if (state.checks === 0) ctx.out("The branch brings no script change since it forked from the place's folder: this play runs the place as Studio has it.");
    ctx.out(`The place in edit mode held the branch for ${Math.round(state.result.windowMs ?? 0)} ms, and has its own scripts again.`);
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
  return state.verify.ok ? EXIT.ok : EXIT.error;
}
