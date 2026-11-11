import type { Block, Chunk, Expr, FunctionExpr, Stat } from "./ast.js";
import type { LintFinding } from "./lint.js";
import { resolveScopes, type Decl, type NameExpr, type Scopes } from "./scope.js";

/**
 * Bug patterns any Luau game can carry, read from the tree with scopes (which name is which
 * variable). Each one was a real bug fixed in a game, and each stays quiet where the text leaves
 * room for a reason:
 *
 *   remove-in-loop      `table.remove(t, i)` while a forward loop walks t by i, or removing the
 *                       indexes of a list built in ascending order one by one: every removal
 *                       shifts what comes after, so every second element is skipped
 *   connect-in-handler  an event handler that connects, on every run, to an event of something
 *                       that outlives it, and drops the connection: the inner handler runs once
 *                       more each time the outer one did
 *   field-typo          in a list of records, the one entry that lacks a field every other has
 *                       and has instead a field no other has, a letter or two away
 */
export function patternFindings(chunk: Chunk, scopes: Scopes = resolveScopes(chunk)): LintFinding[] {
  const out: LintFinding[] = [];
  /** The first walk only gathers (the ascending and sorted lists), so a list filled below the loop that removes is known too; the second reports */
  let collecting = true;
  const src = chunk.src;
  const text = (e: { start: number; end: number }) => src.slice(e.start, e.end);
  const report = (at: number, rule: string, message: string) => {
    if (!collecting) out.push({ at, rule, message });
  };

  const unwrap = (e: Expr): Expr => {
    while (e.kind === "Paren" || e.kind === "Cast") e = e.expr;
    return e;
  };
  const isGlobal = (e: Expr, name: string) => e.kind === "Name" && e.name === name && !scopes.of(e);
  const isCallTo = (e: Expr, lib: string, fn: string): e is Extract<Expr, { kind: "Call" }> =>
    e.kind === "Call" && !e.method && e.callee.kind === "Member" && e.callee.name.name === fn && isGlobal(e.callee.object, lib);
  /** A table expression made only of names, members and indexes (no calls): its text names one table */
  const plain = (e: Expr): boolean => {
    const x = unwrap(e);
    return x.kind === "Name" || (x.kind === "Member" && plain(x.object)) || (x.kind === "Index" && plain(x.object) && (x.key.kind === "String" || x.key.kind === "Number" || x.key.kind === "Name"));
  };
  /** The declaration a plain table expression starts at (`t`, `self.list`): two texts alike may name two locals */
  const rootDecl = (e: Expr): Decl | undefined => {
    let x = unwrap(e);
    while (x.kind === "Member" || x.kind === "Index") x = unwrap(x.object);
    return x.kind === "Name" ? scopes.of(x) : undefined;
  };
  const declOf = (e: Expr): Decl | undefined => {
    const x = unwrap(e);
    return x.kind === "Name" ? scopes.of(x) : undefined;
  };

  // ---- remove-in-loop

  /** What a forward loop walks: the table (by its text) and the variable holding the index, and the one holding the value */
  const forwardLoop = (st: Stat): { table: string; root?: Decl; index?: Decl; value?: Decl } | null => {
    const decl = (b: { start: number } | undefined) => (b ? scopes.decls.find((d) => d.at === b.start) : undefined);
    if (st.kind === "NumericFor") {
      if (st.step && !(unwrap(st.step).kind === "Number" && (unwrap(st.step) as { value: number }).value > 0)) return null;
      const to = unwrap(st.to);
      if (to.kind !== "Unary" || to.op !== "#" || !plain(to.operand)) return null;
      return { table: text(unwrap(to.operand)), root: rootDecl(to.operand), index: decl(st.var) };
    }
    if (st.kind === "GenericFor") {
      const first = st.exprs[0] && unwrap(st.exprs[0]);
      if (!first) return null;
      let table: Expr | undefined;
      if (st.exprs.length === 1 && first.kind === "Call" && !first.method && (isGlobal(first.callee, "ipairs") || isGlobal(first.callee, "pairs")) && first.args.length === 1) table = first.args[0];
      else if (st.exprs.length === 2 && isGlobal(first, "next")) table = st.exprs[1];
      else if (st.exprs.length === 1 && plain(first)) table = first;
      if (!table || !plain(table)) return null;
      return { table: text(unwrap(table)), root: rootDecl(table), index: decl(st.vars[0]), value: decl(st.vars[1]) };
    }
    return null;
  };

  /**
   * The statements of a block and its inner blocks (not the functions it defines), each with the
   * block it is in, its place there, and the conditions of the ifs around it (inside the block walked)
   */
  const walkBlock = (b: Block, visit: (st: Stat, block: Block, i: number, conds: Expr[]) => void, conds: Expr[] = []): void => {
    b.body.forEach((st, i) => {
      visit(st, b, i, conds);
      if (st.kind === "If") {
        st.clauses.forEach((c) => walkBlock(c.body, visit, [...conds, c.cond]));
        if (st.orelse) walkBlock(st.orelse, visit, conds);
      } else for (const inner of innerBlocks(st)) walkBlock(inner, visit, conds);
    });
  };
  /** Names an expression reads */
  const namesIn = (e: Expr, out: Set<Decl | undefined> = new Set()): Set<Decl | undefined> => {
    const x = unwrap(e);
    if (x.kind === "Name") out.add(scopes.of(x));
    else if (x.kind === "Member") namesIn(x.object, out);
    else if (x.kind === "Index") {
      namesIn(x.object, out);
      namesIn(x.key, out);
    } else if (x.kind === "Call") {
      namesIn(x.callee, out);
      x.args.forEach((a) => namesIn(a, out));
    } else if (x.kind === "Binary") {
      namesIn(x.left, out);
      namesIn(x.right, out);
    } else if (x.kind === "Unary") namesIn(x.operand, out);
    return out;
  };
  /**
   * `if item == wanted then table.remove(t, i)`: the element equal to a value from outside the
   * loop, removed to drop the one match. Skipping the element after it matters only when two equal
   * ones sit side by side
   */
  const removesTheMatch = (conds: Expr[], loopVars: (Decl | undefined)[]): boolean =>
    conds.some((c) => {
      const x = unwrap(c);
      if (x.kind !== "Binary" || x.op !== "==") return false;
      const l = namesIn(x.left);
      const r = namesIn(x.right);
      const uses = (set: Set<Decl | undefined>) => loopVars.some((v) => v && set.has(v));
      return (uses(l) && !uses(r)) || (uses(r) && !uses(l));
    });
  /** A break, return or continue later in the same block: the loop leaves (or moves on) right after */
  const leavesAfter = (b: Block, i: number) => b.body.slice(i + 1).some((x) => x.kind === "Break" || x.kind === "Return");
  /** `table.remove(T, X)` as a statement */
  const removeOf = (st: Stat) => {
    if (st.kind !== "CallStat") return null;
    const c = unwrap(st.call);
    return isCallTo(c, "table", "remove") && c.args.length === 2 ? { table: c.args[0], index: c.args[1] } : null;
  };
  /** Locals some forward loop fills with its own index, in order: `table.insert(L, i)` */
  const ascendingLists = new Set<Decl>();
  /** Locals some code sorts (`table.sort(L, ...)`): their order is not the loop's any more */
  const sortedLists = new Set<Decl>();
  const checkLoop = (st: Stat) => {
    const loop = forwardLoop(st);
    if (!loop || (st.kind !== "NumericFor" && st.kind !== "GenericFor")) return;
    walkBlock(st.body, (x, block, i, conds) => {
      // a list filled in ascending order from this loop's index
      if (x.kind === "CallStat") {
        const c = unwrap(x.call);
        if (isCallTo(c, "table", "insert") && c.args.length === 2 && loop.index && declOf(c.args[1]) === loop.index) {
          const list = declOf(c.args[0]);
          if (list) ascendingLists.add(list);
        }
      }
      const r = removeOf(x);
      if (!r || leavesAfter(block, i) || removesTheMatch(conds, [loop.index, loop.value])) return;
      if (collecting) return;
      if (plain(r.table) && text(unwrap(r.table)) === loop.table && rootDecl(r.table) === loop.root && loop.index && declOf(r.index) === loop.index) {
        report(x.start, "remove-in-loop", `table.remove(${loop.table}, ...) while this loop walks ${loop.table} forward: each removal shifts the next element into this index, and the loop skips it (walk it backwards: for i = #${loop.table}, 1, -1)`);
      }
    });
  };
  const checkRemoveByList = (st: Stat) => {
    const loop = forwardLoop(st);
    if (!loop || st.kind !== "GenericFor" || !loop.value) return;
    const list = st.exprs[0] && declOf(st.exprs[0].kind === "Call" ? (st.exprs[0] as Extract<Expr, { kind: "Call" }>).args[0] ?? st.exprs[0] : st.exprs[0]);
    if (collecting || !list || !ascendingLists.has(list) || sortedLists.has(list)) return;
    walkBlock(st.body, (x, block, i) => {
      const r = removeOf(x);
      if (!r || leavesAfter(block, i) || declOf(r.index) !== loop.value || text(unwrap(r.table)) === loop.table) return;
      report(x.start, "remove-in-loop", `removes the indexes in ${loop.table} from ${text(unwrap(r.table))} in ascending order: each removal shifts the ones after it, so the later indexes point one element too far (remove from the highest index down, or rebuild the list)`);
    });
  };

  // ---- connect-in-handler

  const CONNECTS = new Set(["Connect", "ConnectParallel"]);
  /**
   * The name a chain starts at (`player.Chatted` -> player), through lookups only
   * (`game:GetService("X").Remote`): a chain through any other call (`template:Clone().Touched`,
   * `getSignal().Event`) reaches an object the call made or chose, not the name's own
   */
  const LOOKUP_CALLS = new Set(["GetService", "WaitForChild", "FindFirstChild", "FindFirstChildOfClass", "FindFirstChildWhichIsA", "FindFirstAncestor"]);
  const rootName = (e: Expr): NameExpr | null => {
    let x = unwrap(e);
    while (x.kind === "Member" || x.kind === "Index" || x.kind === "Call") {
      if (x.kind === "Call" && !(x.method && LOOKUP_CALLS.has(x.method.name))) return null;
      x = unwrap(x.kind === "Call" ? x.callee : x.object);
    }
    return x.kind === "Name" ? x : null;
  };
  const within = (at: number, f: FunctionExpr) => at >= f.start && at < f.end;
  /** Declared in the handler, or given a new value there (`exit = template:Clone()`): a new object each run */
  const madeIn = (d: Decl | undefined, f: FunctionExpr) => !!d && (within(d.at, f) || d.assigned.some((v) => v && within(v.start, f)));
  /** Inside a handler: Connect statements on something declared outside it, the connection dropped */
  const checkHandler = (handler: FunctionExpr, outer: string) => {
    // a handler that disconnects a connection kept outside it (its own, `con:Disconnect()`) runs a bounded number of times
    let disconnects = false;
    walkBlock(handler.body, (x) => {
      if (x.kind !== "CallStat") return;
      const c = unwrap(x.call);
      if (c.kind === "Call" && c.method?.name === "Disconnect" && c.callee.kind === "Name" && !madeIn(scopes.of(c.callee), handler)) disconnects = true;
    });
    if (disconnects) return;
    walkBlock(handler.body, (x) => {
      if (x.kind !== "CallStat") return;
      const c = unwrap(x.call);
      if (c.kind !== "Call" || !c.method || !CONNECTS.has(c.method.name)) return;
      const root = rootName(c.callee);
      if (!root) return;
      const d = scopes.of(root);
      // made in this run of the handler (a parameter, a local, a clone): a new object each time
      if (madeIn(d, handler)) return;
      // a global service, or a local of the module: it outlives every run
      const event = text(c.callee);
      report(c.method.start, "connect-in-handler", `${event}:${c.method.name}() runs every time ${outer} fires, and ${root.name} outlives it: the handlers pile up, one more per run (connect once outside, keep the connection to disconnect it, or use :Once())`);
    });
  };

  // ---- field-typo

  const checkRecords = (t: Extract<Expr, { kind: "Table" }>) => {
    const records = t.fields.map((f) => (f.kind === "Item" || f.kind === "Named" || f.kind === "Keyed" ? unwrap(f.value) : null)).filter((v): v is Extract<Expr, { kind: "Table" }> => v?.kind === "Table" && v.fields.length > 0 && v.fields.every((x) => x.kind === "Named"));
    if (records.length < 5 || records.length < t.fields.length * 0.9) return;
    const names = records.map((r) => new Set(r.fields.map((f) => (f.kind === "Named" ? f.name.name : ""))));
    const count = new Map<string, number>();
    for (const n of names) for (const k of n) count.set(k, (count.get(k) ?? 0) + 1);
    records.forEach((r, i) => {
      const missing = [...count].filter(([k, c]) => c === records.length - 1 && !names[i].has(k)).map(([k]) => k);
      for (const f of r.fields) {
        if (f.kind !== "Named" || count.get(f.name.name) !== 1) continue;
        const meant = missing.filter((m) => distance(m.toLowerCase(), f.name.name.toLowerCase()) <= 2);
        if (meant.length === 1) report(f.name.start, "field-typo", `\`${f.name.name}\` is in this entry only, and it is the one entry without \`${meant[0]}\`, which the other ${records.length - 1} have`);
      }
    });
  };

  // ---- the walk

  const expr = (e: Expr): void => {
    switch (e.kind) {
      case "Call":
        expr(e.callee);
        e.args.forEach(expr);
        if (e.method && CONNECTS.has(e.method.name) && e.args[0] && unwrap(e.args[0]).kind === "Function") checkHandler(unwrap(e.args[0]) as FunctionExpr, text(e.callee));
        return;
      case "Member":
        expr(e.object);
        return;
      case "Index":
        expr(e.object);
        expr(e.key);
        return;
      case "Function":
        block(e.body);
        return;
      case "Table":
        checkRecords(e);
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
  const stat = (st: Stat): void => {
    if (collecting && st.kind === "CallStat") {
      const c = unwrap(st.call);
      if (isCallTo(c, "table", "sort") && c.args[0]) {
        const list = declOf(c.args[0]);
        if (list) sortedLists.add(list);
      }
    }
    checkLoop(st);
    checkRemoveByList(st);
    switch (st.kind) {
      case "Local":
        st.values.forEach(expr);
        return;
      case "LocalFunction":
        block(st.func.body);
        return;
      case "Function":
        expr(st.target);
        block(st.func.body);
        return;
      case "Assign":
        st.values.forEach(expr);
        st.targets.forEach(expr);
        return;
      case "CompoundAssign":
        expr(st.target);
        expr(st.value);
        return;
      case "CallStat":
        expr(st.call);
        return;
      case "If":
        for (const c of st.clauses) {
          expr(c.cond);
          block(c.body);
        }
        if (st.orelse) block(st.orelse);
        return;
      case "While":
      case "Repeat":
        expr(st.cond);
        block(st.body);
        return;
      case "NumericFor":
        expr(st.from);
        expr(st.to);
        if (st.step) expr(st.step);
        block(st.body);
        return;
      case "GenericFor":
        st.exprs.forEach(expr);
        block(st.body);
        return;
      case "Do":
        block(st.body);
        return;
      case "Return":
        st.values.forEach(expr);
        return;
      default:
        return;
    }
  };
  const block = (b: Block) => b.body.forEach(stat);
  block(chunk);
  collecting = false;
  block(chunk);
  return out;
}

/** The blocks directly inside a statement (an if's branches, a loop's body), not the functions it defines */
function innerBlocks(st: Stat): Block[] {
  switch (st.kind) {
    case "If":
      return [...st.clauses.map((c) => c.body), ...(st.orelse ? [st.orelse] : [])];
    case "While":
    case "Repeat":
    case "NumericFor":
    case "GenericFor":
    case "Do":
      return [st.body];
    default:
      return [];
  }
}

/** Edit distance, capped */
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
