/**
 * Luau's tokens, from the source as Roblox runs it: long brackets, every string escape,
 * interpolated strings (`a {b} c`, lexed in pieces so the parser reads the code between braces),
 * numbers with `_`, `0x` and `0b`, and the operators Luau adds to Lua 5.1 (`//`, `+=`... `..=`,
 * `->`, `::`). A malformed token is a LuauSyntaxError at its own position.
 */

export type TokenKind =
  | "name"
  | "keyword"
  | "number"
  | "string"
  /** A whole interpolated string with no `{}` */
  | "interp"
  /** The text up to the first `{` of an interpolated string: code follows */
  | "interpBegin"
  /** `}text{` between two pieces of code */
  | "interpMid"
  /** `}text` up to the closing backtick */
  | "interpEnd"
  | "symbol"
  | "eof";

export interface Token {
  kind: TokenKind;
  /** The keyword, symbol or name itself; a string's or number's source text */
  value: string;
  start: number;
  end: number;
}

export class LuauSyntaxError extends Error {
  constructor(
    message: string,
    readonly at: number,
    /** Where the construct that is not closed opened (a missing `end`, `)`...) */
    readonly openedAt?: number,
  ) {
    super(message);
  }
}

export const KEYWORDS = new Set(["and", "break", "do", "else", "elseif", "end", "false", "for", "function", "if", "in", "local", "nil", "not", "or", "repeat", "return", "then", "true", "until", "while"]);

// longest first: the lexer takes the first that matches
const SYMBOLS = ["...", "..=", "//=", "==", "~=", "<=", ">=", "+=", "-=", "*=", "/=", "%=", "^=", "..", "::", "->", "//", "+", "-", "*", "/", "%", "^", "#", "&", "|", "?", "<", ">", "=", "(", ")", "{", "}", "[", "]", ";", ":", ",", ".", "@"];

const isDigit = (c: string) => c >= "0" && c <= "9";
const isIdStart = (c: string) => (c >= "a" && c <= "z") || (c >= "A" && c <= "Z") || c === "_";
const isId = (c: string) => isIdStart(c) || isDigit(c);

export class Lexer {
  private pos = 0;
  /** Open interpolated strings: the `{` depth inside each one's current code piece */
  private interp: number[] = [];

  constructor(readonly src: string) {}

  next(): Token {
    this.skipTrivia();
    const src = this.src;
    const start = this.pos;
    if (start >= src.length) return { kind: "eof", value: "", start, end: start };
    const c = src[start];
    if (isIdStart(c)) {
      let j = start + 1;
      while (j < src.length && isId(src[j])) j++;
      this.pos = j;
      const value = src.slice(start, j);
      return { kind: KEYWORDS.has(value) ? "keyword" : "name", value, start, end: j };
    }
    if (isDigit(c) || (c === "." && isDigit(src[start + 1] ?? ""))) return this.number();
    if (c === '"' || c === "'") return this.quoted(c);
    if (c === "`") return this.interpolated(start + 1, start, "interp", "interpBegin");
    if (c === "[") {
      const level = this.longOpen(start);
      if (level !== null) {
        const end = this.longClose(level, start + level + 2, start, "string");
        this.pos = end;
        return { kind: "string", value: src.slice(start, end), start, end };
      }
    }
    if (this.interp.length) {
      if (c === "{") this.interp[this.interp.length - 1]++;
      else if (c === "}") {
        if (this.interp[this.interp.length - 1] === 0) {
          this.interp.pop();
          return this.interpolated(start + 1, start, "interpEnd", "interpMid");
        }
        this.interp[this.interp.length - 1]--;
      }
    }
    for (const s of SYMBOLS) {
      if (src.startsWith(s, start)) {
        this.pos = start + s.length;
        return { kind: "symbol", value: s, start, end: this.pos };
      }
    }
    throw new LuauSyntaxError(`unexpected character ${JSON.stringify(c)}`, start);
  }

  private skipTrivia(): void {
    const src = this.src;
    for (;;) {
      const c = src[this.pos];
      if (c === " " || c === "\t" || c === "\r" || c === "\n" || c === "\f" || c === "\v") {
        this.pos++;
        continue;
      }
      if (c === "-" && src[this.pos + 1] === "-") {
        const level = src[this.pos + 2] === "[" ? this.longOpen(this.pos + 2) : null;
        if (level !== null) this.pos = this.longClose(level, this.pos + level + 4, this.pos, "comment");
        else {
          const nl = src.indexOf("\n", this.pos);
          this.pos = nl < 0 ? src.length : nl;
        }
        continue;
      }
      // a shebang on the first line
      if (this.pos === 0 && c === "#" && src[1] === "!") {
        const nl = src.indexOf("\n");
        this.pos = nl < 0 ? src.length : nl;
        continue;
      }
      return;
    }
  }

