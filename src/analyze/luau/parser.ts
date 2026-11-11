import type { Binding, Block, Chunk, Expr, FunctionExpr, Stat, TableField } from "./ast.js";
import { Lexer, LuauSyntaxError, type Token } from "./lexer.js";

/**
 * A recursive-descent parser for Luau as Roblox runs it (the grammar of luau-lang.org/grammar,
 * with types, attributes, interpolated strings, `continue`, compound assignment, if-expressions
 * and type functions). It stops at the first error, as Roblox does: a file that does not parse
 * does not load. The error names the line of the construct left open (a missing `end`).
 *
 *   parseLuau(src) -> Chunk, or throws LuauSyntaxError
 */

const BINARY: Record<string, [number, number]> = {
  "+": [6, 6], "-": [6, 6], "*": [7, 7], "/": [7, 7], "//": [7, 7], "%": [7, 7], "^": [10, 9], "..": [5, 4],
  "==": [3, 3], "~=": [3, 3], "<": [3, 3], "<=": [3, 3], ">": [3, 3], ">=": [3, 3], and: [2, 2], or: [1, 1],
};
const UNARY_PRIORITY = 8;
const COMPOUND = new Set(["+=", "-=", "*=", "/=", "//=", "%=", "^=", "..="]);
const BLOCK_END = new Set(["end", "else", "elseif", "until"]);

export function parseLuau(src: string): Chunk {
  return new Parser(src).chunk();
}

const describe = (t: Token) => (t.kind === "eof" ? "<eof>" : `'${t.value}'`);

class Parser {
  private lexer: Lexer;
  private buf: Token[] = [];
  /** The last token taken, for the end of a node */
  private prevEnd = 0;
  /** Whether each function being parsed takes `...` (the chunk itself does) */
  private varargs: boolean[] = [true];
  /** Loops open around the statement being parsed, per function (break and continue need one) */
  private loops: number[] = [0];

  constructor(private src: string) {
    this.lexer = new Lexer(src);
  }

  // ---- tokens

  private peek(k = 0): Token {
    while (this.buf.length <= k) this.buf.push(this.lexer.next());
    return this.buf[k];
  }

  private get tok(): Token {
    return this.peek(0);
  }

  private take(): Token {
    const t = this.peek(0);
    this.buf.shift();
    this.prevEnd = t.end;
    return t;
  }

  private is(value: string, k = 0): boolean {
    const t = this.peek(k);
    return (t.kind === "symbol" || t.kind === "keyword") && t.value === value;
  }

  private isName(value?: string, k = 0): boolean {
    const t = this.peek(k);
    return t.kind === "name" && (value === undefined || t.value === value);
  }

  private accept(value: string): boolean {
    if (!this.is(value)) return false;
    this.take();
    return true;
  }

  private expect(value: string, what?: string): Token {
    if (this.is(value)) return this.take();
    throw new LuauSyntaxError(`Expected '${value}'${what ? ` ${what}` : ""}, got ${describe(this.tok)}`, this.tok.start);
  }

  /** The closing word of a construct opened at `opened` ("to close 'function' at line 12") */
  private close(value: string, opener: string, opened: number): void {
    if (this.is(value)) {
      this.take();
      return;
    }
    throw new LuauSyntaxError(`Expected '${value}' (to close '${opener}' at line ${this.lineOf(opened)}), got ${describe(this.tok)}`, this.tok.start, opened);
  }

  private name(what = "identifier"): Binding {
    const t = this.tok;
    if (t.kind !== "name") throw new LuauSyntaxError(`Expected ${what} when parsing, got ${describe(t)}`, t.start);
    this.take();
    return { name: t.value, start: t.start, end: t.end };
  }

  private lineOf(at: number): number {
    let line = 1;
    for (let i = this.src.indexOf("\n"); i >= 0 && i < at; i = this.src.indexOf("\n", i + 1)) line++;
    return line;
  }

  // ---- blocks and statements

