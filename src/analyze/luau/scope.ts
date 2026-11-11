import type { Binding, Block, Chunk, Expr, FunctionExpr, Stat } from "./ast.js";

/**
 * Which declaration each name in a file reads or writes, by Luau's scoping rules: a local is
 * seen from the statement after it to the end of its block, `local function f` inside its own
 * body, `until` inside the loop's body, a method's `self` inside the method. A name no scope
 * declares is a global (`of` returns undefined). The analyzer binds modules and instances to
 * these declarations, so an inner `local Config = {}` or a parameter called like a module is
 * another thing, and a module reassigned anywhere (`M = Other`) is no longer the module.
 */

export type NameExpr = Extract<Expr, { kind: "Name" }>;

export interface Decl {
  name: string;
  /** Where it is declared (0-based offset) */
  at: number;
  kind: "local" | "function" | "param" | "for" | "self";
  /** `local X = <init>`: the value lined up with this name, when one is */
  init?: Expr;
  /** Every value assigned to it after: `undefined` for one that cannot be told (`a, b = f()`, `x += 1`) */
  assigned: (Expr | undefined)[];
  /** Declared in the chunk's own block (a module's table, its requires) */
  top: boolean;
  /** `self` of `function M:m()`: the `M` it is a method of */
  methodOf?: NameExpr;
  /** The function it names: `local function f`, `local f = function` */
  func?: FunctionExpr;
}

export interface Scopes {
  /** The declaration a name resolves to; undefined: a global */
  of(name: NameExpr): Decl | undefined;
  decls: Decl[];
  /** Every name that reads or assigns the declaration */
  uses(d: Decl): NameExpr[];
}

/** What a local holds, when the text says it: its one value (`local X = v`, or `local X` then one `X = v`) */
export function valueOf(d: Decl): Expr | undefined {
  if (d.kind !== "local") return undefined;
  if (d.assigned.length === 0) return d.init;
  if ((!d.init || d.init.kind === "Nil") && d.assigned.length === 1) return d.assigned[0];
  return undefined;
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

export function resolveScopes(chunk: Chunk): Scopes {
  const refs = new Map<NameExpr, Decl>();
  const decls: Decl[] = [];
  const root = new Scope();

  const declare = (scope: Scope, b: Binding, kind: Decl["kind"], init?: Expr, methodOf?: NameExpr, func?: FunctionExpr): Decl => {
    const d: Decl = { name: b.name, at: b.start, kind, init, assigned: [], top: scope === root, methodOf, func: func ?? (init?.kind === "Function" ? init : undefined) };
    scope.vars.set(b.name, d);
    decls.push(d);
    return d;
  };

  const block = (b: Block, scope: Scope): void => {
    for (const s of b.body) stat(s, scope);
  };

  const func = (f: FunctionExpr, scope: Scope, methodOf?: NameExpr): void => {
    const inner = new Scope(scope);
    if (f.self) declare(inner, f.self, "self", undefined, methodOf);
    for (const p of f.params) declare(inner, p, "param");
    block(f.body, inner);
  };

  /** A name assigned: the value lined up with it, or undefined when there is none to tell */
  const assign = (target: Expr, value: Expr | undefined, scope: Scope): void => {
    if (target.kind === "Name") {
      const d = scope.find(target.name);
      if (d) {
        refs.set(target, d);
        d.assigned.push(value);
      }
      return;
    }
    expr(target, scope);
  };

  const stat = (s: Stat, scope: Scope): void => {
    switch (s.kind) {
      case "Local":
        for (const v of s.values) expr(v, scope);
        s.names.forEach((n, i) => declare(scope, n, "local", s.values[i]));
        return;
      case "LocalFunction":
        declare(scope, s.name, "function", undefined, undefined, s.func);
        func(s.func, scope);
        return;
      case "Function": {
        // `function f()` assigns f; `function M.a:b()` reads M
        if (s.target.kind === "Name") assign(s.target, undefined, scope);
        else expr(s.target, scope);
        let object: Expr = s.target;
        if (s.func.self && object.kind === "Member") object = object.object;
        func(s.func, scope, s.func.self && object.kind === "Name" ? object : undefined);
        return;
      }
      case "Assign":
        for (const v of s.values) expr(v, scope);
        s.targets.forEach((t, i) => assign(t, s.values[i], scope));
        return;
      case "CompoundAssign":
        expr(s.value, scope);
        assign(s.target, undefined, scope);
        return;
      case "CallStat":
        expr(s.call, scope);
        return;
      case "If":
        for (const c of s.clauses) {
          expr(c.cond, scope);
          block(c.body, new Scope(scope));
        }
        if (s.orelse) block(s.orelse, new Scope(scope));
        return;
      case "While":
        expr(s.cond, scope);
        block(s.body, new Scope(scope));
        return;
      case "Repeat": {
        const inner = new Scope(scope);
        block(s.body, inner);
        expr(s.cond, inner);
        return;
      }
      case "NumericFor": {
        expr(s.from, scope);
        expr(s.to, scope);
        if (s.step) expr(s.step, scope);
        const inner = new Scope(scope);
        declare(inner, s.var, "for");
        block(s.body, inner);
        return;
      }
      case "GenericFor": {
        for (const e of s.exprs) expr(e, scope);
        const inner = new Scope(scope);
        for (const v of s.vars) declare(inner, v, "for");
        block(s.body, inner);
        return;
      }
      case "Do":
        block(s.body, new Scope(scope));
        return;
      case "Return":
        for (const v of s.values) expr(v, scope);
        return;
      default:
        return;
    }
  };

  const expr = (e: Expr, scope: Scope): void => {
    switch (e.kind) {
      case "Name": {
        const d = scope.find(e.name);
        if (d) refs.set(e, d);
        return;
      }
      case "Member":
        expr(e.object, scope);
        return;
      case "Index":
        expr(e.object, scope);
        expr(e.key, scope);
        return;
      case "Call":
        expr(e.callee, scope);
        for (const a of e.args) expr(a, scope);
        return;
      case "Function":
        func(e, scope);
        return;
      case "Table":
        for (const f of e.fields) {
          if (f.kind === "Keyed") expr(f.key, scope);
          expr(f.value, scope);
        }
        return;
      case "Binary":
        expr(e.left, scope);
        expr(e.right, scope);
        return;
      case "Unary":
        expr(e.operand, scope);
        return;
      case "Paren":
      case "Cast":
        expr(e.expr, scope);
        return;
      case "IfElse":
        for (const c of e.clauses) {
          expr(c.cond, scope);
          expr(c.value, scope);
        }
        expr(e.orelse, scope);
        return;
      case "Interp":
        for (const p of e.parts) expr(p, scope);
        return;
      default:
        return;
    }
  };

  block(chunk, root);
  let uses: Map<Decl, NameExpr[]> | undefined;
  return {
    of: (n) => refs.get(n),
    decls,
    uses: (d) => {
      if (!uses) {
        uses = new Map();
        for (const [n, x] of refs) {
          if (!uses.has(x)) uses.set(x, []);
          uses.get(x)!.push(n);
        }
      }
      return uses.get(d) ?? [];
    },
  };
}

