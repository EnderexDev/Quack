import type { Binding, Block, Chunk, Expr, FunctionExpr, Stat } from "./ast.js";
import { GLOBALS, STD_ARGS } from "./globals.js";
import { patternFindings } from "./patterns.js";
import { LuauSyntaxError } from "./lexer.js";
import { parseLuau } from "./parser.js";

/**
 * Quack's own Luau linter: the parser, scopes, and the checks selene reported as errors (his
 * call, 10/11/26: selene out, the checks ours to change). Each check is one function over the
 * tree; a file that does not parse gets only its parse error, as it never loads.
 *
 *   parse-error              the first syntax error (a missing `end` names the line it opened at)
 *   undefined-variable       a name read with no local, global or builtin behind it (a local
 *                            function called above its `local function`, a for variable after
 *                            its loop, `self` outside a method)
 *   mismatched-arg-count     more arguments than a local function takes
 *   std-arg-count            a standard library call with too many or too few arguments
 *   almost-swapped           `a = b` then `b = a` (a swap that loses one value)
 *   compare-nan              `x == 0/0` (always false)
 *   constant-table-compare   `x == {}` (a new table is never equal)
 *   duplicate-key            the same key twice in one table constructor
 *   ifs-same-cond            an `elseif` with the condition of an earlier branch
 *   reverse-loop             `for i = #t, 1 do` (no step: runs once at most)
 *   type-check-inside-call   `type(x == "string")`
 *   color3-bounds            `Color3.new(255, 0, 0)` (it takes 0 to 1)
 *   remove-in-loop, connect-in-handler, field-typo: bug patterns, in patterns.ts
 */

export interface LintFinding {
  /** 0-based offset in the source */
  at: number;
  rule: string;
  message: string;
}

export interface LintResult {
  findings: LintFinding[];
  /** The tree, when the file parsed */
  chunk?: Chunk;
}

export interface LintOptions {
  /** Globals the file's runner defines (TestEZ's describe and it in a .spec file) */
  globals?: ReadonlySet<string>;
}

export function lintLuau(src: string, options: LintOptions = {}): LintResult {
  let chunk: Chunk;
  try {
    chunk = parseLuau(src);
  } catch (error) {
    if (error instanceof LuauSyntaxError) return { findings: [{ at: error.at, rule: "parse-error", message: error.message }] };
    throw error;
  }
  return { findings: lintChunk(chunk, options), chunk };
}

/** The checks over a tree already parsed (the analyzer parses each file once for every rule) */
export function lintChunk(chunk: Chunk, options: LintOptions = {}): LintFinding[] {
  const findings: LintFinding[] = [];
  new Linter(chunk.src, findings, options.globals).run(chunk);
  findings.push(...patternFindings(chunk));
  findings.sort((a, b) => a.at - b.at);
  return findings;
}

interface Decl {
  name: string;
  /** The function a local names (`local function f`, `local f = function`), for its arity */
  func?: FunctionExpr;
}

class Scope {
  vars = new Map<string, Decl>();
  constructor(readonly parent?: Scope) {}
  find(name: string): Decl | undefined {
    for (let s: Scope | undefined = this; s; s = s.parent) {
      const d = s.vars.get(name);
      if (d) return d;
    }
    return undefined;
  }
}

class Linter {
  /** Reads of names no scope declares: undefined unless the file assigns that global somewhere */
  private unresolved: { name: string; at: number }[] = [];
  private assignedGlobals = new Set<string>();
  /** Globals the file tests before using (`if setclipboard then`): absent on purpose in some environments */
  private testedGlobals = new Set<string>();
  /** Every name some statement assigns to (`f = function(a) end` gives a local function another arity) */
  private assignedNames = new Set<string>();

  constructor(
    private src: string,
    private findings: LintFinding[],
    private extraGlobals?: ReadonlySet<string>,
  ) {}

  private report(at: number, rule: string, message: string): void {
    this.findings.push({ at, rule, message });
  }

  /** An expression's source as written (a string literal's spaces are part of its value) */
  private text(e: { start: number; end: number }): string {
    return this.src.slice(e.start, e.end);
  }

  run(chunk: Chunk): void {
    collectAssigned(chunk, this.assignedNames);
    this.block(chunk, new Scope());
    // a global assigned anywhere in the file counts as defined everywhere (selene does the same:
    // the order globals are set in at run time is not in the text)
    for (const u of this.unresolved) {
      if (!GLOBALS.has(u.name) && !this.extraGlobals?.has(u.name) && !this.assignedGlobals.has(u.name) && !this.testedGlobals.has(u.name)) this.report(u.at, "undefined-variable", `\`${u.name}\` is not defined`);
    }
  }

  // ---- statements

