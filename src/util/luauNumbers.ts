/**
 * Quack: whether two texts of a Luau script differ only in numbers, the balancer's case: he tunes
 * values in Studio and the sync writes them to disk. The idea comes from a script that guessed
 * the balancer's files by content: the Luau tokens, comments dropped and numbers masked, are the
 * same, and at least one number changed. Comments are free; a string counts as a number only when
 * its whole content is one (a BigNum like "1e30", or "2.54K" with a magnitude suffix).
 */

/** The subject of the commit that holds the balancer's numbers alone (`changes --commit-balance`) */
export const BALANCE_SUBJECT = "Balance: values tuned in Studio";

const NUMBER_TEXT =/^-?(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)$/;
// A number with a magnitude suffix ("2.54ζT", "8.25βD", "1.5K"): the balancer moves the suffix as
// often as the digits
const SUFFIXED_NUMBER = /^-?(?:\d[\d_]*(?:\.\d+)?|\.\d+)(?:[eE][+-]?\d[\d_]*)?\p{L}{1,4}$/u;
const OPERATORS = ["...", "//=", "..=", "==", "~=", "<=", ">=", "..", "::", "->", "+=", "-=", "*=", "/=", "%=", "^=", "//"];
// After one of these, a "-" is unary and belongs to the number that follows (5 -> -5 is tuning)
const UNARY_BEFORE = new Set(["=", "(", ",", "{", "[", "==", "~=", "<", ">", "<=", ">=", "+", "-", "*", "/", "//", "%", "^", "..", "and", "or", "not", "return", "+=", "-=", "*=", "/=", "%=", "^=", "//=", "..=", ":", ";", "then", "do", "else", "if", "elseif", "while", "until", "in"]);

// Sticky: matched where the tokenizer stands, a whole token however long, with no copy of the rest
const NUMBER_AT = /(?:0[xX][0-9a-fA-F_]+|0[bB][01_]+|(?:\d[\d_]*(?:\.[\d_]*)?|\.\d[\d_]*)(?:[eE][+-]?\d[\d_]*)?)/y;
const NAME_AT = /[A-Za-z_]\w*/y;

/** Text the tokenizer cannot read with certainty: the file is never called numbers-only */
class Unreadable extends Error {}

type Token = string | { num: string; quoted?: true };

function tokenize(src: string): Token[] {
  const out: Token[] = [];
  let i = 0;
  const n = src.length;
  const longBracket = (at: number): number => {
    if (src[at] !== "[") return -1;
    let j = at + 1;
    while (src[j] === "=") j++;
    return src[j] === "[" ? j - at - 1 : -1;
  };
  const skipLong = (at: number, level: number): number => {
    const close = "]" + "=".repeat(level) + "]";
    const end = src.indexOf(close, at + level + 2);
    if (end === -1) throw new Unreadable("an unterminated long bracket");
    return end + close.length;
  };
  while (i < n) {
    const c = src[i];
    // Luau's whitespace only; anything else (a non-breaking space) is a token
    if (" \t\n\r\v\f".includes(c)) {
      i++;
      continue;
    }
    if (c === "-" && src[i + 1] === "-") {
      const level = longBracket(i + 2);
      if (level >= 0) i = skipLong(i + 2, level);
      else while (i < n && src[i] !== "\n" && src[i] !== "\r") i++;
      continue;
    }
    const level = longBracket(i);
    if (level >= 0) {
      const end = skipLong(i, level);
      const text = src.slice(i, end);
      // A long string whose whole content is a number ([[100]]) is tuned like a quoted one
      // Luau drops a newline right after the opening bracket
      const inner = text.slice(level + 2, text.length - level - 2).replace(/^\r?\n/, "");
      out.push(NUMBER_TEXT.test(inner) || SUFFIXED_NUMBER.test(inner) ? { num: inner, quoted: true } : text);
      i = end;
      continue;
    }
    if (c === '"' || c === "'" || c === "`") {
      let j = i + 1;
      while (j < n && src[j] !== c) j += src[j] === "\\" ? 2 : 1;
      if (j >= n) throw new Unreadable("an unterminated string");
      const text = src.slice(i, j + 1);
      // An interpolated string holds code; reading it right needs a real parser
      if (c === "`" && text.includes("{")) throw new Unreadable("an interpolated string");
      const inner = text.slice(1, -1);
      const isNumber = NUMBER_TEXT.test(inner) || SUFFIXED_NUMBER.test(inner);
      out.push(c !== "`" && isNumber ? { num: inner, quoted: true } : text);
      i = j + 1;
      continue;
    }
    if (/\d/.test(c) || (c === "." && /\d/.test(src[i + 1] ?? ""))) {
      NUMBER_AT.lastIndex = i;
      const m = NUMBER_AT.exec(src)!;
      let text = m[0];
      const prev = out[out.length - 1];
      const prev2 = out[out.length - 2];
      if (prev === "-" && (prev2 === undefined || (typeof prev2 === "string" && UNARY_BEFORE.has(prev2)))) {
        out.pop();
        text = "-" + text;
      }
      out.push({ num: text });
      i += m[0].length;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      NAME_AT.lastIndex = i;
      const m = NAME_AT.exec(src)!;
      out.push(m[0]);
      i += m[0].length;
      continue;
    }
    const op = OPERATORS.find((o) => src.startsWith(o, i)) ?? c;
    out.push(op);
    i += op.length;
  }
  return out;
}

// The placeholder holds a NUL, which no real token does, so it never equals Luau's "#"
const masked = (tokens: Token[]) => tokens.map((t) => (typeof t === "string" ? t : t.quoted ? "\0q" : "\0n"));
const numbers = (tokens: Token[]) => tokens.filter((t): t is { num: string } => typeof t !== "string").map((t) => t.num);

/**
 * Null when `after` differs from `before` only in numbers (at least one changed), else why not:
 * "code changed", "no number changed", or what could not be read.
 */
export function numbersOnly(before: string, after: string): string | null {
  let a: Token[];
  let b: Token[];
  try {
    a = tokenize(before);
    b = tokenize(after);
  } catch (error) {
    if (error instanceof Unreadable) return `could not read it: ${error.message}`;
    throw error;
  }
  const ma = masked(a);
  const mb = masked(b);
  if (ma.length !== mb.length || ma.some((t, k) => t !== mb[k])) return "code changed";
  if (numbers(a).join("\0") === numbers(b).join("\0")) return "no number changed (spacing or comments only)";
  return null;
}