  chunk(): Chunk {
    const block = this.block();
    if (this.tok.kind !== "eof") throw new LuauSyntaxError(`Expected <eof>, got ${describe(this.tok)}`, this.tok.start);
    return { ...block, src: this.src };
  }

  private blockEnds(): boolean {
    const t = this.tok;
    return t.kind === "eof" || (t.kind === "keyword" && BLOCK_END.has(t.value));
  }

  private block(): Block {
    const start = this.tok.start;
    const body: Stat[] = [];
    while (!this.blockEnds()) {
      if (this.accept(";")) continue;
      const stat = this.statement();
      body.push(stat);
      if (stat.kind === "Return") {
        this.accept(";");
        // nothing may follow a return in its block
        if (!this.blockEnds()) throw new LuauSyntaxError(`Expected <eof>, got ${describe(this.tok)}`, this.tok.start);
        break;
      }
    }
    return { start, end: this.prevEnd, body };
  }

  private statement(): Stat {
    const t = this.tok;
    const start = t.start;
    if (t.kind === "keyword") {
      switch (t.value) {
        case "if":
          return this.ifStat();
        case "while": {
          this.take();
          const cond = this.expr();
          this.expect("do");
          const body = this.loopBody();
          this.close("end", "while", start);
          return { kind: "While", cond, body, start, end: this.prevEnd };
        }
        case "do": {
          this.take();
          const body = this.block();
          this.close("end", "do", start);
          return { kind: "Do", body, start, end: this.prevEnd };
        }
        case "for":
          return this.forStat();
        case "repeat": {
          this.take();
          const body = this.loopBody();
          this.close("until", "repeat", start);
          const cond = this.expr();
          return { kind: "Repeat", body, cond, start, end: this.prevEnd };
        }
        case "function": {
          this.take();
          let target: Expr = this.nameExpr();
          while (this.is(".")) {
            this.take();
            const name = this.name();
            target = { kind: "Member", object: target, name, start, end: name.end };
          }
          let method = false;
          if (this.accept(":")) {
            const name = this.name();
            target = { kind: "Member", object: target, name, start, end: name.end };
            method = true;
          }
          const func = this.funcBody(start, method ? { name: "self", start: target.start, end: target.end } : undefined);
          return { kind: "Function", target, func, start, end: this.prevEnd };
        }
        case "local":
          return this.localStat();
        case "return": {
          this.take();
          const values = this.blockEnds() || this.is(";") ? [] : this.exprList();
          return { kind: "Return", values, start, end: this.prevEnd };
        }
        case "break":
          if (!this.loops[this.loops.length - 1]) throw new LuauSyntaxError("break statement must be inside a loop", t.start);
          this.take();
          return { kind: "Break", start, end: this.prevEnd };
      }
    }
    if (t.kind === "symbol" && t.value === "@") {
      this.attributes();
      if (!this.is("function") && !(this.is("local") && this.is("function", 1))) {
        throw new LuauSyntaxError(`Expected 'function' after an attribute, got ${describe(this.tok)}`, this.tok.start);
      }
      return this.statement();
    }
    if (t.kind === "name") {
      if (t.value === "continue" && !this.continuesExpr(1)) {
        if (!this.loops[this.loops.length - 1]) throw new LuauSyntaxError("continue statement must be inside a loop", t.start);
        this.take();
        return { kind: "Continue", start, end: this.prevEnd };
      }
      // `const function f()`: a local function that cannot be assigned again
      if (t.value === "const" && this.is("function", 1)) return this.localStat();
      // `const x = 1`: a local that cannot be assigned again (Luau, 2025)
      if (t.value === "const" && this.isName(undefined, 1)) {
        this.take();
        const names = [this.typedName()];
        while (this.accept(",")) names.push(this.typedName());
        this.expect("=", "after a const declaration");
        const values = this.exprList();
        return { kind: "Local", names, values, start, end: this.prevEnd };
      }
      if (t.value === "export" && this.isName("type", 1)) {
        this.take();
        return this.typeAlias(start, true);
      }
      if (t.value === "type" && (this.isName(undefined, 1) || this.is("function", 1))) return this.typeAlias(start, false);
    }
    return this.exprStat();
  }

