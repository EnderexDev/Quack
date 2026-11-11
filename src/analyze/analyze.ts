import fs from "node:fs";
import path from "node:path";
import type { Binding, Block, Chunk, Expr, FunctionExpr, Stat } from "./luau/ast.js";
import { LuauSyntaxError } from "./luau/lexer.js";
import { TESTEZ_GLOBALS } from "./luau/globals.js";
import { lintChunk, type LintFinding } from "./luau/lint.js";
import { parseLuau } from "./luau/parser.js";
import { resolveScopes, valueOf, type Decl, type NameExpr, type Scopes } from "./luau/scope.js";
import { ROBLOX_CLASSES, ROBLOX_MEMBERS } from "./robloxMembers.js";
import { childNamed, fileKey, loadTree, type GameTree, type TreeNode } from "./tree.js";

/**
 * Quack's own static check of a place's Luau, from what Quack knows that a linter does not: the
 * instance tree of the place (the sourcemap) and which module each `require` reaches. It never
 * runs the game. Every rule stays quiet when it cannot be sure: a module it cannot read whole is
 * skipped, never guessed at, because the number of false alarms over a whole game is what
 * decides whether a check stays on (10/11/26: 0 over Anime Astral's 1,639 scripts).
 *
 * Every file is parsed once (luau/parser.ts) and its names resolved by scope (luau/scope.ts), so
 * a module or an instance is bound to one declaration: a parameter or an inner local with the
 * same name is another thing, and a local assigned again is no longer known.
 *
 *   missing-member  `X.k` / `X:k()` / `X["k"]` where X is a module the file requires and k is
 *                   not one of its keys (a function renamed or removed while a caller still uses it)
 *   missing-child   `.Name` or `:WaitForChild("Name")` on an instance of the tree that has no
 *                   such child (an infinite yield, or an index error)
 *   the linter's    Quack's own Luau parser and linter (luau/lint.ts, luau/patterns.ts): parse-error,
 *                   undefined-variable and the other checks selene reported as errors, which it
 *                   replaced (his call, 10/11/26). `-- quack: allow(rule)` (or selene's own
 *                   `-- selene: allow(rule)`) on the line or the one above silences a finding.
 */

export interface Finding {
  file: string;
  line: number;
  column: number;
  rule: string;
  message: string;
}

export interface AnalyzeOptions {
  /** Report only these files (the whole place is still read: a module's keys can be written from another file) */
  files?: string[];
  syncDir?: string;
  sourcemap?: string;
}

export interface AnalyzeReport {
  root: string;
  findings: Finding[];
  stats: {
    scripts: number;
    tree: "sourcemap" | "sync folder";
    /** The sourcemap read: the project's, or a worktree's synced checkout's */
    sourcemap: string | null;
    modulesRead: number;
    /** Modules whose keys text cannot tell (wrapped, metatables, filled by a loop): never checked */
    modulesOpaque: number;
    memberUses: number;
    instancePaths: number;
    /** Calls of a loader method (`Loader.get("Name")`) whose name was checked */
    loaderCalls: number;
    /** Remotes and bindables of the tree fired or listened to by a literal path, and no other way */
    remotes: number;
    /** Channels named by a string (`Net.get("Hit")`) whose sends and receives were matched */
    channels: number;
    /** Player data templates read (a profile library's store), whose keys the data reads are checked against */
    dataTemplates: number;
    ms: number;
    /** Keys read from a running play for modules the text cannot tell (slice 2), or why none were */
    live?: { place?: string; modules: number; note: string };
  };
  opaque: { file: string; why: string }[];
}

/** A module whose keys the text cannot tell and a running play can: one the play's server requires anyway */
export interface LiveCandidate {
  file: string;
  /** Its instance path, the service first (`["ReplicatedStorage", "Library", "Config", "X"]`) */
  path: string[];
  why: string;
  /** Server Scripts whose top-level requires reach it (at most 5): the play checks one runs before requiring */
  roots: string[][];
}

/** Keys read in a running play, by module file (fileKey) */
export interface LiveKeys {
  place: string;
  keys: Map<string, string[]>;
}

export interface Project {
  /** The modules the wanted files use whose text does not say their keys, that the play's server requires anyway */
  liveCandidates(): LiveCandidate[];
  /** The checks; `live` fills the keys of modules the text could not read (never of one it could) */
  report(live?: LiveKeys): AnalyzeReport;
}

/** Containers whose children are copied somewhere else at run time (PlayerGui, PlayerScripts, the character, the backpack) */
const STARTERS = new Set(["StarterGui", "StarterPack", "StarterPlayer", "StarterPlayerScripts", "StarterCharacterScripts"]);
/** Services a path can start from with game:GetService; the rest (Players...) are filled at run time */
const SERVICES = new Set(["ReplicatedStorage", "ReplicatedFirst", "ServerScriptService", "ServerStorage", "Lighting", "SoundService", "StarterGui", "StarterPlayer", "StarterPack", "Workspace"]);
/** Third-party code copied into the game (Wally's _Index, a Packages folder) */
const VENDORED = /[\\/](?:Packages|_Index)[\\/]/;
/** Wally's install folder */
const WALLY_INSTALLED = /[\\/]_Index[\\/]/;
/** A TestEZ test file: its runner defines describe, it, expect */
const TEST_FILE = /\.spec\.luau?$/i;
/** `.Event:Connect`: after a member that is not a child, these mean an event */
const EVENT_METHODS = new Set(["Connect", "ConnectParallel", "Once", "Wait"]);
/** Calls whose first argument names a child to find, not one to make */
const LOOKUPS = new Set(["WaitForChild", "FindFirstChild", "FindFirstAncestor", "FindFirstAncestorOfClass"]);
/** Calls that read a table without adding keys to it */
const NOT_A_FILL = new Set(["setmetatable", "table.freeze", "table.clone", "typeof", "type", "pairs", "ipairs", "next", "print", "warn", "tostring", "rawget", "rawequal", "assert"]);

// ---------------------------------------------------------------------------------------------
// One file: its tree, its scopes, and the facts the rules read from them

/** One step after a chain's first name: `.k`, `[k]`, `(args)` or `:m(args)` */
type Op =
  | { kind: "member"; name: Binding }
  | { kind: "index"; key: Expr }
  | { kind: "call"; method?: Binding; args: Expr[] };

/** `a.b:c(d)[e]`: a name and the steps after it, read from the outside in */
interface Chain {
  base: NameExpr;
  ops: Op[];
  /** read; the target of an assignment; the name of a `function a.b()` */
  role: "read" | "target" | "function";
  /** The function the chain is in (the chunk at the top) */
  scope: Range;
  /** A target's value (`X.OnServerInvoke = fn`) */
  value?: Expr;
  /** The chain is a local's value (`local hit = Remotes.Hit`): its uses go through the local */
  init?: boolean;
  /** The whole expression */
  expr: Expr;
}

interface Range {
  start: number;
  end: number;
}

/** `X.k` tested before use: `if X.k`, `type(X.k)`, `X.k ~= nil`, `X.k and`, `not X.k` */
interface Guard {
  object: NameExpr;
  key: string;
  at: number;
  scope: Range;
}

/** `X.k = v`, `X["k"] = v`, `function X.k()`, `X.k += 1`; key null: a computed key (`X[k] = v`) */
interface Write {
  object: NameExpr;
  key: string | null;
  /** Inside a function: it runs later, maybe on demand, not when the module loads */
  lazy: boolean;
  /** `X.k = nil`: removes k */
  removes?: boolean;
}

/** A name handed to a call (`Extend(Config)`): the call's dotted name, when it has one */
interface Pass {
  callee: string | null;
  index: number;
  arg: NameExpr;
  lazy: boolean;
}

interface Facts {
  chains: Chain[];
  guards: Guard[];
  writes: Write[];
  passes: Pass[];
  /** String literals other than a child looked up (`:WaitForChild("X")`, `folder["X"]`) */
  strings: string[];
  /** The file sets a `__metatable` key: getmetatable in the play would not give the real metatable */
  protects: boolean;
  /** Bare names tested in a condition (`if bridge then`, `not x`, `x and`) */
  tested: Set<NameExpr>;
}

interface ScriptFile {
  file: string;
  src: string;
  node?: TreeNode;
  lineStarts: number[];
  chunk?: Chunk;
  parseError?: LintFinding;
  scopes?: Scopes;
  facts?: Facts;
  /** What each declaration names, as far as it is known (filled by bind) */
  bound: Map<Decl, Bound | null>;
  /** `local X = Loader.method("Name")`, bound by qualifyLoaders */
  loaderCalls: LoaderCall[];
}

type Bound = { module: TreeNode; instance?: undefined } | { instance: TreeNode; module?: undefined };

interface LoaderCall {
  decl: Decl;
  loader: TreeNode;
  method: string;
  /** The one module called Name in the loader's children or theirs */
  found: TreeNode | null;
}

interface ModuleKeys {
  open: boolean;
  why?: string;
  keys: Set<string>;
  /** Open because something fills it from inside a function (a registry filled on demand): a play read at one moment may not have every key yet */
  lazy?: boolean;
}

export function analyzeProject(root: string, options: AnalyzeOptions = {}): AnalyzeReport {
  return loadProject(root, options).report();
}

/** Containers a play's server can require a module from */
const SERVER_REQUIRABLE = new Set(["ReplicatedStorage", "ReplicatedFirst", "ServerScriptService", "ServerStorage", "Workspace"]);