  private block(b: Block, scope: Scope): void {
    for (let i = 0; i < b.body.length; i++) {
      const s = b.body[i];
      this.stat(s, scope);
      const next = b.body[i + 1];
      if (next) this.almostSwapped(s, next);
    }
  }

  private declare(scope: Scope, b: Binding, func?: FunctionExpr): void {
    scope.vars.set(b.name, { name: b.name, func });
  }

  private write(e: Expr, scope: Scope): void {
    if (e.kind === "Name") {
      if (!scope.find(e.name)) this.assignedGlobals.add(e.name);
      return;
    }
    if (e.kind === "Member") this.expr(e.object, scope);
    else if (e.kind === "Index") {
      this.expr(e.object, scope);
      this.expr(e.key, scope);
    }
  }

  private stat(s: Stat, scope: Scope): void {
    switch (s.kind) {
      case "Local": {
        for (const v of s.values) this.expr(v, scope);
        s.names.forEach((n, i) => {
          const v = s.values[i];
          this.declare(scope, n, s.names.length === 1 && s.values.length === 1 && v?.kind === "Function" ? v : undefined);
        });
        return;
      }
      case "LocalFunction":
        // visible inside its own body (recursion), unlike `local f = function`
        this.declare(scope, s.name, s.func);
        this.func(s.func, scope);
        return;
      case "Function":
        this.write(s.target, scope);
        this.func(s.func, scope);
        return;
      case "Assign":
        for (const v of s.values) this.expr(v, scope);
        for (const t of s.targets) this.write(t, scope);
        return;
      case "CompoundAssign":
        this.expr(s.target, scope);
        this.expr(s.value, scope);
        return;
      case "CallStat":
        this.expr(s.call, scope);
        return;
      case "If": {
        const seen: string[] = [];
        for (const c of s.clauses) {
          this.tested(c.cond, scope);
          this.expr(c.cond, scope);
          const t = this.text(c.cond);
          if (seen.includes(t) && !hasCall(c.cond)) this.report(c.cond.start, "ifs-same-cond", "this `elseif` has the same condition as an earlier branch: it never runs");
          seen.push(t);
          this.block(c.body, new Scope(scope));
        }
        if (s.orelse) this.block(s.orelse, new Scope(scope));
        return;
      }
      case "While":
        this.tested(s.cond, scope);
        this.expr(s.cond, scope);
        this.block(s.body, new Scope(scope));
        return;
      case "Repeat": {
        // `until` sees the body's locals
        const inner = new Scope(scope);
        this.block(s.body, inner);
        this.expr(s.cond, inner);
        return;
      }
      case "NumericFor": {
        this.expr(s.from, scope);
        this.expr(s.to, scope);
        if (s.step) this.expr(s.step, scope);
        if (!s.step && s.from.kind === "Unary" && s.from.op === "#" && s.to.kind === "Number" && s.to.value <= 1) {
          this.report(s.from.start, "reverse-loop", `this loop runs once at most: counting down from \`${this.text(s.from)}\` needs \`, -1\``);
        }
        const inner = new Scope(scope);
        this.declare(inner, s.var);
        this.block(s.body, inner);
        return;
      }
      case "GenericFor": {
        for (const e of s.exprs) this.expr(e, scope);
        const inner = new Scope(scope);
        for (const v of s.vars) this.declare(inner, v);
        this.block(s.body, inner);
        return;
      }
      case "Do":
        this.block(s.body, new Scope(scope));
        return;
      case "Return":
        for (const v of s.values) this.expr(v, scope);
        return;
      case "Break":
      case "Continue":
      case "TypeAlias":
        return;
    }
  }

  private func(f: FunctionExpr, scope: Scope): void {
    const inner = new Scope(scope);
    if (f.self) this.declare(inner, f.self);
    for (const p of f.params) this.declare(inner, p);
    this.block(f.body, inner);
  }

  // ---- expressions

  /** A global tested in a condition: `if X`, `not X`, `X and`, `X ~= nil`, `type(X)` */
  private tested(e: Expr, scope: Scope): void {
    while (e.kind === "Paren" || e.kind === "Cast") e = e.expr;
    if (e.kind === "Name") {
      if (!scope.find(e.name)) this.testedGlobals.add(e.name);
    } else if (e.kind === "Unary" && e.op === "not") this.tested(e.operand, scope);
    else if (e.kind === "Binary" && (e.op === "and" || e.op === "or")) {
      this.tested(e.left, scope);
      this.tested(e.right, scope);
    } else if (e.kind === "Binary" && (e.op === "==" || e.op === "~=")) {
      if (e.right.kind === "Nil") this.tested(e.left, scope);
      else if (e.left.kind === "Nil") this.tested(e.right, scope);
      else if (e.left.kind === "Call") this.tested(e.left, scope);
    } else if (e.kind === "Call" && !e.method && e.callee.kind === "Name" && (e.callee.name === "type" || e.callee.name === "typeof") && e.args.length === 1) {
      this.tested(e.args[0], scope);
    }
  }