  /** Whether the token at `k` would go on an expression (so `continue` there is a variable) */
  private continuesExpr(k: number): boolean {
    const t = this.peek(k);
    if (t.kind === "string" || t.kind === "interp" || t.kind === "interpBegin") return true;
    return t.kind === "symbol" && ["(", ".", "[", ":", "=", ",", "{", ...COMPOUND].includes(t.value);
  }

  private attributes(): void {
    while (this.accept("@")) {
      if (this.is("[")) {
        // @[name{...}, other]: skip to the matching bracket
        let depth = 0;
        do {
          if (this.is("[")) depth++;
          else if (this.is("]")) depth--;
          if (this.tok.kind === "eof") throw new LuauSyntaxError("Expected ']' to close the attribute list, got <eof>", this.tok.start);
          this.take();
        } while (depth > 0);
      } else this.name("an attribute name");
    }
  }

  private loopBody(): Block {
    this.loops[this.loops.length - 1]++;
    const body = this.block();
    this.loops[this.loops.length - 1]--;
    return body;
  }

  private ifStat(): Stat {
    const start = this.tok.start;
    this.take();
    const clauses: { cond: Expr; body: Block }[] = [];
    let cond = this.expr();
    this.expect("then");
    clauses.push({ cond, body: this.block() });
    let orelse: Block | undefined;
    for (;;) {
      if (this.is("elseif")) {
        this.take();
        cond = this.expr();
        this.expect("then");
        clauses.push({ cond, body: this.block() });
        continue;
      }
      if (this.accept("else")) orelse = this.block();
      break;
    }
    this.close("end", "if", start);
    return { kind: "If", clauses, orelse, start, end: this.prevEnd };
  }

  private forStat(): Stat {
    const start = this.tok.start;
    this.take();
    const first = this.typedName();
    if (this.accept("=")) {
      const from = this.expr();
      this.expect(",");
      const to = this.expr();
      const step = this.accept(",") ? this.expr() : undefined;
      this.expect("do");
      const body = this.loopBody();
      this.close("end", "for", start);
      return { kind: "NumericFor", var: first, from, to, step, body, start, end: this.prevEnd };
    }
    const vars = [first];
    while (this.accept(",")) vars.push(this.typedName());
    this.expect("in");
    const exprs = this.exprList();
    this.expect("do");
    const body = this.loopBody();
    this.close("end", "for", start);
    return { kind: "GenericFor", vars, exprs, body, start, end: this.prevEnd };
  }

  private localStat(): Stat {
    const start = this.tok.start;
    this.take();
    if (this.accept("function")) {
      const name = this.name();
      const func = this.funcBody(start);
      return { kind: "LocalFunction", name, func, start, end: this.prevEnd };
    }
    const names = [this.typedName()];
    while (this.accept(",")) names.push(this.typedName());
    const values = this.accept("=") ? this.exprList() : [];
    return { kind: "Local", names, values, start, end: this.prevEnd };
  }

  /** `name` or `name: Type` */
  private typedName(): Binding {
    const b = this.name();
    if (this.accept(":")) this.type();
    return b;
  }

  private typeAlias(start: number, exported: boolean): Stat {
    this.take(); // `type`
    if (this.accept("function")) {
      // a type function runs at type-check time: parsed, never analyzed as game code
      const name = this.name();
      this.funcBody(start);
      return { kind: "TypeAlias", name, exported, start, end: this.prevEnd };
    }
    const name = this.name();
    if (this.is("<")) this.genericDecls(true);
    this.expect("=");
    this.type();
    return { kind: "TypeAlias", name, exported, start, end: this.prevEnd };
  }