/** Reads and binds the whole place once; the checks run in report() */
export function loadProject(root: string, options: AnalyzeOptions = {}): Project {
  const t0 = Date.now();
  const syncDir = path.resolve(root, options.syncDir ?? "sync");
  const tree = loadTree(root, syncDir, path.resolve(root, options.sourcemap ?? "sourcemap.json"));
  const files = listScripts(syncDir);
  const scripts = files.map((file) => readScript(file, tree));
  const byFile = new Map(scripts.map((s) => [fileKey(s.file), s]));

  for (const s of scripts) bindAll(s, tree);
  const { isLoader, folderOf } = qualifyLoaders(scripts);

  // `Config.k = v` from another file adds k to Config; `Config[k] = v` makes its keys unknowable
  const writtenFrom = new Map<TreeNode, Set<string>>();
  const openedFrom = new Map<TreeNode, { why: string; lazy: boolean }>();
  for (const s of scripts) {
    for (const w of s.facts?.writes ?? []) {
      const mod = moduleOf(s, writer(s, w.object));
      if (!mod) continue;
      if (w.key === null) {
        const before = openedFrom.get(mod);
        openedFrom.set(mod, { why: before?.why ?? `written with a computed key in ${path.basename(s.file)}`, lazy: !!before?.lazy || w.lazy });
      }
      else {
        if (!writtenFrom.has(mod)) writtenFrom.set(mod, new Set());
        writtenFrom.get(mod)!.add(w.key);
      }
    }
  }
  const moduleKeys = new Map<TreeNode, ModuleKeys>();
  const keysOf = (node: TreeNode): ModuleKeys => {
    let k = moduleKeys.get(node);
    if (!k) {
      const s = node.file ? byFile.get(fileKey(node.file)) : undefined;
      const opened = openedFrom.get(node);
      k = !s ? { open: true, why: "no file", keys: new Set() } : opened ? { open: true, why: opened.why, keys: new Set(), lazy: opened.lazy || keysOfModule(s).lazy } : keysOfModule(s);
      moduleKeys.set(node, k);
    }
    return k;
  };
  const wanted = options.files?.length ? new Set(options.files.map((f) => fileKey(path.resolve(root, f)))) : null;
  const isWanted = (s: ScriptFile) => !wanted || wanted.has(fileKey(s.file));

  // The modules a play's server has started: a module counts only when its require is reached
  // in a file already running, at the top level (not in a function or a branch), before any
  // statement that may stop there: a call the analyzer cannot vouch for (`Library.init()`, `wait`,
  // `:Wait()`, a `WaitForChild` of a child the tree lacks), a `while` or `repeat` loop, or the
  // require of a module that itself may stop. Reading such a module's keys in the play runs nothing
  // new; one never started would run for the first time. The roots are Scripts in
  // ServerScriptService or the Workspace; whether one is enabled and runs on the server is checked
  // in the play (the sourcemap has no properties). A client controller in ReplicatedStorage is
  // never reached this way: required on the server it would run client code and stay errored
  const loads = (f: ScriptFile, e: CallExpr): TreeNode | null => {
    let target: Expr | undefined;
    if (!e.method && isGlobal(f, e.callee, "require") && e.args.length === 1) target = e.args[0];
    // pcall(require, X): a framework loading its services one by one
    else if (!e.method && isGlobal(f, e.callee, "pcall") && e.args.length === 2 && isGlobal(f, unwrap(e.args[0]), "require")) target = e.args[1];
    if (target) {
      const n = instanceOf(f, tree, target);
      return n && n.className === "ModuleScript" && n.file ? n : null;
    }
    const l = loaderOf(f, tree, e);
    return l?.found && isLoader(l.loader, l.method) ? l.found : null;
  };
  const completesMemo = new Map<TreeNode, boolean>();
  /** Every top-level statement of the module returns: requiring it ends */
  const completes = (mod: TreeNode): boolean => {
    if (completesMemo.has(mod)) return completesMemo.get(mod)!;
    completesMemo.set(mod, false);
    const m = byFile.get(fileKey(mod.file!));
    const out = !!m?.chunk && m.chunk.body.every((st) => !mayStop(m, st));
    completesMemo.set(mod, out);
    return out;
  };
  const harmless = (f: ScriptFile, e: CallExpr): boolean => {
    const mod = loads(f, e);
    if (mod) return completes(mod);
    if (e.method) {
      if (e.method.name === "WaitForChild") return e.args.length > 1 || instanceOf(f, tree, e) !== null;
      return SAFE_METHODS.has(e.method.name);
    }
    const name = dotted(e.callee);
    if (!name || (e.callee.kind === "Name" && f.scopes!.of(e.callee)) || (e.callee.kind === "Member" && rootName(e.callee) && f.scopes!.of(rootName(e.callee)!))) return false;
    return SAFE_CALLS.has(name) || SAFE_LIBRARIES.has(name.split(".")[0]) && !UNSAFE_CALLS.has(name);
  };
  const mayStop = (f: ScriptFile, st: Stat): boolean => st.kind === "While" || st.kind === "Repeat" || callsOf(st, true).some((c) => !harmless(f, c));
  const rootsOf = new Map<TreeNode, string[][]>();
  for (const s of scripts) {
    if (!s.node || !runsOnServer(s.node)) continue;
    const rootPath = instancePath(s.node)!;
    const seen = new Set<ScriptFile>();
    const run = (f: ScriptFile) => {
      if (seen.has(f) || !f.chunk) return;
      seen.add(f);
      for (const st of f.chunk.body) {
        // the calls of this statement in the order they run (an argument before its call)
        for (const c of callsOf(st, false).sort((x, y) => x.end - y.end)) {
          const mod = loads(f, c);
          if (mod) {
            const list = rootsOf.get(mod) ?? [];
            if (list.length < 5 && !list.some((r) => r.join("/") === rootPath.join("/"))) list.push(rootPath);
            rootsOf.set(mod, list);
            const m = byFile.get(fileKey(mod.file!));
            if (m) run(m);
          }
          if (!harmless(f, c)) return;
        }
        if (st.kind === "Return" || mayStop(f, st)) return;
      }
    };
    run(s);
  }
  // every module a file requires, anywhere in it (`__index = require(script.Parent.Base)` too)
  const requiresOf = (f: ScriptFile): TreeNode[] => {
    const out: TreeNode[] = [];
    for (const c of f.facts?.chains ?? []) {
      const op = c.ops[0];
      if (c.base.name === "require" && !f.scopes!.of(c.base) && op?.kind === "call" && op.args.length === 1) {
        const n = instanceOf(f, tree, op.args[0]);
        if (n?.className === "ModuleScript" && n.file) out.push(n);
      }
    }
    for (const b of f.bound.values()) if (b?.module) out.push(b.module);
    return out;
  };
  // a module, or one it requires, that sets __metatable: the play cannot read its real metatable
  const protectedMemo = new Map<TreeNode, boolean>();
  const isProtected = (mod: TreeNode): boolean => {
    if (protectedMemo.has(mod)) return protectedMemo.get(mod)!;
    protectedMemo.set(mod, false);
    const m = byFile.get(fileKey(mod.file!));
    const out = !m || m.facts?.protects !== false || requiresOf(m).some(isProtected);
    protectedMemo.set(mod, out);
    return out;
  };
  // filled on demand, or returning a module that is (`return require(script.Parent.Registry)`)
  const lazyMemo = new Map<TreeNode, boolean>();
  const isLazy = (mod: TreeNode): boolean => {
    if (lazyMemo.has(mod)) return lazyMemo.get(mod)!;
    lazyMemo.set(mod, false);
    const m = byFile.get(fileKey(mod.file!));
    let out = !!keysOf(mod).lazy;
    const last = m?.chunk?.body.at(-1);
    if (!out && m && last?.kind === "Return" && last.values.length === 1) {
      const v = unwrap(last.values[0]);
      const next = v.kind === "Call" ? loads(m, v) : v.kind === "Name" ? moduleOf(m, m.scopes!.of(v)) : undefined;
      if (next) out = isLazy(next);
    }
    lazyMemo.set(mod, out);
    return out;
  };

  // Modules safe to require even if the game never did: their top level, and every function it
  // calls that the analyzer can read, only builds and reads. A config table, a builder like
  // BuildAllAchievements(), an Extend that hangs methods on the table it is given. No write
  // outside the file's own locals, no global, no Connect, no task.spawn, no call it cannot read.
  // Requiring one in the play changes nothing the game holds, so it needs no proof the game
  // loaded it first (his call, 11/11/26: "segue da melhor forma")
  /** The functions a table holds, by name: `function T.f`, `T.f = function`, `{ f = function }` */
  const functionsOf = (f: ScriptFile, table: Decl): Map<string, FunctionExpr> => {
    const out = new Map<string, FunctionExpr>();
    const init = table.init && unwrap(table.init);
    if (init?.kind === "Table") for (const fld of init.fields) if (fld.kind === "Named" && fld.value.kind === "Function") out.set(fld.name.name, fld.value);
    for (const st of f.chunk?.body ?? []) {
      if (st.kind === "Function" && st.target.kind === "Member" && st.target.object.kind === "Name" && f.scopes!.of(st.target.object) === table) out.set(st.target.name.name, st.func);
      if (st.kind === "Assign") {
        st.targets.forEach((t, i) => {
          const v = st.values[i];
          if (t.kind === "Member" && t.object.kind === "Name" && f.scopes!.of(t.object) === table && v?.kind === "Function") out.set(t.name.name, v);
        });
      }
    }
    return out;
  };
  /** The function a call goes to, when the analyzer can read it: a local function, or one a table of this file or a required module holds */
  const calleeOf = (f: ScriptFile, call: CallExpr): { file: ScriptFile; func: FunctionExpr } | null => {
    if (!call.method && call.callee.kind === "Name") {
      const d = f.scopes!.of(call.callee);
      return d?.func && !d.assigned.length ? { file: f, func: d.func } : null;
    }
    const object = call.method ? call.callee : call.callee.kind === "Member" ? call.callee.object : null;
    const name = call.method?.name ?? (call.callee.kind === "Member" ? call.callee.name.name : null);
    if (!object || object.kind !== "Name" || !name) return null;
    const d = f.scopes!.of(object);
    if (!d) return null;
    const mod = moduleOf(f, d);
    if (mod) {
      const m = byFile.get(fileKey(mod.file!));
      const table = m && returnedDecl(m);
      const func = table && functionsOf(m, table).get(name);
      return func ? { file: m, func } : null;
    }
    const func = functionsOf(f, d).get(name);
    return func ? { file: f, func } : null;
  };
  /** The written table is one of this file's locals (a parameter, self, the module's own table), not a module's or a global */
  /**
   * A table this code may write without changing what the game holds: one it built itself, or a
   * parameter or self (the call that passed it was checked by ownArg). In a function, the file's
   * top-level tables are the module's state, shared with the game: only the module's own top
   * level, while it is being built, writes them
   */
  const ownLocal = (d: Decl | undefined, inFunction: boolean): boolean =>
    !!d && (d.kind === "param" || d.kind === "self" || (builtHere(d) && !(inFunction && d.top)));
  const ownTarget = (f: ScriptFile, e: Expr | undefined, inFunction: boolean): boolean => {
    let x = e && unwrap(e);
    while (x && (x.kind === "Member" || x.kind === "Index")) x = unwrap(x.object);
    return x?.kind === "Name" && ownLocal(f.scopes!.of(x), inFunction);
  };
  /** A local holding a table this file built: `{...}`, `setmetatable({...}, mt)`, `table.clone(x)`, `table.create(n)` (never an instance, nor another module's table) */
  const builtHere = (d: Decl): boolean => {
    if (d.kind !== "local") return false;
    const v = valueOf(d);
    const e = v && unwrap(v);
    if (!e) return false;
    if (e.kind === "Table") return true;
    if (e.kind !== "Call" || e.method) return false;
    const name = dotted(e.callee);
    if (name === "setmetatable") return !!e.args[0] && unwrap(e.args[0]).kind === "Table";
    return name === "table.clone" || name === "table.create";
  };
  /** What a call may hand to a function that may write its parameters: a table it may write itself, or a value that is not a table */
  const ownArg = (f: ScriptFile, e: Expr, inFunction: boolean): boolean => {
    const x = unwrap(e);
    switch (x.kind) {
      case "Nil":
      case "Boolean":
      case "Number":
      case "String":
      case "Interp":
      case "Function":
      case "Table":
      case "Vararg":
        return true;
      case "Name":
        return ownLocal(f.scopes!.of(x), inFunction);
      default:
        return false;
    }
  };
  const pureMemo = new Map<FunctionExpr | TreeNode, boolean>();
  const pureCall = (f: ScriptFile, call: CallExpr, depth: number, inFunction: boolean): boolean => {
    const mod = loads(f, call);
    // only a pure one: "loaded" rests on a root Script the play checks, and a pure module goes without one
    if (mod) return pureModule(mod);
    // pcall(fn, ...): the call fn(...)
    if (!call.method && isGlobal(f, call.callee, "pcall") && call.args.length >= 1) {
      return pureCall(f, { ...call, callee: call.args[0], args: call.args.slice(1) }, depth, inFunction);
    }
    // a WaitForChild that may never return leaves the require hanging and an "Infinite yield" in the play's output
    if (call.method?.name === "WaitForChild") return call.args.length > 1 || instanceOf(f, tree, call) !== null;
    if (call.method && PURE_METHODS.has(call.method.name)) return true;
    const root = call.method ? null : rootName(call.callee);
    if (root && !f.scopes!.of(root)) {
      const name = dotted(call.callee) ?? "";
      if (PURE_CALLS.has(name)) return true;
      const [lib, fn] = name.split(".");
      if (lib === "table" && TABLE_MUTATORS.has(fn)) return ownTarget(f, fn === "move" ? (call.args[4] ?? call.args[0]) : call.args[0], inFunction);
      if (PURE_LIBRARIES.has(lib) && fn && !IMPURE_CALLS.has(name)) return true;
    }
    const target = calleeOf(f, call);
    // the function may write what it is given (a method gets its object as self): only what the caller may write goes in
    if (!target || !call.args.every((a) => ownArg(f, a, inFunction))) return false;
    if (call.method && !ownArg(f, call.callee, inFunction)) return false;
    return pureFunction(target.file, target.func, depth + 1);
  };
  /** Statements that call only pure things and write only the file's own locals (not entering the functions they define) */
  /**
   * A generic for that ends: pairs(t), ipairs(t), `next, t`, a table built right there, an
   * instance's children, or a local holding a table this file built with no metatable. Anything
   * else may be a function called until it returns nil, or a table with __iter
   */
  const finiteIteration = (f: ScriptFile, exprs: Expr[]): boolean => {
    const first = exprs[0] && unwrap(exprs[0]);
    if (!first) return false;
    if (exprs.length >= 2) return isGlobal(f, first, "next");
    if (first.kind === "Table") return true;
    if (first.kind === "Call") {
      if (first.method) return first.method.name === "GetChildren" || first.method.name === "GetDescendants";
      return isGlobal(f, first.callee, "pairs") || isGlobal(f, first.callee, "ipairs");
    }
    if (first.kind !== "Name") return false;
    const d = f.scopes!.of(first);
    const v = d?.kind === "local" ? valueOf(d) : undefined;
    const e = v && unwrap(v);
    if (e?.kind === "Table") return true;
    return e?.kind === "Call" && !e.method && ["table.clone", "table.create"].includes(dotted(e.callee) ?? "");
  };
  const pureStats = (f: ScriptFile, body: Stat[], depth: number, inFunction: boolean): boolean =>
    body.every((st) => {
      // a while or repeat may not end: a pure module must also return, or it freezes the play's server
      if (hasOpenLoop(st, (exprs) => finiteIteration(f, exprs))) return false;
      if (!callsOf(st, true).every((c) => pureCall(f, c, depth, inFunction))) return false;
      return writesOf(st).every((t) => {
        if (t.kind !== "Name") return ownTarget(f, t, inFunction);
        // a plain name: a local (in a function, not the module's own top-level state), never a global
        const d = f.scopes!.of(t);
        return !!d && !(inFunction && d.top);
      });
    });
  /**
   * The checks in progress, outermost first. A function called again while it is being checked
   * is taken as pure (its body decides); a module required again, as impure. A result that took
   * an outer check's guess is not kept: `f` calls `g`, `g` calls `f`, and `f` turns out impure
   * after `g` was judged with `f` taken as pure. Only the outermost check of a cycle is kept
   */
  const pureStack: { key: FunctionExpr | TreeNode; guessedFrom: number }[] = [];
  const checkPure = (key: FunctionExpr | TreeNode, guess: boolean, compute: () => boolean): boolean => {
    if (pureMemo.has(key)) return pureMemo.get(key)!;
    const at = pureStack.findIndex((frame) => frame.key === key);
    if (at >= 0) {
      // a guess of false only makes the answer stricter; a guess of true is remembered
      if (guess) pureStack[pureStack.length - 1].guessedFrom = Math.min(pureStack[pureStack.length - 1].guessedFrom, at);
      return guess;
    }
    const frame = { key, guessedFrom: Infinity };
    pureStack.push(frame);
    const out = compute();
    pureStack.pop();
    const own = pureStack.length;
    const leansOnOuter = frame.guessedFrom < own;
    if (!out || !leansOnOuter) pureMemo.set(key, out);
    if (leansOnOuter) pureStack[own - 1].guessedFrom = Math.min(pureStack[own - 1].guessedFrom, frame.guessedFrom);
    return out;
  };
  const pureFunction = (f: ScriptFile, func: FunctionExpr, depth: number): boolean => {
    if (depth > 6) return false;
    return checkPure(func, true, () => pureStats(f, func.body.body, depth, true));
  };
  const pureModule = (mod: TreeNode): boolean =>
    checkPure(mod, false, () => {
      const m = byFile.get(fileKey(mod.file!));
      return !!m?.chunk && pureStats(m, m.chunk.body, 0, false);
    });

  // A child the tree lacks may still be there at run time: made by code (`folder.Name = "Remotes"`,
  // Cmdr's `Create("RemoteFunction", "CmdrFunction")`) or moved from elsewhere in the tree (Cmdr
  // parents its CmdrClient to ReplicatedStorage). So a lookup is reported only for a name that is
  // nowhere in the tree and that no code writes as a string other than to look it up: a typo, or an
  // instance renamed or deleted while code still waits for it.
  /** Strings the code writes other than to look a child up */
  const codeStrings = new Set<string>();
  for (const s of scripts) {
    if (s.facts) for (const str of s.facts.strings) codeStrings.add(str);
    // a file that does not parse: every quoted text counts (too many names only hides findings)
    else for (const m of s.src.matchAll(/(["'])([^"'\n]+)\1/g)) codeStrings.add(m[2]);
  }
  const madeNames = new Set(codeStrings);
  const visit = (n: TreeNode) => {
    madeNames.add(n.name);
    n.children.forEach(visit);
  };
  visit(tree.root);
  // a worktree's new script is on disk but not yet in the sourcemap it borrowed
  for (const f of files) madeNames.add(path.basename(f).replace(/(\.server|\.client)?\.luau?$/i, ""));

  // Player data saved through a profile library (ProfileService's GetProfileStore(name, template),
  // ProfileStore.New(name, template)): the template's keys, and the reads of keys it does not have
  /** The keys a table expression holds, when the text says them all: a local table, a module, a module's field */
  const tableKeys = (f: ScriptFile, e: Expr, depth = 0): Set<string> | null => {
    if (depth > 4) return null;
    const fromTable = (t: Expr | undefined): Set<string> | null => {
      const x = t && unwrap(t);
      if (x?.kind !== "Table") return null;
      const out = new Set<string>();
      for (const fld of x.fields) {
        if (fld.kind === "Named") out.add(fld.name.name);
        else if (fld.kind === "Keyed" && unwrap(fld.key).kind === "String") out.add((unwrap(fld.key) as { value: string }).value);
        else return null;
      }
      return out;
    };
    const x = unwrap(e);
    if (x.kind === "Name") {
      const d = f.scopes!.of(x);
      if (!d) return null;
      const mod = moduleOf(f, d);
      if (mod) {
        const k = keysOf(mod);
        return k.open ? null : new Set(k.keys);
      }
      if (d.kind !== "local" || d.assigned.length || !d.init) return null;
      // `local Template = DataTemplate`: the table it names
      const init = unwrap(d.init);
      return init.kind === "Table" ? fromTable(init) : init.kind === "Name" || init.kind === "Member" ? tableKeys(f, init, depth + 1) : null;
    }
    // `Settings.Template`: a field of a module (or of a table of this file), written as a table in
    // its constructor or by `M.Template = {...}`
    if (x.kind === "Member" && x.object.kind === "Name") {
      const od = f.scopes!.of(x.object);
      const mod = moduleOf(f, od);
      const m = mod ? byFile.get(fileKey(mod.file!)) : od?.kind === "local" ? f : undefined;
      const table = mod ? m && returnedDecl(m) : od;
      if (!m || !table) return null;
      const init = table.init && unwrap(table.init);
      if (init?.kind === "Table") for (const fld of init.fields) if (fld.kind === "Named" && fld.name.name === x.name.name) return fromTable(fld.value);
      for (const st of m.chunk!.body) {
        if (st.kind === "Assign") {
          for (let i = 0; i < st.targets.length; i++) {
            const t = st.targets[i];
            if (t.kind === "Member" && t.name.name === x.name.name && t.object.kind === "Name" && m.scopes!.of(t.object) === table) return fromTable(st.values[i]);
          }
        }
      }
    }
    return null;
  };
  /** A module that defines StartSessionAsync or LoadProfileAsync: a profile library */
  const isProfileLibrary = (mod: TreeNode | undefined, depth = 0): boolean => {
    const m = mod && byFile.get(fileKey(mod.file!));
    if (!m?.chunk || depth > 3) return false;
    // a package manager's link file: `return require(script.Parent._Index["..."])`
    const last = m.chunk.body.at(-1);
    if (m.chunk.body.length <= 2 && last?.kind === "Return" && last.values.length === 1) {
      const v = unwrap(last.values[0]);
      if (v.kind === "Call") {
        const next = loads(m, v);
        if (next) return isProfileLibrary(next, depth + 1);
      }
    }
    const names = new Set<string>();
    const visit = (b: Block) => {
      for (const st of b.body) {
        if (st.kind === "Function" && st.target.kind === "Member") names.add(st.target.name.name);
        if (st.kind === "Do") visit(st.body);
      }
    };
    visit(m.chunk);
    return names.has("StartSessionAsync") || names.has("LoadProfileAsync") || names.has("GetProfileStore");
  };
  const checkPlayerData = () => {
    const findings = new Map<ScriptFile, { at: number; rule: string; message: string }[]>();
    const add = (s: ScriptFile, at: number, rule: string, message: string) => {
      if (!findings.has(s)) findings.set(s, []);
      findings.get(s)!.push({ at, rule, message });
    };
    // the templates, and the stores made with them
    const keys = new Set<string>();
    let templates = 0;
    let unknown = false;
    const stores = new Map<ScriptFile, Set<Decl>>();
    for (const s of scripts) {
      for (const c of s.facts?.chains ?? []) {
        const lib = moduleOf(s, s.scopes!.of(c.base));
        const [a, b] = c.ops;
        let method: string | undefined;
        let args: Expr[] | undefined;
        if (a?.kind === "call" && a.method) [method, args] = [a.method.name, a.args];
        else if (a?.kind === "member" && b?.kind === "call" && !b.method) [method, args] = [a.name.name, b.args];
        // GetProfileStore is ProfileService's own name: its module need not be in the tree (a package not installed)
        if (!args || args.length !== 2 || !(method === "GetProfileStore" || (method === "New" && isProfileLibrary(lib)))) continue;
        const k = tableKeys(s, args[1]);
        if (!k) {
          unknown = true;
          continue;
        }
        templates++;
        for (const x of k) keys.add(x);
        const d = s.scopes!.decls.find((x) => x.kind === "local" && valueOf(x) && unwrap(valueOf(x)!) === c.expr);
        if (d) {
          if (!stores.has(s)) stores.set(s, new Set());
          stores.get(s)!.add(d);
        }
      }
    }
    if (!templates || unknown) return { findings, templates: 0 };
    // keys some code writes into the data (`profile.Data.New = v`, `Data["New"] = v`): they exist from then on
    const dataKeyOf = (ops: Op[], at: number): { key: string; at: number } | null => {
      const i = ops.findIndex((o) => o.kind === "member" && o.name.name === "Data");
      const next = i >= 0 ? ops[i + 1] : undefined;
      if (next?.kind === "member") return { key: next.name.name, at: next.name.start };
      if (next?.kind === "index" && next.key.kind === "String") return { key: next.key.value, at: next.key.start };
      return at < 0 ? null : null;
    };
    // a profile: the value of a store's LoadProfileAsync / StartSessionAsync, in the file of the store
    const isProfile = (s: ScriptFile, d: Decl | undefined): boolean => {
      const v = d && valueOf(d);
      const e = v && unwrap(v);
      if (e?.kind !== "Call" || !e.method || (e.method.name !== "LoadProfileAsync" && e.method.name !== "StartSessionAsync")) return false;
      const store = rootName(e.callee);
      return !!store && !!stores.get(s)?.has(s.scopes!.of(store)!);
    };
    const reads: { s: ScriptFile; key: string; at: number }[] = [];
    const written = new Set<string>();
    for (const [s] of stores) {
      for (const c of s.facts!.chains) {
        if (!isProfile(s, s.scopes!.of(c.base))) continue;
        const k = dataKeyOf(c.ops, 0);
        if (!k) continue;
        if (c.role === "target" && c.ops.length === 2) written.add(k.key);
        else reads.push({ s, key: k.key, at: k.at });
      }
    }
    // a key accessor, from its use: a module method called with a literal at some position, nearly always a template key
    const accessors = new Map<string, { s: ScriptFile; key: string; at: number }[]>();
    for (const s of scripts) {
      for (const c of s.facts?.chains ?? []) {
        const mod = moduleOf(s, s.scopes!.of(c.base));
        if (!mod) continue;
        const [a, b] = c.ops;
        let method: string | undefined;
        let args: Expr[] | undefined;
        if (a?.kind === "call" && a.method) [method, args] = [a.method.name, a.args];
        else if (a?.kind === "member" && b?.kind === "call" && !b.method) [method, args] = [a.name.name, b.args];
        if (!method || !args) continue;
        args.forEach((arg, i) => {
          const x = unwrap(arg);
          const id = `${fileKey(mod.file!)}:${method}:${i}`;
          if (!accessors.has(id)) accessors.set(id, []);
          accessors.get(id)!.push(x.kind === "String" ? { s, key: x.value, at: x.start } : { s, key: "", at: -1 });
        });
      }
    }
    for (const [, calls] of accessors) {
      const literal = calls.filter((c) => c.at >= 0);
      const hits = literal.filter((c) => keys.has(c.key.split(".")[0]));
      if (new Set(hits.map((c) => c.key)).size < 3 || hits.length < 0.9 * literal.length || literal.length < 0.5 * calls.length) continue;
      for (const c of literal) if (!keys.has(c.key.split(".")[0])) reads.push(c);
    }
    for (const r of reads) {
      const key = r.key.split(".")[0];
      if (keys.has(key) || written.has(key)) continue;
      const near = [...keys].filter((k) => distance(k.toLowerCase(), key.toLowerCase()) <= 2);
      add(r.s, r.at, "missing-data-key", `the player data template has no "${key}"${near.length === 1 ? ` (did you mean "${near[0]}"?)` : ""}: this reads nil`);
    }
    return { findings, templates };
  };

  const liveCandidates = (): LiveCandidate[] => {
    const out = new Map<TreeNode, LiveCandidate>();
    for (const s of scripts) {
      if (!isWanted(s)) continue;
      for (const b of s.bound.values()) {
        const mod = b?.module;
        if (!mod || out.has(mod)) continue;
        // a module safe to require needs no root; one only proven loaded goes with its roots
        const roots = pureModule(mod) ? [] : rootsOf.get(mod);
        if (!roots) continue;
        const k = keysOf(mod);
        const p = instancePath(mod);
        if (k.open && !isLazy(mod) && k.why !== "no file" && p && SERVER_REQUIRABLE.has(p[0]) && !isProtected(mod)) out.set(mod, { file: mod.file!, path: p, why: k.why!, roots });
      }
    }
    return [...out.values()];
  };

  const report = (live?: LiveKeys): AnalyzeReport => {
    const t1 = Date.now();
    const liveRead = new Set<TreeNode>();
    const keysNow = (node: TreeNode): ModuleKeys => {
      const k = keysOf(node);
      const keys = k.open && k.why !== "no file" ? live?.keys.get(fileKey(node.file!)) : undefined;
      if (!keys) return k;
      liveRead.add(node);
      // what the module's own text writes on the table it returns counts too (a field set later,
      // by a method on self): a write on another table of the file does not
      const own = new Set(keys);
      const m = byFile.get(fileKey(node.file!));
      const returned = m && returnedDecl(m);
      if (returned && !returned.assigned.length) for (const w of m.facts!.writes) if (w.key !== null && !w.removes && writer(m, w.object) === returned) own.add(w.key);
      return { open: false, keys: own };
    };
    const findings: Finding[] = [];
    let memberUses = 0;
    let instancePaths = 0;
    let loaderCalls = 0;
    // remotes are matched across the whole place, then reported in the wanted files
    const remotes = tree.complete ? checkRemotes(scripts, tree, codeStrings) : { findings: new Map<ScriptFile, { at: number; rule: string; message: string }[]>(), remotes: 0 };
    const channels = checkChannels(scripts);
    const playerData = checkPlayerData();
    for (const s of scripts) {
      // what Wally installs is read (its modules, its keys) but never reported: the next install rewrites it. A
      // package copied by hand into Packages is the game's own copy, patched there sometimes: it is checked
      if (!isWanted(s) || WALLY_INSTALLED.test(s.file)) continue;
      // `-- quack: allow(rule)` silences any rule, the analyzer's own too
      const add = (index: number, rule: string, message: string) => {
        if (silenced(s, index, rule)) return;
        const { line, column } = lineCol(s.lineStarts, index);
        findings.push({ file: s.file, line, column, rule, message });
      };
      if (s.parseError) {
        add(s.parseError.at, s.parseError.rule, s.parseError.message);
        continue;
      }
      // every module the file holds is read, used or not (the count of modules left out stays whole)
      for (const b of s.bound.values()) if (b?.module) keysOf(b.module);
      memberUses += checkMembers(s, keysNow, writtenFrom, add);
      loaderCalls += checkLoaderNames(s, isLoader, folderOf, add);
      for (const f of remotes.findings.get(s) ?? []) add(f.at, f.rule, f.message);
      for (const f of channels.findings.get(s) ?? []) add(f.at, f.rule, f.message);
      for (const f of playerData.findings.get(s) ?? []) add(f.at, f.rule, f.message);
      if (tree.complete && !VENDORED.test(s.file)) instancePaths += checkPaths(s, tree, madeNames, add);
      for (const f of lintChunk(s.chunk!, { globals: TEST_FILE.test(s.file) ? TESTEZ_GLOBALS : undefined })) add(f.at, f.rule, f.message);
    }

    findings.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column);
    const opaque = [...moduleKeys].filter(([n, k]) => k.open && k.why !== "no file" && !liveRead.has(n)).map(([n, k]) => ({ file: n.file!, why: k.why! }));
    return {
      root,
      findings,
      stats: {
        scripts: scripts.length,
        tree: tree.complete ? "sourcemap" : "sync folder",
        sourcemap: tree.sourcemap ?? null,
        modulesRead: moduleKeys.size,
        modulesOpaque: opaque.length,
        memberUses,
        instancePaths,
        loaderCalls,
        remotes: remotes.remotes,
        channels: channels.channels,
        dataTemplates: playerData.templates,
        ms: loadMs + Date.now() - t1,
        ...(live ? { live: { place: live.place, modules: liveRead.size, note: `${liveRead.size} module${liveRead.size === 1 ? "" : "s"} read in the running play of ${live.place}` } } : {}),
      },
      opaque,
    };
  };
  const loadMs = Date.now() - t0;
  return { liveCandidates, report };
}

/**
 * A Script or LocalScript that runs in its place in the tree: a Script in ServerScriptService or
 * the Workspace, a LocalScript in ReplicatedFirst. Anywhere else it is a template some code
 * clones (into a GUI, a character) or a script whose RunContext the sourcemap does not tell
 */
function runsWhereItIs(node: TreeNode): boolean {
  const service = instancePath(node)?.[0];
  return node.className === "Script" ? service === "ServerScriptService" || service === "Workspace" : service === "ReplicatedFirst";
}

/** A Script the server runs by itself: in ServerScriptService or the Workspace (ServerStorage runs nothing) */
function runsOnServer(node: TreeNode): boolean {
  const service = instancePath(node)?.[0];
  return node.className === "Script" && (service === "ServerScriptService" || service === "Workspace");
}

type CallExpr = Extract<Expr, { kind: "Call" }>;

/** Calls that only read or build: a module whose top level makes only these changes nothing when required */
const PURE_CALLS = new Set(["print", "warn", "typeof", "type", "tostring", "tonumber", "pairs", "ipairs", "next", "select", "setmetatable", "getmetatable", "rawget", "rawequal", "rawlen", "unpack", "table.pack", "table.unpack", "table.concat", "table.find", "table.clone", "table.create", "table.isfrozen", "table.maxn", "buffer.create", "buffer.fromstring", "buffer.tostring", "buffer.len"]);
/** Libraries whose every function only computes */
const PURE_LIBRARIES = new Set(["math", "string", "utf8", "bit32", "Vector3", "Vector2", "CFrame", "Color3", "UDim", "UDim2", "BrickColor", "NumberRange", "NumberSequence", "NumberSequenceKeypoint", "ColorSequence", "ColorSequenceKeypoint", "TweenInfo", "Rect", "Region3", "Ray", "DateTime", "Random", "Font", "PhysicalProperties", "Instance", "Enum", "os"]);
const IMPURE_CALLS = new Set(["Instance.fromExisting"]);
/** table functions that change their table: pure only on a table of the file's own */
const TABLE_MUTATORS = new Set(["insert", "remove", "sort", "clear", "freeze", "move"]);
/** Methods that read (an instance, a service, a string, a value type) */
const PURE_METHODS = new Set(["GetService", "FindFirstChild", "FindFirstChildOfClass", "FindFirstChildWhichIsA", "FindFirstAncestor", "FindFirstAncestorOfClass", "FindFirstAncestorWhichIsA", "GetChildren", "GetDescendants", "IsA", "GetAttribute", "GetAttributes", "GetFullName", "IsDescendantOf", "IsAncestorOf", "IsServer", "IsClient", "IsStudio", "IsRunning", "IsEdit", "GetPlayers", "format", "lower", "upper", "sub", "gsub", "match", "gmatch", "find", "rep", "split", "len", "byte", "reverse", "Lerp", "Inverse", "ToWorldSpace", "ToObjectSpace", "PointToWorldSpace", "PointToObjectSpace", "VectorToWorldSpace", "VectorToObjectSpace", "GetComponents", "ToEulerAnglesXYZ", "ToOrientation", "ToHSV", "ToHex", "Dot", "Cross", "Abs", "Floor", "Ceil", "Max", "Min", "FuzzyEq"]);

/** A `while` or `repeat` in the statement or its inner blocks (not in the functions it defines) */
function hasOpenLoop(st: Stat, finite: (exprs: Expr[]) => boolean): boolean {
  const inner = (b: Block) => b.body.some((x) => hasOpenLoop(x, finite));
  switch (st.kind) {
    case "While":
    case "Repeat":
      return true;
    case "If":
      return st.clauses.some((c) => inner(c.body)) || (!!st.orelse && inner(st.orelse));
    case "GenericFor":
      // `for k in f do` calls f until it returns nil: only iterators known to end pass
      return !finite(st.exprs) || inner(st.body);
    case "NumericFor":
    case "Do":
      return inner(st.body);
    default:
      return false;
  }
}

/** What a statement assigns to, its inner blocks too (not the functions it defines): `function f()` assigns f */
function writesOf(st: Stat): Expr[] {
  const out: Expr[] = [];
  const stat = (x: Stat): void => {
    switch (x.kind) {
      case "Assign":
        out.push(...x.targets);
        return;
      case "CompoundAssign":
        out.push(x.target);
        return;
      case "Function":
        out.push(x.target.kind === "Member" ? x.target.object : x.target);
        return;
      case "If":
        for (const c of x.clauses) c.body.body.forEach(stat);
        x.orelse?.body.forEach(stat);
        return;
      case "While":
      case "Repeat":
      case "NumericFor":
      case "GenericFor":
      case "Do":
        x.body.body.forEach(stat);
        return;
      default:
        return;
    }
  };
  stat(st);
  return out;
}

/** Calls that return without yielding or erroring on their own: they cannot stop a script's top level */
const SAFE_CALLS = new Set(["print", "warn", "typeof", "type", "tostring", "tonumber", "pairs", "ipairs", "next", "select", "setmetatable", "getmetatable", "rawget", "rawset", "rawequal", "rawlen", "unpack"]);
const SAFE_LIBRARIES = new Set(["math", "string", "table", "utf8", "bit32", "buffer", "os", "coroutine", "task", "Vector3", "Vector2", "CFrame", "Color3", "UDim", "UDim2", "BrickColor", "NumberRange", "NumberSequence", "NumberSequenceKeypoint", "ColorSequence", "ColorSequenceKeypoint", "TweenInfo", "Rect", "Region3", "Ray", "Instance", "DateTime", "Random", "Enum", "Font", "PhysicalProperties"]);
/** The ones of those libraries that yield */
const UNSAFE_CALLS = new Set(["task.wait", "coroutine.yield", "coroutine.resume"]);
/** Methods that never yield (an event's Connect, a lookup that may answer nil) */
const SAFE_METHODS = new Set(["GetService", "FindFirstChild", "FindFirstChildOfClass", "FindFirstChildWhichIsA", "FindFirstAncestor", "FindFirstAncestorOfClass", "GetChildren", "GetDescendants", "IsA", "GetAttribute", "GetAttributes", "SetAttribute", "Connect", "Once", "ConnectParallel", "GetPropertyChangedSignal", "GetAttributeChangedSignal", "Clone", "GetFullName", "IsDescendantOf", "IsAncestorOf"]);

function rootName(e: Expr): NameExpr | null {
  while (e.kind === "Member") e = e.object;
  return e.kind === "Name" ? e : null;
}

/**
 * The calls a statement makes, not those inside the functions it defines. `nested`: also the
 * ones in its inner blocks (an `if` body, a loop), which may or may not run
 */
function callsOf(st: Stat, nested: boolean): CallExpr[] {
  const out: CallExpr[] = [];
  const expr = (e: Expr): void => {
    switch (e.kind) {
      case "Call":
        out.push(e);
        expr(e.callee);
        e.args.forEach(expr);
        return;
      case "Member":
        expr(e.object);
        return;
      case "Index":
        expr(e.object);
        expr(e.key);
        return;
      case "Table":
        for (const f of e.fields) {
          if (f.kind === "Keyed") expr(f.key);
          expr(f.value);
        }
        return;
      case "Binary":
        expr(e.left);
        expr(e.right);
        return;
      case "Unary":
        expr(e.operand);
        return;
      case "Paren":
      case "Cast":
        expr(e.expr);
        return;
      case "IfElse":
        for (const c of e.clauses) {
          expr(c.cond);
          expr(c.value);
        }
        expr(e.orelse);
        return;
      case "Interp":
        e.parts.forEach(expr);
        return;
      default:
        return;
    }
  };
  const block = (b: Block) => {
    if (nested) b.body.forEach(stat);
  };
  const stat = (x: Stat): void => {
    switch (x.kind) {
      case "Local":
        x.values.forEach(expr);
        return;
      case "Assign":
        x.values.forEach(expr);
        x.targets.forEach(expr);
        return;
      case "CompoundAssign":
        expr(x.target);
        expr(x.value);
        return;
      case "CallStat":
        expr(x.call);
        return;
      case "Return":
        x.values.forEach(expr);
        return;
      case "If":
        for (const c of x.clauses) {
          expr(c.cond);
          block(c.body);
        }
        if (x.orelse) block(x.orelse);
        return;
      case "While":
      case "Repeat":
        expr(x.cond);
        block(x.body);
        return;
      case "NumericFor":
        expr(x.from);
        expr(x.to);
        if (x.step) expr(x.step);
        block(x.body);
        return;
      case "GenericFor":
        x.exprs.forEach(expr);
        block(x.body);
        return;
      case "Do":
        block(x.body);
        return;
      default:
        return;
    }
  };
  stat(st);
  return out;
}

/** The names from the service down, or null outside the DataModel's services */
function instancePath(node: TreeNode): string[] | null {
  const parts: string[] = [];
  let n: TreeNode | undefined = node;
  for (; n && n.parent; n = n.parent) parts.unshift(n.name);
  return n?.className === "DataModel" && parts.length > 1 ? parts : null;
}

function listScripts(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) {
        if (!e.name.startsWith(".")) walk(p);
      } else if (/\.luau?$/i.test(e.name)) out.push(p);
    }
  };
  walk(dir);
  return out;
}