  private expr(e: Expr, scope: Scope): void {
    switch (e.kind) {
      case "Name":
        if (!scope.find(e.name)) this.unresolved.push({ name: e.name, at: e.start });
        return;
      case "Member":
        this.expr(e.object, scope);
        return;
      case "Index":
        this.expr(e.object, scope);
        this.expr(e.key, scope);
        return;
      case "Call":
        this.expr(e.callee, scope);
        for (const a of e.args) this.expr(a, scope);
        this.call(e, scope);
        return;
      case "Function":
        this.func(e, scope);
        return;
      case "Table": {
        const keys = new Map<string, number>();
        let position = 0;
        for (const f of e.fields) {
          let key: string | undefined;
          // a positional field is key 1, 2, 3... (the last one, a call or `...`, may fill more)
          if (f.kind === "Item") key = `n:${++position}`;
          // a name is ASCII: its bytes are its characters
          else if (f.kind === "Named") key = `s:${f.name.name}`;
          else if (f.kind === "Keyed") {
            this.expr(f.key, scope);
            if (f.key.kind === "String") key = `s:${f.key.bytes}`;
            else if (f.key.kind === "Number") key = `n:${f.key.value}`;
          }
          this.expr(f.value, scope);
          if (key !== undefined) {
            if (keys.has(key)) this.report(f.start, "duplicate-key", `key \`${key.slice(2)}\` is already set in this table: the first value is lost`);
            else keys.set(key, f.start);
          }
        }
        return;
      }
      case "Binary":
        if (e.op === "and" || e.op === "or") this.tested(e.left, scope);
        this.expr(e.left, scope);
        this.expr(e.right, scope);
        if (e.op === "==" || e.op === "~=") {
          if (isNan(e.left) || isNan(e.right)) this.report(e.start, "compare-nan", `comparing to nan is always ${e.op === "==" ? "false" : "true"} (\`x ~= x\` tests for nan)`);
          else if (e.left.kind === "Table" || e.right.kind === "Table") this.report(e.start, "constant-table-compare", "a table built here is a new table: it is never equal to another");
        }
        return;
      case "Unary":
        this.expr(e.operand, scope);
        return;
      case "Paren":
      case "Cast":
        this.expr(e.expr, scope);
        return;
      case "IfElse":
        for (const c of e.clauses) {
          this.tested(c.cond, scope);
          this.expr(c.cond, scope);
          this.expr(c.value, scope);
        }
        this.expr(e.orelse, scope);
        return;
      case "Interp":
        for (const p of e.parts) this.expr(p, scope);
        return;
      default:
        return;
    }
  }

  private call(e: Extract<Expr, { kind: "Call" }>, scope: Scope): void {
    if (e.method) return;
    const last = e.args.at(-1);
    const open = last !== undefined && (last.kind === "Call" || last.kind === "Vararg");
    const known = open ? e.args.length - 1 : e.args.length;
    // a local function's arity
    if (e.callee.kind === "Name") {
      const d = scope.find(e.callee.name);
      if (d?.func && !d.func.vararg && !this.assignedNames.has(d.name)) {
        const takes = d.func.params.length;
        if (known > takes) this.report(e.start, "mismatched-arg-count", `\`${d.name}\` takes ${takes} argument${takes === 1 ? "" : "s"} but ${known} ${known === 1 ? "is" : "are"} passed`);
      }
    }
    // the standard library, when the name is the global one
    const path = stdPath(e.callee);
    if (path && !scope.find(path.split(".")[0])) {
      const sig = Object.hasOwn(STD_ARGS, path) ? STD_ARGS[path] : undefined;
      if (sig) {
        const [min, max] = sig;
        if (known > max) this.report(e.start, "std-arg-count", `\`${path}\` takes at most ${max} argument${max === 1 ? "" : "s"}, ${known} passed`);
        else if (!open && known < min) this.report(e.start, "std-arg-count", `\`${path}\` needs ${min} argument${min === 1 ? "" : "s"}, ${known} passed`);
      }
      if ((path === "type" || path === "typeof") && e.args.length === 1) {
        const a = e.args[0];
        if (a.kind === "Binary" && (a.op === "==" || a.op === "~=") && (a.left.kind === "String" || a.right.kind === "String")) {
          this.report(e.start, "type-check-inside-call", `the comparison is inside \`${path}(...)\`: write \`${path}(x) == "..."\``);
        }
      }
      if (path === "Color3.new" && e.args.some((a) => a.kind === "Number" && a.value > 1)) {
        this.report(e.start, "color3-bounds", "Color3.new takes 0 to 1 per channel: 0 to 255 is Color3.fromRGB");
      }
    }
  }