  private exprStat(): Stat {
    const start = this.tok.start;
    const first = this.primaryExpr();
    if (this.is("=") || this.is(",")) {
      const targets = [first];
      while (this.accept(",")) targets.push(this.primaryExpr());
      for (const t of targets) this.assignable(t);
      this.expect("=");
      const values = this.exprList();
      return { kind: "Assign", targets, values, start, end: this.prevEnd };
    }
    if (this.tok.kind === "symbol" && COMPOUND.has(this.tok.value)) {
      this.assignable(first);
      const op = this.take().value;
      const value = this.expr();
      return { kind: "CompoundAssign", op, target: first, value, start, end: this.prevEnd };
    }
    if (first.kind !== "Call") throw new LuauSyntaxError("Incomplete statement: expected assignment or a function call", this.tok.start);
    return { kind: "CallStat", call: first, start, end: this.prevEnd };
  }

  private assignable(e: Expr): void {
    if (e.kind !== "Name" && e.kind !== "Member" && e.kind !== "Index") throw new LuauSyntaxError("Assigned expression must be a variable or a field", e.start);
  }

  // ---- functions

  /** `<T>(params): Ret body end`, after `function name` */
  private funcBody(opened: number, self?: Binding): FunctionExpr {
    const start = this.tok.start;
    if (this.is("<")) this.genericDecls(false);
    this.expect("(", "when parsing function");
    const params: Binding[] = [];
    let vararg = false;
    if (!this.is(")")) {
      for (;;) {
        if (this.accept("...")) {
          vararg = true;
          if (this.accept(":")) this.typeOrPack();
          break;
        }
        params.push(this.typedName());
        if (!this.accept(",")) break;
      }
    }
    this.expect(")", "to close the parameter list");
    if (this.accept(":")) this.returnType();
    this.varargs.push(vararg);
    this.loops.push(0);
    const body = this.block();
    this.loops.pop();
    this.varargs.pop();
    this.close("end", "function", opened);
    return { kind: "Function", params, vararg, self, body, start, end: this.prevEnd };
  }

  // ---- expressions

  private exprList(): Expr[] {
    const list = [this.expr()];
    while (this.accept(",")) list.push(this.expr());
    return list;
  }

  expr(limit = 0): Expr {
    const start = this.tok.start;
    let left: Expr;
    const t = this.tok;
    if ((t.kind === "keyword" && t.value === "not") || (t.kind === "symbol" && (t.value === "-" || t.value === "#"))) {
      this.take();
      const operand = this.expr(UNARY_PRIORITY);
      left = { kind: "Unary", op: t.value, operand, start, end: this.prevEnd };
    } else left = this.simpleExpr();
    for (;;) {
      const op = this.tok;
      const prio = (op.kind === "symbol" || op.kind === "keyword") && Object.hasOwn(BINARY, op.value) ? BINARY[op.value] : undefined;
      if (!prio || prio[0] <= limit) return left;
      this.take();
      const right = this.expr(prio[1]);
      left = { kind: "Binary", op: op.value, left, right, start, end: this.prevEnd };
    }
  }

  private simpleExpr(): Expr {
    const t = this.tok;
    const start = t.start;
    let e: Expr;
    if (t.kind === "number") {
      this.take();
      e = { kind: "Number", raw: t.value, value: Number(t.value.replace(/_/g, "")), start, end: t.end };
    } else if (t.kind === "string") {
      this.take();
      e = { kind: "String", raw: t.value, ...stringOf(t.value), start, end: t.end };
    } else if (t.kind === "interp" || t.kind === "interpBegin") {
      e = this.interp();
    } else if (t.kind === "keyword" && t.value === "nil") {
      this.take();
      e = { kind: "Nil", start, end: t.end };
    } else if (t.kind === "keyword" && (t.value === "true" || t.value === "false")) {
      this.take();
      e = { kind: "Boolean", value: t.value === "true", start, end: t.end };
    } else if (this.is("...")) {
      if (!this.varargs[this.varargs.length - 1]) throw new LuauSyntaxError("Cannot use '...' outside of a vararg function", t.start);
      this.take();
      e = { kind: "Vararg", start, end: t.end };
    } else if (this.is("{")) {
      e = this.table();
    } else if (this.is("function")) {
      this.take();
      e = this.funcBody(start);
    } else if (this.is("@")) {
      this.attributes();
      if (!this.is("function")) throw new LuauSyntaxError(`Expected 'function' after an attribute, got ${describe(this.tok)}`, this.tok.start);
      this.take();
      e = this.funcBody(start);
    } else if (this.is("if")) {
      e = this.ifElseExpr();
    } else {
      e = this.primaryExpr();
    }
    while (this.accept("::")) {
      this.type();
      e = { kind: "Cast", expr: e, start, end: this.prevEnd };
    }
    return e;
  }

