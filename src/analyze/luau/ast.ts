/**
 * Luau's syntax tree, as the analyzer needs it: every statement and expression with its source
 * offsets (`start` inclusive, `end` exclusive). Types are parsed and checked for syntax, then
 * dropped: no rule reads them yet.
 */

interface Node {
  start: number;
  end: number;
}

export interface Binding extends Node {
  name: string;
}

export interface Block extends Node {
  body: Stat[];
}

export type Stat =
  | (Node & { kind: "Local"; names: Binding[]; values: Expr[] })
  | (Node & { kind: "LocalFunction"; name: Binding; func: FunctionExpr })
  /** `function a.b:c()`: `target` is the name or index chain; a method's func has `self` */
  | (Node & { kind: "Function"; target: Expr; func: FunctionExpr })
  | (Node & { kind: "Assign"; targets: Expr[]; values: Expr[] })
  | (Node & { kind: "CompoundAssign"; op: string; target: Expr; value: Expr })
  | (Node & { kind: "CallStat"; call: Expr })
  | (Node & { kind: "If"; clauses: { cond: Expr; body: Block }[]; orelse?: Block })
  | (Node & { kind: "While"; cond: Expr; body: Block })
  | (Node & { kind: "Repeat"; body: Block; cond: Expr })
  | (Node & { kind: "NumericFor"; var: Binding; from: Expr; to: Expr; step?: Expr; body: Block })
  | (Node & { kind: "GenericFor"; vars: Binding[]; exprs: Expr[]; body: Block })
  | (Node & { kind: "Do"; body: Block })
  | (Node & { kind: "Return"; values: Expr[] })
  | (Node & { kind: "Break" })
  | (Node & { kind: "Continue" })
  /** `type X = ...`, `export type`, `type function` */
  | (Node & { kind: "TypeAlias"; name: Binding; exported: boolean });

export interface FunctionExpr extends Node {
  kind: "Function";
  params: Binding[];
  vararg: boolean;
  /** `function M:m()`: the implicit `self` */
  self?: Binding;
  body: Block;
}

export type TableField =
  | (Node & { kind: "Item"; value: Expr })
  | (Node & { kind: "Named"; name: Binding; value: Expr })
  | (Node & { kind: "Keyed"; key: Expr; value: Expr });

export type Expr =
  | (Node & { kind: "Nil" })
  | (Node & { kind: "Boolean"; value: boolean })
  | (Node & { kind: "Number"; raw: string; value: number })
  /** `value` read as UTF-8 (for messages and names); `bytes` one char per byte (to compare: "\255" and "\254" differ) */
  | (Node & { kind: "String"; raw: string; value: string; bytes: string })
  | (Node & { kind: "Interp"; parts: Expr[] })
  | (Node & { kind: "Vararg" })
  | FunctionExpr
  | (Node & { kind: "Table"; fields: TableField[] })
  | (Node & { kind: "IfElse"; clauses: { cond: Expr; value: Expr }[]; orelse: Expr })
  | (Node & { kind: "Name"; name: string })
  /** `a.b` (a method call is a Call with `method`) */
  | (Node & { kind: "Member"; object: Expr; name: Binding })
  | (Node & { kind: "Index"; object: Expr; key: Expr })
  /** `f(a)`, `o:m(a)` (`method` set: the callee is `object`) */
  | (Node & { kind: "Call"; callee: Expr; method?: Binding; args: Expr[] })
  | (Node & { kind: "Binary"; op: string; left: Expr; right: Expr })
  | (Node & { kind: "Unary"; op: string; operand: Expr })
  | (Node & { kind: "Paren"; expr: Expr })
  /** `expr :: Type` */
  | (Node & { kind: "Cast"; expr: Expr });

export interface Chunk extends Block {
  /** The source, for positions */
  src: string;
}