function readScript(file: string, tree: GameTree): ScriptFile {
  return parseScript(fs.readFileSync(file, "utf8"), file, tree.byFile.get(fileKey(file)));
}

function parseScript(src: string, file: string, node?: TreeNode): ScriptFile {
  const lineStarts = [0];
  for (let i = src.indexOf("\n"); i >= 0; i = src.indexOf("\n", i + 1)) lineStarts.push(i + 1);
  const s: ScriptFile = { file, src, node, lineStarts, bound: new Map(), loaderCalls: [] };
  try {
    s.chunk = parseLuau(src);
  } catch (error) {
    if (!(error instanceof LuauSyntaxError)) throw error;
    s.parseError = { at: error.at, rule: "parse-error", message: error.message };
    return s;
  }
  s.scopes = resolveScopes(s.chunk);
  s.facts = collectFacts(s.chunk);
  return s;
}

function lineCol(starts: number[], index: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= index) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo + 1, column: index - starts[lo] + 1 };
}

const unwrap = (e: Expr): Expr => {
  while (e.kind === "Paren" || e.kind === "Cast") e = e.expr;
  return e;
};

/** `a.b:c(d)`: the first name and the steps after it, or null when the chain starts elsewhere (`(f)().x`) */
function flatten(e: Expr): { base: Expr; ops: Op[] } {
  const ops: Op[] = [];
  for (;;) {
    if (e.kind === "Member") {
      ops.push({ kind: "member", name: e.name });
      e = e.object;
    } else if (e.kind === "Index") {
      ops.push({ kind: "index", key: e.key });
      e = e.object;
    } else if (e.kind === "Call") {
      ops.push({ kind: "call", method: e.method, args: e.args });
      e = e.callee;
    } else break;
  }
  return { base: e, ops: ops.reverse() };
}