  private interp(): Expr {
    const start = this.tok.start;
    const parts: Expr[] = [];
    if (this.tok.kind === "interp") {
      this.take();
      return { kind: "Interp", parts, start, end: this.prevEnd };
    }
    this.take(); // interpBegin
    for (;;) {
      if (this.tok.kind === "interpEnd" || this.tok.kind === "interpMid") throw new LuauSyntaxError("Malformed interpolated string: expected an expression inside '{}'", this.tok.start);
      parts.push(this.expr());
      const t = this.tok;
      if (t.kind === "interpEnd") {
        this.take();
        return { kind: "Interp", parts, start, end: this.prevEnd };
      }
      if (t.kind === "interpMid") {
        this.take();
        continue;
      }
      throw new LuauSyntaxError(`Malformed interpolated string: expected '}' after the expression, got ${describe(t)}`, t.start, start);
    }
  }

  private ifElseExpr(): Expr {
    const start = this.tok.start;
    this.take();
    const clauses: { cond: Expr; value: Expr }[] = [];
    let cond = this.expr();
    this.expect("then");
    clauses.push({ cond, value: this.expr() });
    while (this.is("elseif")) {
      this.take();
      cond = this.expr();
      this.expect("then");
      clauses.push({ cond, value: this.expr() });
    }
    this.expect("else", "in an if-then-else expression");
    const orelse = this.expr();
    return { kind: "IfElse", clauses, orelse, start, end: this.prevEnd };
  }

  private nameExpr(): Expr {
    const b = this.name();
    return { kind: "Name", name: b.name, start: b.start, end: b.end };
  }

  private primaryExpr(): Expr {
    const start = this.tok.start;
    let e: Expr;
    if (this.is("(")) {
      this.take();
      const inner = this.expr();
      this.close(")", "(", start);
      e = { kind: "Paren", expr: inner, start, end: this.prevEnd };
    } else if (this.tok.kind === "name") {
      e = this.nameExpr();
    } else {
      throw new LuauSyntaxError(`Expected identifier when parsing expression, got ${describe(this.tok)}`, this.tok.start);
    }
    for (;;) {
      const t = this.tok;
      if (this.is(".")) {
        this.take();
        const name = this.name();
        e = { kind: "Member", object: e, name, start, end: name.end };
      } else if (this.is("[")) {
        this.take();
        const key = this.expr();
        this.expect("]");
        e = { kind: "Index", object: e, key, start, end: this.prevEnd };
      } else if (this.is("<") && this.is("<", 1)) {
        // `f<<T>>(x)`: type arguments given explicitly, checked and dropped
        this.explicitTypeArgs();
        e = { ...e, end: this.prevEnd };
      } else if (this.is(":")) {
        this.take();
        const method = this.name("a method name");
        if (this.is("<") && this.is("<", 1)) this.explicitTypeArgs();
        const args = this.callArgs();
        e = { kind: "Call", callee: e, method, args, start, end: this.prevEnd };
      } else if (this.is("(") || this.is("{") || t.kind === "string" || t.kind === "interp" || t.kind === "interpBegin") {
        const args = this.callArgs();
        e = { kind: "Call", callee: e, args, start, end: this.prevEnd };
      } else return e;
    }
  }