  /** `a = b` followed by `b = a`: the second copies the value the first just wrote */
  private almostSwapped(a: Stat, b: Stat): void {
    if (a.kind !== "Assign" || b.kind !== "Assign") return;
    if (a.targets.length !== 1 || a.values.length !== 1 || b.targets.length !== 1 || b.values.length !== 1) return;
    const [ta, va, tb, vb] = [this.text(a.targets[0]), this.text(a.values[0]), this.text(b.targets[0]), this.text(b.values[0])];
    if (ta === vb && va === tb && ta !== va) this.report(a.start, "almost-swapped", `this looks like a swap of \`${ta}\` and \`${va}\`, but the second line copies the value back: use \`${ta}, ${va} = ${va}, ${ta}\``);
  }
}

function isNan(e: Expr): boolean {
  while (e.kind === "Paren") e = e.expr;
  return e.kind === "Binary" && e.op === "/" && e.left.kind === "Number" && e.left.value === 0 && e.right.kind === "Number" && e.right.value === 0;
}

function hasCall(e: Expr): boolean {
  switch (e.kind) {
    case "Call":
      return true;
    case "Binary":
      return hasCall(e.left) || hasCall(e.right);
    case "Unary":
      return hasCall(e.operand);
    case "Paren":
    case "Cast":
      return hasCall(e.expr);
    case "Member":
      return hasCall(e.object);
    case "Index":
      return hasCall(e.object) || hasCall(e.key);
    case "Interp":
      return e.parts.some(hasCall);
    case "IfElse":
      return e.clauses.some((c) => hasCall(c.cond) || hasCall(c.value)) || hasCall(e.orelse);
    case "Table":
      return e.fields.some((f) => hasCall(f.value) || (f.kind === "Keyed" && hasCall(f.key)));
    default:
      return false;
  }
}

/** `math.floor` / `print`: the dotted name a call goes to, when it is one */
function stdPath(e: Expr): string | null {
  if (e.kind === "Name") return e.name;
  if (e.kind === "Member" && e.object.kind === "Name") return `${e.object.name}.${e.name.name}`;
  return null;
}

/** Every plain name a statement in the file assigns to, at any depth */
function collectAssigned(block: Block, out: Set<string>): void {
  const exprs = (e: Expr): void => {
    switch (e.kind) {
      case "Function":
        collectAssigned(e.body, out);
        return;
      case "Call":
        exprs(e.callee);
        e.args.forEach(exprs);
        return;
      case "Table":
        for (const f of e.fields) {
          if (f.kind === "Keyed") exprs(f.key);
          exprs(f.value);
        }
        return;
      case "Binary":
        exprs(e.left);
        exprs(e.right);
        return;
      case "Unary":
        exprs(e.operand);
        return;
      case "Paren":
      case "Cast":
        exprs(e.expr);
        return;
      case "Member":
        exprs(e.object);
        return;
      case "Index":
        exprs(e.object);
        exprs(e.key);
        return;
      case "IfElse":
        for (const c of e.clauses) {
          exprs(c.cond);
          exprs(c.value);
        }
        exprs(e.orelse);
        return;
      case "Interp":
        e.parts.forEach(exprs);
        return;
      default:
        return;
    }
  };
  for (const s of block.body) {
    switch (s.kind) {
      case "Assign":
        for (const t of s.targets) if (t.kind === "Name") out.add(t.name);
        s.values.forEach(exprs);
        break;
      case "CompoundAssign":
        if (s.target.kind === "Name") out.add(s.target.name);
        exprs(s.value);
        break;
      case "Function":
        if (s.target.kind === "Name") out.add(s.target.name);
        collectAssigned(s.func.body, out);
        break;
      case "Local":
        s.values.forEach(exprs);
        break;
      case "LocalFunction":
        collectAssigned(s.func.body, out);
        break;
      case "CallStat":
        exprs(s.call);
        break;
      case "Return":
        s.values.forEach(exprs);
        break;
      case "If":
        for (const c of s.clauses) {
          exprs(c.cond);
          collectAssigned(c.body, out);
        }
        if (s.orelse) collectAssigned(s.orelse, out);
        break;
      case "While":
      case "Repeat":
        exprs(s.cond);
        collectAssigned(s.body, out);
        break;
      case "NumericFor":
        collectAssigned(s.body, out);
        break;
      case "GenericFor":
        s.exprs.forEach(exprs);
        collectAssigned(s.body, out);
        break;
      case "Do":
        collectAssigned(s.body, out);
        break;
      default:
        break;
    }
  }
}