/** `math.floor`, `Engine:Extend`: the dotted name of a callee, when it is one */
function dotted(e: Expr, method?: Binding): string | null {
  const parts: string[] = [];
  let x = e;
  while (x.kind === "Member") {
    parts.unshift(x.name.name);
    x = x.object;
  }
  if (x.kind !== "Name") return null;
  parts.unshift(x.name);
  return parts.join(".") + (method ? `:${method.name}` : "");
}

/**
 * Walks a file once and keeps what the rules read: every chain of names (`X.a:b()`), the members
 * tested before use, the writes to a table's keys, the names passed to calls, the strings.
 */
function collectFacts(chunk: Chunk): Facts {
  const facts: Facts = { chains: [], guards: [], writes: [], passes: [], strings: [], protects: false, tested: new Set() };
  const scopes: Range[] = [{ start: chunk.start, end: chunk.end }];
  const here = () => scopes[scopes.length - 1];

  const guard = (e: Expr) => {
    e = unwrap(e);
    if (e.kind === "Unary" && e.op === "not") return guard(e.operand);
    if (e.kind === "Name") facts.tested.add(e);
    if (e.kind === "Member" && e.object.kind === "Name") facts.guards.push({ object: e.object, key: e.name.name, at: e.start, scope: here() });
    else if (e.kind === "Index" && e.object.kind === "Name" && e.key.kind === "String") facts.guards.push({ object: e.object, key: e.key.value, at: e.start, scope: here() });
  };

  const block = (b: Block) => b.body.forEach(stat);

  const func = (f: FunctionExpr) => {
    scopes.push({ start: f.start, end: f.end });
    block(f.body);
    scopes.pop();
  };

  const write = (target: Expr, value?: Expr) => {
    const removes = value?.kind === "Nil";
    if ((target.kind === "Member" && target.name.name === "__metatable") || (target.kind === "Index" && target.key.kind === "String" && target.key.value === "__metatable")) facts.protects = true;
    if (target.kind === "Member" && target.object.kind === "Name") facts.writes.push({ object: target.object, key: target.name.name, lazy: scopes.length > 1, removes });
    else if (target.kind === "Index" && target.object.kind === "Name") {
      const k = unwrap(target.key);
      facts.writes.push({ object: target.object, key: k.kind === "String" ? k.value : null, lazy: scopes.length > 1, removes });
    }
  };

  const target = (t: Expr, role: Chain["role"], value?: Expr) => {
    if (t.kind === "Name") return;
    write(t, value);
    chain(t, role, value);
  };

  const stat = (s: Stat) => {
    switch (s.kind) {
      case "Local":
        s.values.forEach((v, i) => {
          const u = unwrap(v);
          if (i < s.names.length && (u.kind === "Member" || u.kind === "Index" || u.kind === "Call")) chain(u, "read", undefined, true);
          else expr(v);
        });
        return;
      case "LocalFunction":
        func(s.func);
        return;
      case "Function":
        target(s.target, "function");
        func(s.func);
        return;
      case "Assign":
        s.values.forEach((v, i) => {
          const u = unwrap(v);
          // `X = Remotes.Hit` into a local declared earlier: the local's value, followed through its uses
          if (s.targets[i]?.kind === "Name" && (u.kind === "Member" || u.kind === "Index" || u.kind === "Call")) chain(u, "read", undefined, true);
          else expr(v);
        });
        s.targets.forEach((t, i) => target(t, "target", s.values[i]));
        return;
      case "CompoundAssign":
        // `X.k += 1` reads k first: a key it needs, not one it makes
        expr(s.target);
        expr(s.value);
        return;
      case "CallStat":
        expr(s.call);
        return;
      case "If":
        for (const c of s.clauses) {
          guard(c.cond);
          expr(c.cond);
          block(c.body);
        }
        if (s.orelse) block(s.orelse);
        return;
      case "While":
        guard(s.cond);
        expr(s.cond);
        block(s.body);
        return;
      case "Repeat":
        block(s.body);
        guard(s.cond);
        expr(s.cond);
        return;
      case "NumericFor":
        expr(s.from);
        expr(s.to);
        if (s.step) expr(s.step);
        block(s.body);
        return;
      case "GenericFor":
        s.exprs.forEach(expr);
        block(s.body);
        return;
      case "Do":
        block(s.body);
        return;
      case "Return":
        s.values.forEach(expr);
        return;
      default:
        return;
    }
  };

  /** A chain's own name and steps; the expressions inside its steps (arguments, keys) are walked too */
  const chain = (e: Expr, role: Chain["role"], value?: Expr, init?: boolean) => {
    const { base, ops } = flatten(e);
    if (base.kind === "Name") facts.chains.push({ base, ops, role, scope: here(), value, init, expr: e });
    else expr(base);
    let callee: Expr = base;
    for (const op of ops) {
      if (op.kind === "index") {
        // `folder["X"]` looks a child up; it does not name one made at run time
        if (op.key.kind !== "String") expr(op.key);
        callee = { kind: "Index", object: callee, key: op.key, start: callee.start, end: op.key.end };
        continue;
      }
      if (op.kind === "member") {
        callee = { kind: "Member", object: callee, name: op.name, start: callee.start, end: op.name.end };
        continue;
      }
      const name = op.method?.name ?? (callee.kind === "Member" ? callee.name.name : callee.kind === "Name" ? callee.name : "");
      const path = dotted(callee, op.method);
      op.args.forEach((a, i) => {
        const u = unwrap(a);
        if (i === 0 && u.kind === "String" && LOOKUPS.has(name)) return;
        if (u.kind === "Name") facts.passes.push({ callee: path, index: i, arg: u, lazy: scopes.length > 1 });
        if (!op.method && (path === "type" || path === "typeof")) guard(a);
        expr(a);
      });
      callee = { kind: "Call", callee, method: op.method, args: op.args, start: callee.start, end: callee.end };
    }
  };

  const expr = (e: Expr): void => {
    switch (e.kind) {
      case "Member":
      case "Index":
      case "Call":
        chain(e, "read");
        return;
      case "String":
        facts.strings.push(e.value);
        return;
      case "Function":
        func(e);
        return;
      case "Table":
        for (const f of e.fields) {
          if ((f.kind === "Named" && f.name.name === "__metatable") || (f.kind === "Keyed" && f.key.kind === "String" && f.key.value === "__metatable")) facts.protects = true;
          if (f.kind === "Keyed") expr(f.key);
          expr(f.value);
        }
        return;
      case "Binary":
        if (e.op === "and" || e.op === "or") {
          guard(e.left);
          guard(e.right);
        } else if ((e.op === "==" || e.op === "~=") && (e.left.kind === "Nil" || e.right.kind === "Nil")) guard(e.left.kind === "Nil" ? e.right : e.left);
        expr(e.left);
        expr(e.right);
        return;
      case "Unary":
        if (e.op === "not") guard(e.operand);
        expr(e.operand);
        return;
      case "Paren":
      case "Cast":
        expr(e.expr);
        return;
      case "IfElse":
        for (const c of e.clauses) {
          guard(c.cond);
          expr(c.cond);
          expr(c.value);
        }
        expr(e.orelse);
        return;
      case "Interp":
        e.parts.forEach(expr);
        return;
      default:
        return;
    }
  };

  block(chunk);
  return facts;
}