  private callArgs(): Expr[] {
    const t = this.tok;
    if (t.kind === "string") {
      this.take();
      return [{ kind: "String", raw: t.value, ...stringOf(t.value), start: t.start, end: t.end }];
    }
    if (t.kind === "interp" || t.kind === "interpBegin") return [this.interp()];
    if (this.is("{")) return [this.table()];
    const open = this.expect("(", "when parsing function call").start;
    const args = this.is(")") ? [] : this.exprList();
    this.close(")", "(", open);
    return args;
  }

  private table(): Expr {
    const start = this.tok.start;
    this.take();
    const fields: TableField[] = [];
    while (!this.is("}")) {
      const fs = this.tok.start;
      if (this.is("[")) {
        this.take();
        const key = this.expr();
        this.expect("]");
        this.expect("=");
        const value = this.expr();
        fields.push({ kind: "Keyed", key, value, start: fs, end: this.prevEnd });
      } else if (this.tok.kind === "name" && this.is("=", 1)) {
        const name = this.name();
        this.take();
        const value = this.expr();
        fields.push({ kind: "Named", name, value, start: fs, end: this.prevEnd });
      } else {
        const value = this.expr();
        fields.push({ kind: "Item", value, start: fs, end: this.prevEnd });
      }
      if (!this.accept(",") && !this.accept(";")) break;
    }
    this.close("}", "{", start);
    return { kind: "Table", fields, start, end: this.prevEnd };
  }

  // ---- types: checked for syntax, then dropped

  /** `<T, U...>` on a function or an alias; an alias's may have defaults */
  private genericDecls(defaults: boolean): void {
    const open = this.expect("<").start;
    while (!this.is(">")) {
      this.name("a generic name");
      this.accept("...");
      if (defaults && this.accept("=")) this.typeOrPack();
      if (!this.accept(",")) break;
    }
    this.close(">", "<", open);
  }

  private returnType(): void {
    this.typeOrPack();
  }

  /** A type, or a type pack (`...T`, `(A, B)`, `T...`) where a pack is allowed */
  private typeOrPack(): void {
    if (this.accept("...")) {
      this.type();
      return;
    }
    this.type();
  }

  type(): void {
    if (this.is("|") || this.is("&")) this.take();
    this.typeWithSuffix();
    while (this.is("|") || this.is("&")) {
      this.take();
      this.typeWithSuffix();
    }
  }

  private typeWithSuffix(): void {
    this.simpleType();
    while (this.accept("?"));
  }

  private simpleType(): void {
    const t = this.tok;
    if (t.kind === "string" || (t.kind === "keyword" && (t.value === "nil" || t.value === "true" || t.value === "false"))) {
      this.take();
      return;
    }
    if (t.kind === "name") {
      if (t.value === "typeof" && this.is("(", 1)) {
        this.take();
        const open = this.take().start;
        this.expr();
        this.close(")", "(", open);
        return;
      }
      this.take();
      if (this.is(".") && this.peek(1).kind === "name") {
        this.take();
        this.take();
      }
      if (this.accept("...")) return; // a generic pack: T...
      if (this.is("<")) this.typeArgs();
      return;
    }
    if (this.is("{")) {
      this.tableType();
      return;
    }
    if (this.is("<")) {
      // a generic function type
      this.genericDecls(false);
      this.functionTypeTail();
      return;
    }
    if (this.is("(")) {
      this.functionTypeTail(true);
      return;
    }
    if (this.is("...")) {
      this.take();
      this.type();
      return;
    }
    throw new LuauSyntaxError(`Expected type, got ${describe(t)}`, t.start);
  }

  /** `(A, b: B, ...C) -> R`; with `maybeParen`, `(T)` alone is a parenthesized type or pack */
  private functionTypeTail(maybeParen = false): void {
    const open = this.expect("(").start;
    while (!this.is(")")) {
      if (this.accept("...")) this.type();
      else {
        if (this.tok.kind === "name" && this.is(":", 1)) {
          this.take();
          this.take();
        }
        this.type();
      }
      if (!this.accept(",")) break;
    }
    this.close(")", "(", open);
    if (this.accept("->")) {
      this.typeOrPack();
      return;
    }
    if (!maybeParen) throw new LuauSyntaxError(`Expected '->' when parsing function type, got ${describe(this.tok)}`, this.tok.start);
  }