  /** `[`, `[=[`...: the level, or null when this `[` opens no long bracket */
  private longOpen(at: number): number | null {
    let k = at + 1;
    let level = 0;
    while (this.src[k] === "=") {
      level++;
      k++;
    }
    return this.src[k] === "[" ? level : null;
  }

  private longClose(level: number, from: number, opened: number, what: string): number {
    const close = "]" + "=".repeat(level) + "]";
    const end = this.src.indexOf(close, from);
    if (end < 0) throw new LuauSyntaxError(`unfinished long ${what}`, opened, opened);
    return end + close.length;
  }

  /** Like Luau's lexer: one run of digits, letters, `_` and `.` (and a sign after an exponent), then checked whole */
  private number(): Token {
    const src = this.src;
    const start = this.pos;
    const hex = src[start] === "0" && (src[start + 1] === "x" || src[start + 1] === "X");
    let j = start;
    while (j < src.length) {
      const c = src[j];
      if (isId(c) || c === ".") j++;
      else if ((c === "+" || c === "-") && !hex && (src[j - 1] === "e" || src[j - 1] === "E")) j++;
      else break;
    }
    const raw = src.slice(start, j);
    if (!/^(?:0[xX]_*[0-9a-fA-F][0-9a-fA-F_]*|0[bB]_*[01][01_]*|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)$/.test(raw)) {
      throw new LuauSyntaxError("Malformed number", start);
    }
    this.pos = j;
    return { kind: "number", value: raw, start, end: j };
  }

  /** An escape after `\` at `at`: where it ends, or an error for one Luau refuses */
  private escape(at: number): number {
    const src = this.src;
    const c = src[at + 1];
    if (c === undefined) throw new LuauSyntaxError("unfinished string", at);
    if ("abfnrtv\\\"'`{}\n".includes(c)) return at + 2;
    if (c === "\r") return src[at + 2] === "\n" ? at + 3 : at + 2;
    if (c === "z") {
      let k = at + 2;
      while (k < src.length && /\s/.test(src[k])) k++;
      return k;
    }
    if (isDigit(c)) {
      let k = at + 1;
      while (k < at + 4 && isDigit(src[k] ?? "")) k++;
      if (Number(src.slice(at + 1, k)) > 255) throw new LuauSyntaxError("invalid escape sequence: a decimal value above 255", at);
      return k;
    }
    if (c === "x") {
      if (!/^[0-9a-fA-F]{2}$/.test(src.slice(at + 2, at + 4))) throw new LuauSyntaxError("invalid escape sequence: \\x needs two hexadecimal digits", at);
      return at + 4;
    }
    if (c === "u") {
      const m = /^\{([0-9a-fA-F]+)\}/.exec(src.slice(at + 2, at + 14));
      if (!m || parseInt(m[1], 16) > 0x10ffff) throw new LuauSyntaxError("invalid escape sequence: \\u{...} needs a code point", at);
      return at + 2 + m[0].length;
    }
    // Luau keeps any other escaped character as itself ("\q" is "q"), measured with luau-lsp
    return at + 2;
  }

  private quoted(q: string): Token {
    const src = this.src;
    const start = this.pos;
    let j = start + 1;
    for (;;) {
      if (j >= src.length || src[j] === "\n" || src[j] === "\r") throw new LuauSyntaxError("unfinished string", start, start);
      if (src[j] === q) break;
      j = src[j] === "\\" ? this.escape(j) : j + 1;
    }
    this.pos = j + 1;
    return { kind: "string", value: src.slice(start, j + 1), start, end: j + 1 };
  }

  /** The text of an interpolated string from `from` up to its closing backtick or its next `{` */
  private interpolated(from: number, start: number, closed: TokenKind, open: TokenKind): Token {
    const src = this.src;
    let j = from;
    for (;;) {
      if (j >= src.length || src[j] === "\n") throw new LuauSyntaxError("unfinished interpolated string", start, start);
      const c = src[j];
      if (c === "`") {
        this.pos = j + 1;
        return { kind: closed, value: src.slice(start, j + 1), start, end: j + 1 };
      }
      if (c === "{") {
        if (src[j + 1] === "{") throw new LuauSyntaxError("Double braces are not permitted within interpolated strings; did you mean '\\{'?", j);
        this.interp.push(0);
        this.pos = j + 1;
        return { kind: open, value: src.slice(start, j + 1), start, end: j + 1 };
      }
      j = c === "\\" ? this.escape(j) : j + 1;
    }
  }
}