// ---------------------------------------------------------------------------------------------
// Declarations: which module or instance each one names

/** The local a module returns: `return M`, `return setmetatable(M, mt)`, `return table.freeze(M)` */
function returnedDecl(s: ScriptFile): Decl | undefined {
  const last = s.chunk?.body.at(-1);
  if (last?.kind !== "Return" || last.values.length !== 1) return undefined;
  let v = unwrap(last.values[0]);
  if (v.kind === "Call" && !v.method && v.args.length >= 1 && ["setmetatable", "table.freeze"].includes(dotted(v.callee) ?? "")) v = unwrap(v.args[0]);
  return v.kind === "Name" ? s.scopes!.of(v) : undefined;
}

/** `self` in `function M:m()` stands for M */
function writer(s: ScriptFile, object: NameExpr): Decl | undefined {
  const d = s.scopes!.of(object);
  return d?.kind === "self" && d.methodOf ? s.scopes!.of(d.methodOf) : d;
}

function moduleOf(s: ScriptFile, d: Decl | undefined): TreeNode | undefined {
  return d ? s.bound.get(d)?.module : undefined;
}

const isGlobal = (s: ScriptFile, e: Expr, name: string) => e.kind === "Name" && e.name === name && !s.scopes!.of(e);

function bindAll(s: ScriptFile, tree: GameTree): void {
  if (!s.scopes) return;
  for (const d of s.scopes.decls) bind(s, tree, d);
}

/** What a declaration names: a module (`require(path)`), an instance (a path), or a loader call to qualify later */
function bind(s: ScriptFile, tree: GameTree, d: Decl): Bound | null {
  if (s.bound.has(d)) return s.bound.get(d)!;
  s.bound.set(d, null);
  const v = valueOf(d);
  let b: Bound | null = null;
  if (v) {
    const e = unwrap(v);
    const loader = e.kind === "Call" ? loaderOf(s, tree, e) : null;
    if (e.kind === "Call" && !e.method && isGlobal(s, e.callee, "require") && e.args.length === 1) {
      const node = instanceOf(s, tree, e.args[0]);
      if (node && node.className === "ModuleScript" && node.file) b = { module: node };
    } else if (loader) {
      // Loader.getX("Name"): kept as a candidate; qualifyLoaders binds it once every call of that
      // loader method in the game is seen
      s.loaderCalls.push({ decl: d, ...loader });
    } else {
      const node = instanceOf(s, tree, e);
      if (node) b = { instance: node };
    }
  }
  s.bound.set(d, b);
  return b;
}

/** `Library.getConfig("X")` / `Library:get("X")`, Library a module: the loader, its method, and the module X it may mean */
function loaderOf(s: ScriptFile, tree: GameTree, e: Extract<Expr, { kind: "Call" }>): Omit<LoaderCall, "decl"> | null {
  const arg = e.args.length === 1 ? unwrap(e.args[0]) : undefined;
  if (arg?.kind !== "String") return null;
  const object = e.method ? e.callee : e.callee.kind === "Member" ? e.callee.object : null;
  const method = e.method?.name ?? (e.callee.kind === "Member" ? e.callee.name.name : null);
  const decl = object?.kind === "Name" ? s.scopes!.of(object) : undefined;
  const loader = decl ? bind(s, tree, decl)?.module : undefined;
  return loader && method ? { loader, method, found: moduleUnder(loader, arg.value) } : null;
}