  /** `<<number, string>>` after a function or method name (Luau's explicit instantiation) */
  private explicitTypeArgs(): void {
    const open = this.tok.start;
    this.take();
    this.take();
    while (!this.is(">")) {
      this.typeOrPack();
      if (!this.accept(",")) break;
    }
    this.close(">", "<<", open);
    this.close(">", "<<", open);
  }

  private typeArgs(): void {
    const open = this.expect("<").start;
    while (!this.is(">")) {
      this.typeOrPack();
      if (!this.accept(",")) break;
    }
    this.close(">", "<", open);
  }

  private tableType(): void {
    const open = this.expect("{").start;
    if (this.accept("}")) return;
    // `{ T }`: an array type
    const isProp = () => this.is("[") || (this.tok.kind === "name" && this.is(":", 1)) || ((this.isName("read") || this.isName("write")) && this.peek(1).kind === "name" && this.is(":", 2)) || ((this.isName("read") || this.isName("write")) && this.is("[", 1));
    if (!isProp()) {
      this.type();
      this.close("}", "{", open);
      return;
    }
    while (!this.is("}")) {
      if ((this.isName("read") || this.isName("write")) && (this.is("[", 1) || (this.peek(1).kind === "name" && this.is(":", 2)))) this.take();
      if (this.accept("[")) {
        if (this.tok.kind === "string") this.take();
        else this.type();
        this.expect("]");
        this.expect(":");
        this.type();
      } else {
        this.name("a table type field");
        this.expect(":");
        this.type();
      }
      if (!this.accept(",") && !this.accept(";")) break;
    }
    this.close("}", "{", open);
  }
}

/** A string token's value: quotes and escapes resolved, a long string's brackets dropped */
export function stringValue(raw: string): string {
  return stringBytes(raw).toString("utf8");
}

/** A string token's value read as UTF-8, and as its bytes (one char each) to compare with */
export function stringOf(raw: string): { value: string; bytes: string } {
  const b = stringBytes(raw);
  return { value: b.toString("utf8"), bytes: b.toString("latin1") };
}

/** A Luau string is bytes: `\195\169` and `é` are the same string, `\255` and `\254` are not */
function stringBytes(raw: string): Buffer {
  if (raw.startsWith("[")) {
    const level = raw.indexOf("[", 1) - 1;
    let body = raw.slice(level + 2, raw.length - level - 2);
    if (body.startsWith("\r\n")) body = body.slice(2);
    else if (body.startsWith("\n")) body = body.slice(1);
    return Buffer.from(body, "utf8");
  }
  const body = raw.slice(1, -1);
  if (!body.includes("\\")) return Buffer.from(body, "utf8");
  const bytes: number[] = [];
  const text = (s: string) => bytes.push(...Buffer.from(s, "utf8"));
  let last = 0;
  for (const m of body.matchAll(/\\(?:(\d{1,3})|x([0-9a-fA-F]{2})|u\{([0-9a-fA-F]+)\}|z\s*|(\r\n|[\s\S]))/g)) {
    text(body.slice(last, m.index));
    last = m.index + m[0].length;
    const [, dec, hex, uni, ch] = m;
    if (dec !== undefined) bytes.push(Number(dec));
    else if (hex !== undefined) bytes.push(parseInt(hex, 16));
    else if (uni !== undefined) text(String.fromCodePoint(parseInt(uni, 16)));
    else if (ch !== undefined) text(({ n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", f: "\f", v: "\v" } as Record<string, string>)[ch] ?? (ch === "\r\n" ? "\n" : ch));
  }
  text(body.slice(last));
  return Buffer.from(bytes);
}