/**
 * A loader method is taken as one that returns the module named by its argument only when it
 * looks like one over the whole game: nearly every call names a module the loader holds, all in
 * one folder (Library.getConfig("X") -> Library/Config/X). Library.getBridge("Hit") names
 * remotes, not modules: one day a Util called Hit would otherwise make `Hit:Fire()` a finding.
 */
function qualifyLoaders(scripts: ScriptFile[]): { isLoader: (loader: TreeNode, method: string) => boolean; folderOf: (loader: TreeNode, method: string) => TreeNode | undefined } {
  const groups = new Map<string, LoaderCall[]>();
  const ids = new Map<TreeNode, number>();
  for (const s of scripts) {
    for (const c of s.loaderCalls) {
      if (!ids.has(c.loader)) ids.set(c.loader, ids.size);
      const key = `${ids.get(c.loader)}:${c.method}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(c);
    }
  }
  /** The qualified loader methods and the one folder their modules are in */
  const good = new Map<string, TreeNode>();
  for (const [key, calls] of groups) {
    const found = calls.filter((c) => c.found);
    const folders = new Set(found.map((c) => c.found!.parent));
    const modules = new Set(found.map((c) => c.found));
    // at least 3 different modules: getBridge("Hit") three times, Hit sharing a Config's name, proves nothing
    if (modules.size >= 3 && found.length >= 0.9 * calls.length && folders.size === 1) good.set(key, [...folders][0]!);
  }
  for (const s of scripts) {
    for (const c of s.loaderCalls) if (c.found && good.has(`${ids.get(c.loader)}:${c.method}`)) s.bound.set(c.decl, { module: c.found });
  }
  const keyOf = (loader: TreeNode, method: string) => (ids.has(loader) ? `${ids.get(loader)}:${method}` : "");
  return { isLoader: (loader, method) => good.has(keyOf(loader, method)), folderOf: (loader, method) => good.get(keyOf(loader, method)) };
}

/** A call of a module's method with one string (`Loader.get("Name")`, `Loader:get("Name")`): the module, the method and the string */
function stringCallOn(s: ScriptFile, c: Chain): { loader: TreeNode; method: string; name: Extract<Expr, { kind: "String" }>; at: number } | null {
  const loader = moduleOf(s, s.scopes!.of(c.base));
  if (!loader) return null;
  const [a, b] = c.ops;
  let method: string;
  let args: Expr[];
  if (a?.kind === "call" && a.method) [method, args] = [a.method.name, a.args];
  else if (a?.kind === "member" && b?.kind === "call" && !b.method) [method, args] = [a.name.name, b.args];
  else return null;
  const arg = args.length === 1 ? unwrap(args[0]) : undefined;
  return arg?.kind === "String" ? { loader, method, name: arg, at: arg.start } : null;
}

/** Edit distance, capped: enough to suggest the name a typo meant */
function distance(a: string, b: string, cap = 3): number {
  if (Math.abs(a.length - b.length) > cap) return cap + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) row[j] = Math.min(prev[j] + 1, row[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = row;
  }
  return prev[b.length];
}

function moduleUnder(loader: TreeNode, name: string): TreeNode | null {
  const found: TreeNode[] = [];
  for (const c of loader.children) {
    if (c.name === name && c.className === "ModuleScript") found.push(c);
    for (const g of c.children) if (g.name === name && g.className === "ModuleScript") found.push(g);
  }
  return found.length === 1 && found[0].file ? found[0] : null;
}

// ---------------------------------------------------------------------------------------------
// Instance paths

interface Segment {
  kind: "dot" | "wait" | "find" | "index";
  name: string;
  /** WaitForChild with a timeout: it may return nil on purpose */
  timeout?: boolean;
  /** FindFirstChild(name, true) searches every descendant */
  recursive?: boolean;
  at: number;
  /** The step after this one: `.Event:Connect` or `.Method()` say the name was not a child */
  next?: Op;
}

/** The node a chain starts at (script, workspace, game:GetService("S"), a local bound to an instance) and the steps that took */
function rootOf(s: ScriptFile, tree: GameTree, base: NameExpr, ops: Op[]): { node: TreeNode; used: number } | null {
  const d = s.scopes!.of(base);
  if (d) {
    const node = bind(s, tree, d)?.instance;
    return node ? { node, used: 0 } : null;
  }
  if (base.name === "script") return s.node ? { node: s.node, used: 0 } : null;
  if (base.name === "workspace") return service(tree, "Workspace", 0);
  if (base.name === "game") {
    const op = ops[0];
    if (op?.kind === "member") return service(tree, op.name.name, 1);
    if (op?.kind === "call" && op.method?.name === "GetService" && op.args.length === 1 && op.args[0].kind === "String") return service(tree, op.args[0].value, 1);
  }
  return null;
}

function service(tree: GameTree, name: string, used: number): { node: TreeNode; used: number } | null {
  if (!SERVICES.has(name)) return null;
  const node = childNamed(tree.root, name);
  return node ? { node, used } : null;
}

/** The child lookups at the front of the steps */
function segments(ops: Op[]): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < ops.length; i++) {
    const op = ops[i];
    const next = ops[i + 1];
    if (op.kind === "member") out.push({ kind: "dot", name: op.name.name, at: op.name.start, next });
    else if (op.kind === "index" && op.key.kind === "String") out.push({ kind: "index", name: op.key.value, at: op.key.start, next });
    else if (op.kind === "call" && op.method && (op.method.name === "WaitForChild" || op.method.name === "FindFirstChild") && op.args[0]?.kind === "String") {
      const extra = op.args[1];
      const kind = op.method.name === "WaitForChild" ? "wait" : "find";
      out.push({ kind, name: op.args[0].value, at: op.method.start, next, timeout: kind === "wait" && !!extra, recursive: kind === "find" && !!extra && !(extra.kind === "Boolean" && !extra.value) && extra.kind !== "Nil" });
    } else break;
  }
  return out;
}

/** An expression that is only a path: script.Parent.X, game:GetService("S"), Alias:WaitForChild("X") */
function instanceOf(s: ScriptFile, tree: GameTree, e: Expr): TreeNode | null {
  const { base, ops } = flatten(unwrap(e));
  if (base.kind !== "Name") return null;
  const r = rootOf(s, tree, base, ops);
  if (!r) return null;
  const rest = ops.slice(r.used);
  const segs = segments(rest);
  if (segs.length !== rest.length) return null;
  return walk(r.node, segs).node ?? null;
}

type Walked =
  | { node: TreeNode; missing?: undefined }
  /** `notMember`: the parent's class is known and has no member by that name either */
  | { node?: undefined; missing?: { seg: Segment; parent: TreeNode; notMember?: string } }
  | { node?: undefined; missing?: undefined };

const classMembersMemo = new Map<string, Set<string> | null>();
/** Every member of a class, the inherited ones too; null for a class the API dump does not have */
export function classMembers(className: string): Set<string> | null {
  if (classMembersMemo.has(className)) return classMembersMemo.get(className)!;
  let out: Set<string> | null = null;
  if (ROBLOX_CLASSES[className]) {
    out = new Set();
    for (let c: string | undefined = className; c && ROBLOX_CLASSES[c]; c = ROBLOX_CLASSES[c][0]) for (const m of ROBLOX_CLASSES[c][1]) out.add(m);
  }
  classMembersMemo.set(className, out);
  return out;
}

const uniqueMemo = new WeakMap<TreeNode, boolean>();
/**
 * The node is the one its path reaches at run time: neither it nor any of its ancestors shares
 * its name with a sibling (`a.b` gives the first child called b, and the tree's order may not be
 * the game's)
 */
function uniquePath(node: TreeNode): boolean {
  const known = uniqueMemo.get(node);
  if (known !== undefined) return known;
  const out = !node.parent || (node.parent.children.filter((c) => c.name === node.name).length === 1 && uniquePath(node.parent));
  uniqueMemo.set(node, out);
  return out;
}

/** The members of the node's class, when the class is known and the node is surely the one the path reaches */
function membersOf(node: TreeNode): Set<string> | null {
  return uniquePath(node) ? classMembers(node.className) : null;
}

/** Follows the segments through the tree: the node reached, or the first child that is not there */
function walk(start: TreeNode, segs: Segment[]): Walked {
  let node = start;
  for (const seg of segs) {
    if (seg.kind === "dot" && seg.name === "Parent") {
      const up = node.parent;
      if (!up || up.className === "DataModel" || STARTERS.has(up.className) || STARTERS.has(up.name)) return {};
      // a Script or LocalScript where it does not run is a template cloned elsewhere: its parent then is another
      if ((node.className === "Script" || node.className === "LocalScript") && !runsWhereItIs(node)) return {};
      node = up;
      continue;
    }
    if (seg.kind === "find" && seg.recursive) return {};
    const child = childNamed(node, seg.name);
    if (child) {
      node = child;
      continue;
    }
    if (seg.kind === "find") return {};
    if (seg.kind === "wait" && seg.timeout) return {};
    if (seg.kind === "dot" || seg.kind === "index") {
      // `part.Size`: a property, an event or a method of its class; what follows is no instance of the tree
      const members = membersOf(node);
      if (members?.has(seg.name)) return {};
      if (members) return { missing: { seg, parent: node, notMember: node.className } };
    }
    if (seg.kind === "dot" && (ROBLOX_MEMBERS.has(seg.name) || (seg.next?.kind === "call" && (!seg.next.method || EVENT_METHODS.has(seg.next.method.name))))) return {};
    return { missing: { seg, parent: node } };
  }
  return { node };
}

function checkPaths(s: ScriptFile, tree: GameTree, madeNames: Set<string>, add: (index: number, rule: string, message: string) => void): number {
  let count = 0;
  for (const c of s.facts!.chains) {
    const r = rootOf(s, tree, c.base, c.ops);
    if (!r) continue;
    const all = c.ops.slice(r.used);
    // `a.b.Value = 1` sets a property: the last step is not a lookup
    const ops = c.role !== "read" ? all.slice(0, -1) : all;
    const segs = segments(ops);
    if (segs.length) count++;
    const w = walk(r.node, segs);
    if (w.node) {
      // the path ends on an instance: the step after it is a member of its class (a method called, a property set)
      const after = all[segs.length];
      const members = membersOf(w.node);
      if (!members || !after) continue;
      if (after.kind === "call" && after.method && !members.has(after.method.name)) {
        add(after.method.start, "invalid-member", `${pathOf(w.node)} is a ${w.node.className}: it has no method "${after.method.name}"`);
      } else if (c.role === "target" && segs.length === all.length - 1) {
        const name = after.kind === "member" ? after.name : after.kind === "index" && after.key.kind === "String" ? { name: after.key.value, start: after.key.start } : null;
        if (name && !members.has(name.name) && !childNamed(w.node, name.name)) add(name.start, "invalid-member", `${pathOf(w.node)} is a ${w.node.className}: it has no property "${name.name}" to set`);
      }
      continue;
    }
    if (!w.missing) continue;
    const { seg, parent, notMember } = w.missing;
    if (madeNames.has(seg.name)) continue;
    // a member of another class (`frame.Image`); a name no class has stays a missing child (a typo, a child deleted)
    if (notMember && seg.kind !== "wait" && ROBLOX_MEMBERS.has(seg.name)) {
      add(seg.at, "invalid-member", `${pathOf(parent)} is a ${notMember}: it has no member or child "${seg.name}"`);
      continue;
    }
    const what = seg.kind === "wait" ? `WaitForChild("${seg.name}") waits forever` : seg.kind === "index" ? `["${seg.name}"] errors` : `.${seg.name} errors`;
    add(seg.at, "missing-child", `${pathOf(parent)} has no child "${seg.name}": ${what}`);
  }
  return count;
}

// ---------------------------------------------------------------------------------------------
// Remotes and bindables: who fires, who listens, with how many values

/** Each class: the methods that send, and for each the event or callback that receives it */
const SENDS: Record<string, Record<string, { receiver: string; side: "server" | "client" | "any"; skip: number }>> = {
  RemoteEvent: { FireServer: { receiver: "OnServerEvent", side: "server", skip: 0 }, FireClient: { receiver: "OnClientEvent", side: "client", skip: 1 }, FireAllClients: { receiver: "OnClientEvent", side: "client", skip: 0 } },
  UnreliableRemoteEvent: { FireServer: { receiver: "OnServerEvent", side: "server", skip: 0 }, FireClient: { receiver: "OnClientEvent", side: "client", skip: 1 }, FireAllClients: { receiver: "OnClientEvent", side: "client", skip: 0 } },
  RemoteFunction: { InvokeServer: { receiver: "OnServerInvoke", side: "server", skip: 0 }, InvokeClient: { receiver: "OnClientInvoke", side: "client", skip: 1 } },
  BindableEvent: { Fire: { receiver: "Event", side: "any", skip: 0 } },
  BindableFunction: { Invoke: { receiver: "OnInvoke", side: "any", skip: 0 } },
};
/** Receivers that are events (connected) rather than callbacks (assigned) */
const EVENT_RECEIVERS = new Set(["OnServerEvent", "OnClientEvent", "Event"]);
/** Uses of an instance that look its children up by a name the text does not give, or list them */
const LISTS_CHILDREN = new Set(["GetChildren", "GetDescendants", "FindFirstChildOfClass", "FindFirstChildWhichIsA", "FindFirstDescendant", "QueryDescendants"]);
const CHILD_EVENTS = new Set(["ChildAdded", "DescendantAdded", "ChildRemoved", "DescendantRemoving"]);

interface Send {
  file: ScriptFile;
  at: number;
  method: string;
  /** Values sent past the player (FireClient's first argument), or null when a call or `...` ends the list */
  count: number | null;
}
interface Receive {
  file: ScriptFile;
  at: number;
  receiver: string;
  /** The handler's parameters past the player, or null when unknown (a vararg, a function from elsewhere, `:Wait()`) */
  count: number | null;
}

/** Follows child lookups from a node as far as the tree has them: the node reached and how many steps it took */
function reach(start: TreeNode, segs: Segment[]): { node: TreeNode; used: number } | null {
  let node = start;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i];
    if (seg.kind === "dot" && seg.name === "Parent") {
      const up = node.parent;
      if (!up || up.className === "DataModel" || STARTERS.has(up.className) || STARTERS.has(up.name)) return null;
      if ((node.className === "Script" || node.className === "LocalScript") && !runsWhereItIs(node)) return null;
      node = up;
      continue;
    }
    if (seg.kind === "find" && seg.recursive) return null;
    const child = childNamed(node, seg.name);
    if (!child) return seg.kind === "dot" || seg.kind === "index" ? { node, used: i } : null;
    node = child;
  }
  return { node, used: segs.length };
}

/** The parameters a handler takes, when the text says (a function written there, or a local function) */
function handlerParams(s: ScriptFile, e: Expr | undefined): { params: number; vararg: boolean } | null {
  if (!e) return null;
  const x = unwrap(e);
  let f: FunctionExpr | undefined;
  if (x.kind === "Function") f = x;
  else if (x.kind === "Name") {
    const d = s.scopes!.of(x);
    if (d?.func && !d.assigned.length) f = d.func;
  }
  return f ? { params: f.params.length + (f.self ? 1 : 0), vararg: f.vararg } : null;
}

/** The values a call passes, or null when its last argument may spread (a call, `...`) */
function argCount(args: Expr[]): number | null {
  const last = args.at(-1) && unwrap(args.at(-1)!);
  return last && (last.kind === "Call" || last.kind === "Vararg") ? null : args.length;
}

/**
 * Every remote and bindable of the tree the code reaches by a literal path: what fires it, what
 * listens, with how many values. A remote is left alone (opaque) when some code may reach it in a
 * way the text does not spell: its name written as a string (a lookup by name), a list of its
 * parent's children (`GetChildren`, `ChildAdded`), a lookup by a computed name, the instance
 * (or one above it) handed to a function, stored or returned. Over a sync folder alone (no
 * sourcemap) nothing is known
 */
function checkRemotes(scripts: ScriptFile[], tree: GameTree, codeStrings: Set<string>): { findings: Map<ScriptFile, { at: number; rule: string; message: string }[]>; remotes: number } {
  const sends = new Map<TreeNode, Send[]>();
  const receives = new Map<TreeNode, Receive[]>();
  /** Instances some code reaches in a way the text does not follow: they and every descendant */
  const opaque = new Set<TreeNode>();
  const push = <T>(m: Map<TreeNode, T[]>, n: TreeNode, v: T) => {
    if (!m.has(n)) m.set(n, []);
    m.get(n)!.push(v);
  };
  for (const s of scripts) {
    if (!s.facts) continue;
    const chainBases = new Set<NameExpr>();
    for (const c of s.facts.chains) {
      chainBases.add(c.base);
      const d = s.scopes!.of(c.base);
      let start: { node: TreeNode; used: number } | null;
      if (d) {
        const node = bind(s, tree, d)?.instance;
        start = node ? { node, used: 0 } : null;
      } else start = rootOf(s, tree, c.base, c.ops);
      if (!start) continue;
      const ops = c.ops.slice(start.used);
      const segs = segments(ops);
      const r = reach(start.node, segs);
      if (!r) continue;
      const node = r.node;
      const rest = ops.slice(r.used);
      const first = rest[0];
      if (!first) {
        // the instance itself as a value: bound to a local (followed there), else handed on or stored
        if (!c.init) opaque.add(node);
        continue;
      }
      if (first.kind === "index" && first.key.kind !== "String") opaque.add(node);
      // cloned, moved or renamed: it lives on where the text does not follow
      if (first.kind === "call" && first.method?.name === "Clone") opaque.add(node);
      if (first.kind === "member" && c.role === "target" && rest.length === 1 && (first.name.name === "Parent" || first.name.name === "Name")) opaque.add(node);
      if (first.kind === "member" && CHILD_EVENTS.has(first.name.name)) opaque.add(node);
      if (first.kind === "call" && first.method) {
        const m = first.method.name;
        if (LISTS_CHILDREN.has(m) || ((m === "FindFirstChild" || m === "WaitForChild") && first.args[0]?.kind !== "String")) opaque.add(node);
      }
      const sends_ = SENDS[node.className];
      if (!sends_) continue;
      if (first.kind === "call" && first.method && sends_[first.method.name]) {
        const n = argCount(first.args);
        push(sends, node, { file: s, at: first.method.start, method: first.method.name, count: n === null ? null : Math.max(0, n - sends_[first.method.name].skip) });
        continue;
      }
      if (first.kind === "member") {
        const receiver = first.name.name;
        const known = Object.values(sends_).some((x) => x.receiver === receiver);
        if (!known) continue;
        const server = receiver === "OnServerEvent" || receiver === "OnServerInvoke";
        let handler: { params: number; vararg: boolean } | null = null;
        let at = first.name.start;
        if (EVENT_RECEIVERS.has(receiver)) {
          const next = rest[1];
          if (next?.kind !== "call" || !next.method) {
            opaque.add(node);
            continue;
          }
          if (next.method.name === "Connect" || next.method.name === "Once" || next.method.name === "ConnectParallel") handler = handlerParams(s, next.args[0]);
          at = next.method.start;
        } else if (c.role === "target" && rest.length === 1) handler = handlerParams(s, c.value);
        else continue;
        const count = !handler || handler.vararg ? null : Math.max(0, handler.params - (server ? 1 : 0));
        push(receives, node, { file: s, at, receiver, count });
      }
    }
    // a local bound to an instance used other than as the start of a chain (passed, stored, returned): opaque
    for (const d of s.scopes!.decls) {
      const node = s.bound.get(d)?.instance;
      if (!node) continue;
      if (s.scopes!.uses(d).some((n) => !chainBases.has(n))) opaque.add(node);
    }
  }
  const isOpaque = (n: TreeNode): boolean => {
    for (let x: TreeNode | undefined = n; x; x = x.parent) if (opaque.has(x)) return true;
    return codeStrings.has(n.name) || !uniquePath(n);
  };
  const findings = new Map<ScriptFile, { at: number; rule: string; message: string }[]>();
  const add = (s: ScriptFile, at: number, rule: string, message: string) => {
    if (!findings.has(s)) findings.set(s, []);
    findings.get(s)!.push({ at, rule, message });
  };
  let remotes = 0;
  for (const node of new Set([...sends.keys(), ...receives.keys()])) {
    if (!isOpaque(node)) remotes++;
    const out = sends.get(node) ?? [];
    const ins = receives.get(node) ?? [];
    const where = pathOf(node);
    const table = SENDS[node.className];
    if (!isOpaque(node)) {
      for (const x of out) {
        const receiver = table[x.method].receiver;
        if (!ins.some((r) => r.receiver === receiver)) add(x.file, x.at, "remote-no-listener", `${where}:${x.method}() reaches no code: nothing listens to ${node.className}.${receiver}${x.method.startsWith("Invoke") ? ", so the call waits forever" : ""}`);
      }
      for (const r of ins) {
        if (!out.some((x) => table[x.method].receiver === r.receiver)) add(r.file, r.at, "remote-no-sender", `${where}.${r.receiver} never fires: no code calls ${Object.entries(table).filter(([, v]) => v.receiver === r.receiver).map(([k]) => `:${k}()`).join(" or ")} on it`);
      }
    }
    // the values sent against the handler's parameters, both written in the text
    for (const x of out) {
      if (x.count === null) continue;
      for (const r of ins) {
        if (r.count === null || table[x.method].receiver !== r.receiver || x.count <= r.count) continue;
        add(x.file, x.at, "remote-arg-count", `${where}:${x.method}() sends ${x.count} value${x.count === 1 ? "" : "s"}, but the handler at ${path.basename(r.file.file)}:${lineCol(r.file.lineStarts, r.at).line} takes ${r.count}: the rest are dropped`);
      }
    }
  }
  return { findings, remotes };
}

const basesMemo = new WeakMap<ScriptFile, Map<NameExpr, Chain>>();
/** The chain each name starts, in a file */
function bases(s: ScriptFile): Map<NameExpr, Chain> {
  let m = basesMemo.get(s);
  if (!m) {
    m = new Map(s.facts!.chains.map((x) => [x.base, x] as const));
    basesMemo.set(s, m);
  }
  return m;
}

/** The name is the target of a plain assignment (`X = v`) */
function isAssignTarget(s: ScriptFile, n: NameExpr): boolean {
  const d = s.scopes!.of(n);
  return !!d && d.at !== n.start && s.src.slice(n.end).trimStart().startsWith("=") && !s.src.slice(n.end).trimStart().startsWith("==");
}

/** Methods that send on a channel (a remote, a bindable, a networking library's object) */
const SEND_METHODS = new Set(["Fire", "FireServer", "FireClient", "FireAllClients", "FireExcept", "FireAllExcept", "Invoke", "InvokeServer", "InvokeClient", "InvokeServerAsync"]);
/** Methods that receive on one directly (`bridge:Connect(fn)`) */
const RECEIVE_METHODS = new Set(["Connect", "Once", "Wait", "ConnectParallel"]);
/** Members that receive: an event connected, or a callback assigned */
const RECEIVE_MEMBERS = new Set(["OnServerEvent", "OnClientEvent", "Event", "OnServerInvoke", "OnClientInvoke", "OnInvoke"]);

type ChannelUse = "send" | "receive" | "other" | "unknown";

/** What the steps after a channel do with it: send, receive, something else, or hand it on (unknown) */
function channelUse(ops: Op[], role: Chain["role"]): ChannelUse {
  const [a, b] = ops;
  if (!a) return "unknown";
  if (a.kind === "call" && a.method) return SEND_METHODS.has(a.method.name) ? "send" : RECEIVE_METHODS.has(a.method.name) ? "receive" : "other";
  if (a.kind === "member" && RECEIVE_MEMBERS.has(a.name.name)) {
    if (role === "target" && ops.length === 1) return "receive";
    if (b?.kind === "call" && b.method && RECEIVE_METHODS.has(b.method.name)) return "receive";
    return "other";
  }
  return "other";
}

/**
 * Channels named by a string: a function or method the game calls with a literal name and whose
 * result it fires or connects (`GetRemote("Hit", folder)`, `Net.get("Hit")`,
 * `Bridges.ReferenceBridge("Hit")`). Recognized by that use over the whole game, never by its
 * name: at least 3 different names fired or connected, and no call with a name the text does not
 * give (a parameter passed through, as in `function get(name) return X(name) end`, is the caller's
 * literal). A name sent and never received anywhere, or received and never sent, is reported.
 * A name stays out when some call's result goes where the text does not follow (stored in a table,
 * passed, returned), or the name is written as a string anywhere else (a list of names connected
 * in a loop, a lookup by name)
 */
function checkChannels(scripts: ScriptFile[]): { findings: Map<ScriptFile, { at: number; rule: string; message: string }[]>; channels: number } {
  interface Call {
    file: ScriptFile;
    name: string;
    at: number;
    uses: { use: ChannelUse; at: number }[];
  }
  /** A call with a name the text does not give, by what it does with the channel: it may be any name */
  const byFactory = new Map<string, { calls: Call[]; dynamic: Set<ChannelUse> }>();
  const literalCount = new Map<string, number>();
  const stringCount = new Map<string, number>();
  for (const s of scripts) {
    if (s.facts) for (const str of s.facts.strings) stringCount.set(str, (stringCount.get(str) ?? 0) + 1);
    // a file that does not parse may send or connect any name it quotes
    else for (const m of s.src.matchAll(/(["'])([^"'\n]+)\1/g)) stringCount.set(m[2], Infinity);
  }
  for (const s of scripts) {
    if (!s.facts) continue;
    for (const c of s.facts.chains) {
      const mod = moduleOf(s, s.scopes!.of(c.base));
      if (!mod) continue;
      const [a, b] = c.ops;
      let key: string;
      let call: Extract<Op, { kind: "call" }>;
      let rest: Op[];
      if (a?.kind === "call" && a.method) [key, call, rest] = [`${fileKey(mod.file!)}:${a.method.name}`, a, c.ops.slice(1)];
      else if (a?.kind === "call") [key, call, rest] = [`${fileKey(mod.file!)}()`, a, c.ops.slice(1)];
      else if (a?.kind === "member" && b?.kind === "call" && !b.method) [key, call, rest] = [`${fileKey(mod.file!)}.${a.name.name}`, b, c.ops.slice(2)];
      else continue;
      const arg = call.args[0] && unwrap(call.args[0]);
      if (!arg) continue;
      if (!byFactory.has(key)) byFactory.set(key, { calls: [], dynamic: new Set() });
      const factory = byFactory.get(key)!;
      const uses: Call["uses"] = [];
      if (rest.length) uses.push({ use: channelUse(rest, c.role), at: arg.start });
      else if (c.init) {
        const d = s.scopes!.decls.find((x) => x.kind === "local" && valueOf(x) && unwrap(valueOf(x)!) === c.expr);
        if (!d) uses.push({ use: "unknown", at: arg.start });
        else {
          for (const n of s.scopes!.uses(d)) {
            const ch = bases(s).get(n);
            // the assignment that gave it its value is not a use
            if (!ch && d.init === undefined && isAssignTarget(s, n)) continue;
            if (!ch && s.facts.tested.has(n)) continue;
            uses.push({ use: ch ? channelUse(ch.ops, ch.role) : "unknown", at: ch ? (ch.ops[0].kind === "call" && ch.ops[0].method ? ch.ops[0].method.start : n.start) : n.start });
          }
        }
      } else uses.push({ use: "unknown", at: arg.start });
      if (arg.kind !== "String") {
        // a parameter passed through is its caller's name; anything else may be any channel
        if (!(arg.kind === "Name" && s.scopes!.of(arg)?.kind === "param")) for (const u of uses) factory.dynamic.add(u.use);
        continue;
      }
      factory.calls.push({ file: s, name: arg.value, at: arg.start, uses });
    }
  }
  /** Every send and receive of a name, over every factory that qualified */
  const byName = new Map<string, { sends: { file: ScriptFile; at: number }[]; receives: { file: ScriptFile; at: number }[]; unknown: boolean }>();
  /** Some call with a name the text does not give may receive (so a send may have a listener), or send */
  let anyReceives = false;
  let anySends = false;
  for (const [, f] of byFactory) {
    const named = new Set(f.calls.filter((c) => c.uses.some((u) => u.use === "send" || u.use === "receive")).map((c) => c.name));
    if (named.size < 3) continue;
    if (f.dynamic.has("receive") || f.dynamic.has("unknown")) anyReceives = true;
    if (f.dynamic.has("send") || f.dynamic.has("unknown")) anySends = true;
    for (const c of f.calls) {
      literalCount.set(c.name, (literalCount.get(c.name) ?? 0) + 1);
      if (!byName.has(c.name)) byName.set(c.name, { sends: [], receives: [], unknown: false });
      const entry = byName.get(c.name)!;
      for (const u of c.uses) {
        if (u.use === "send") entry.sends.push({ file: c.file, at: u.at });
        else if (u.use === "receive") entry.receives.push({ file: c.file, at: u.at });
        else if (u.use === "unknown") entry.unknown = true;
      }
    }
  }
  const findings = new Map<ScriptFile, { at: number; rule: string; message: string }[]>();
  const add = (s: ScriptFile, at: number, rule: string, message: string) => {
    if (!findings.has(s)) findings.set(s, []);
    findings.get(s)!.push({ at, rule, message });
  };
  let channels = 0;
  for (const [name, e] of byName) {
    // written as a string somewhere else than these calls: reached by name in a way the text does not follow
    if (e.unknown || (stringCount.get(name) ?? 0) > (literalCount.get(name) ?? 0)) continue;
    channels++;
    // the one name a typo may have meant: close, and with the other side this one lacks
    const near = (other: "sends" | "receives") => {
      const found = [...byName].filter(([n, x]) => n !== name && x[other].length && distance(n.toLowerCase(), name.toLowerCase()) <= 2).map(([n]) => n);
      return found.length === 1 ? ` (did you mean "${found[0]}"?)` : "";
    };
    if (!e.receives.length && !anyReceives) for (const x of e.sends) add(x.file, x.at, "remote-no-listener", `"${name}" is sent here, but no code connects to "${name}"${near("receives")}`);
    if (!e.sends.length && !anySends) for (const x of e.receives) add(x.file, x.at, "remote-no-sender", `"${name}" is connected here, but no code sends on "${name}"${near("sends")}`);
  }
  return { findings, channels };
}

function pathOf(node: TreeNode): string {
  const parts: string[] = [];
  for (let n: TreeNode | undefined = node; n && n.className !== "DataModel"; n = n.parent) parts.unshift(n.name);
  return parts.join(".");
}

// ---------------------------------------------------------------------------------------------
// Module keys

/** The keys of a module given as text (for tests and tools): see keysOfModule */
export function exportedKeys(src: string): ModuleKeys {
  const s = parseScript(src, "module.luau");
  return keysOfModule(s);
}

/**
 * The keys a module returns, read from its tree: `local M = { k = ... }`, `M.k =`,
 * `function M.k` / `M:k`, `self.k =` in a method of M, `M["k"] =`, `export type K`. Open (never
 * checked) when the tree cannot tell them all: a return that is not a local, a local that is not
 * a table constructor or is assigned again, a computed key, a metatable on M, or M handed to a
 * function that may fill it (`PathSelectionConfigUtil.Extend(BloodlineConfig)` hangs eight
 * methods on it).
 */
function keysOfModule(s: ScriptFile): ModuleKeys {
  const open = (why: string): ModuleKeys => ({ open: true, why, keys: new Set() });
  if (!s.chunk) return open("does not parse");
  const scopes = s.scopes!;
  const last = s.chunk.body.at(-1);
  if (last?.kind !== "Return") return open("no return at the top level");
  const value = last.values.length === 1 ? unwrap(last.values[0]) : undefined;
  if (value?.kind !== "Name") return open(`returns ${s.src.slice(last.start + 7, last.end).replace(/\s+/g, " ").trim().slice(0, 40)}`);
  const name = value.name;
  const M = scopes.of(value);
  const init = M?.init && unwrap(M.init);
  if (!M || M.kind !== "local" || !M.top || init?.kind !== "Table") return open(`${name} is not a table built here`);
  if (M.assigned.length) return open(`${name} is assigned again`);
  const keys = new Set<string>();
  for (const f of init.fields) {
    if (f.kind === "Named") keys.add(f.name.name);
    else if (f.kind === "Keyed") {
      const k = unwrap(f.key);
      if (k.kind !== "String") return open(`${name} has a computed key in its constructor`);
      keys.add(k.value);
    }
  }
  // the first reason it cannot be read; lazy when any fill runs from inside a function
  let why: string | undefined;
  let lazy = false;
  for (const p of s.facts!.passes) {
    if (scopes.of(p.arg) !== M) continue;
    const reason = p.callee === "setmetatable" && p.index === 0 ? `a metatable on ${name}` : !p.callee || !NOT_A_FILL.has(p.callee) ? `${name} is passed to ${p.callee ?? "a function"}` : undefined;
    if (!reason) continue;
    why ??= reason;
    if (p.lazy && p.callee !== "setmetatable") lazy = true;
  }
  for (const w of s.facts!.writes) {
    if (writer(s, w.object) !== M) continue;
    if (w.key !== null) keys.add(w.key);
    else {
      why ??= `${name}[...] is written`;
      if (w.lazy) lazy = true;
    }
  }
  if (why) return { open: true, why, keys: new Set(), lazy };
  for (const st of s.chunk.body) if (st.kind === "TypeAlias" && st.exported) keys.add(st.name.name);
  return { open: false, keys };
}

function checkMembers(
  s: ScriptFile,
  keysOf: (node: TreeNode) => ModuleKeys,
  writtenFrom: Map<TreeNode, Set<string>>,
  add: (index: number, rule: string, message: string) => void,
): number {
  const scopes = s.scopes!;
  let count = 0;
  for (const c of s.facts!.chains) {
    const d = scopes.of(c.base);
    const mod = moduleOf(s, d);
    if (!mod) continue;
    const op = c.ops[0];
    let key: string;
    let shown: string;
    if (op.kind === "member") [key, shown] = [op.name.name, `.${op.name.name}`];
    else if (op.kind === "call" && op.method) [key, shown] = [op.method.name, `:${op.method.name}`];
    else if (op.kind === "index" && op.key.kind === "String") [key, shown] = [op.key.value, `["${op.key.value}"]`];
    else continue;
    // `X.k = v` writes k (counted as a key from here), it does not read it
    if (c.role !== "read" && c.ops.length === 1) continue;
    count++;
    const k = keysOf(mod);
    if (k.open || k.keys.has(key) || writtenFrom.get(mod)?.has(key)) continue;
    // the caller tests the member before using it, in the same function or one around it:
    // absent on purpose sometimes. A test in another function does not cover this use
    const at = c.base.start;
    if (s.facts!.guards.some((g) => g.key === key && g.at <= at && g.scope.start <= at && at < g.scope.end && scopes.of(g.object) === d)) continue;
    add(at, "missing-member", `${c.base.name}${shown}: ${mod.name} (${path.basename(mod.file!)}) has no "${key}"`);
  }
  return count;
}

/**
 * A call of a loader method (one the whole game calls with the name of a module in one folder:
 * `Loader.get("Name")`) naming nothing the loader holds: a typo, or a module renamed or deleted
 * while a caller still asks for it. Any instance by that name under the loader keeps it quiet (the
 * loader may answer more than modules)
 */
function checkLoaderNames(
  s: ScriptFile,
  isLoader: (loader: TreeNode, method: string) => boolean,
  folderOf: (loader: TreeNode, method: string) => TreeNode | undefined,
  add: (index: number, rule: string, message: string) => void,
): number {
  let count = 0;
  for (const c of s.facts!.chains) {
    const call = stringCallOn(s, c);
    if (!call || !isLoader(call.loader, call.method)) continue;
    count++;
    const name = call.name.value;
    if (call.loader.children.some((x) => x.name === name || x.children.some((g) => g.name === name))) continue;
    const folder = folderOf(call.loader, call.method)!;
    const near = folder.children.filter((x) => x.className === "ModuleScript" && distance(x.name.toLowerCase(), name.toLowerCase()) <= 2).map((x) => x.name);
    const hint = near.length === 1 ? ` (did you mean "${near[0]}"?)` : "";
    add(call.at, "missing-module", `${c.base.name}.${call.method}("${name}"): ${pathOf(folder)} has no module "${name}"${hint}`);
  }
  return count;
}

/** selene's names for the checks the linter took over, so its allow comments keep working */
const SELENE_NAMES: Record<string, string> = {
  parse_error: "parse-error", undefined_variable: "undefined-variable", almost_swapped: "almost-swapped", compare_nan: "compare-nan",
  constant_table_comparison: "constant-table-compare", duplicate_keys: "duplicate-key", ifs_same_cond: "ifs-same-cond",
  incorrect_standard_library_use: "std-arg-count", mismatched_arg_count: "mismatched-arg-count", suspicious_reverse_loop: "reverse-loop",
  type_check_inside_call: "type-check-inside-call", roblox_incorrect_color3_new_bounds: "color3-bounds",
};

/** `-- quack: allow(rule, ...)` or `-- selene: allow(rule, ...)` on the finding's line or the line above */
function silenced(s: ScriptFile, at: number, rule: string): boolean {
  const { line } = lineCol(s.lineStarts, at);
  for (const l of [line, line - 1]) {
    if (l < 1) continue;
    const text = s.src.slice(s.lineStarts[l - 1], s.lineStarts[l] ?? s.src.length);
    for (const m of text.matchAll(/--\s*(?:quack|selene):\s*allow\(([^)]*)\)/g)) {
      if (m[1].split(",").some((r) => {
        const name = r.trim();
        return name === rule || SELENE_NAMES[name] === rule;
      })) return true;
    }
  }
  return false;
}
