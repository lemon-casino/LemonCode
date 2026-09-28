import ts from "typescript";
import { FACADE_FILE_NAME } from "../facade/dts.js";
import type { WorldReadOp } from "../facade/registry.js";
import type { ScriptLoc } from "../compiler/compile.js";
import type { NamePattern } from "./types.js";
import type { CallbackSemantics } from "./callbacks.js";
import type { IterationCandidate } from "./sites.js";

// sites.ts 顶到 oxlint max-lines 上限（400 行），把名字 / 标签辅助（ask 标签与模板
// 形状、actor 名与模板形状、world-read 标签、字面量文本、迭代候选的构造、计数器）与它们依赖的
// 符号解析（resolveSymbol / isFacadeDeclared）拆到本文件；公开面仍从 sites.ts 导出（后两者
// 在那里原样再导出，其余本就不公开）。站点类型留在 sites.ts，这里只按类型导入。

/** Resolve a node's symbol, following one alias hop (imports never occur here). */
export function resolveSymbol(node: ts.Node, checker: ts.TypeChecker): ts.Symbol | undefined {
  const symbol = checker.getSymbolAtLocation(node);
  if (symbol !== undefined && (symbol.flags & ts.SymbolFlags.Alias) !== 0) {
    return checker.getAliasedSymbol(symbol);
  }
  return symbol;
}

/** True iff any of the symbol's declarations lives in the facade `.d.ts`. */
export function isFacadeDeclared(symbol: ts.Symbol | undefined): boolean {
  return (
    symbol?.declarations?.some(
      (declaration) => declaration.getSourceFile().fileName === FACADE_FILE_NAME,
    ) ?? false
  );
}

/**
 * 一个实参**无洞字符串字面量**的文本，其余（标识符、带洞模板、任意表达式）一律 undefined。
 *
 * 三处共用一条判定：phase 的名字、产物的 id、report 的标签。三者的规矩完全相同——只有编译期
 * 就闭合的字面量才算数，看不穿的一律留给各自的诊断趟按原表达式定位，**绝不在这里猜一个值
 * 出来**（猜出来的名字会让一条本该被教改写的调用静默通过）。`ts.isStringLiteralLike` 覆盖
 * 无插值的反引号串。
 */
export function literalText(expr: ts.Expression | undefined): string | undefined {
  return expr !== undefined && ts.isStringLiteralLike(expr) ? expr.text : undefined;
}

export class Counter {
  private value = 0;
  next(): number {
    this.value += 1;
    return this.value;
  }
}

/**
 * ask label: an inline `agent("name", …)` receiver contributes its literal name;
 * a plain identifier receiver contributes its text; otherwise `"ask"`.
 */
export function askLabel(receiver: ts.Expression, checker: ts.TypeChecker): string {
  if (ts.isCallExpression(receiver) && isActorCall(receiver, checker)) {
    const first = receiver.arguments[0];
    if (first !== undefined && ts.isStringLiteralLike(first)) return first.text;
  }
  if (ts.isIdentifier(receiver)) return receiver.text;
  return "ask";
}

/**
 * ask label pattern: only for an inline `` agent(`研究员${i}`) `` receiver — the one shape
 * `askLabel` answers `"ask"` for despite the script having said something. A named or
 * identifier receiver already produced a real label, so there is nothing to reconstruct.
 */
export function askLabelPattern(
  receiver: ts.Expression,
  checker: ts.TypeChecker,
): NamePattern | undefined {
  if (!ts.isCallExpression(receiver) || !isActorCall(receiver, checker)) return undefined;
  return templateAffixes(receiver.arguments[0]);
}

function isActorCall(call: ts.CallExpression, checker: ts.TypeChecker): boolean {
  if (ts.isPropertyAccessExpression(call.expression)) return false;
  const symbol = resolveSymbol(call.expression, checker);
  return isFacadeDeclared(symbol) && symbol?.name === "agent";
}

/**
 * actor name: a string-literal first argument, else the binding name when the call
 * directly initializes a variable declaration, else undefined.
 */
export function actorName(call: ts.CallExpression): string | undefined {
  const first = call.arguments[0];
  if (first !== undefined && ts.isStringLiteralLike(first)) return first.text;
  const parent = call.parent;
  if (
    ts.isVariableDeclaration(parent) &&
    parent.initializer === call &&
    ts.isIdentifier(parent.name)
  ) {
    return parent.name.text;
  }
  return undefined;
}

/**
 * actor name pattern: the static shape of a first argument that is a template literal
 * with holes. Only consulted when `actorName` came back undefined — a literal name and a
 * binding name are both real names, and a pattern must never displace one.
 */
export function actorNamePattern(call: ts.CallExpression): NamePattern | undefined {
  return templateAffixes(call.arguments[0]);
}

/**
 * 模板字符串两端的字面量：第一个洞之前（`head`）与最后一个洞之后（`tail`）。
 *
 * `ts.isStringLiteralLike` 已经覆盖了无插值的反引号串（那是字面量，走 `name` 那条路），
 * 所以这里只处理真正带洞的 `ts.TemplateExpression`。
 *
 * **中间的字面量刻意丢弃**：`` `a${x}b${y}c` `` 给出 `a` 与 `c`，不是 `a…b…c`。名字是一行
 * 上的标签，不是产生它的那个表达式的渲染。
 */
function templateAffixes(arg: ts.Expression | undefined): NamePattern | undefined {
  if (arg === undefined || !ts.isTemplateExpression(arg)) return undefined;
  const head = meaningfulAffix(arg.head.text);
  const tail = meaningfulAffix(arg.templateSpans.at(-1)?.literal.text);
  if (head === undefined && tail === undefined) return undefined;
  return {
    ...(head === undefined ? {} : { head }),
    ...(tail === undefined ? {} : { tail }),
  };
}

/**
 * 一个 affix 值不值得显示：trim 后必须至少含一个字母或数字。
 *
 * 为什么要这道门：`` agent(`${x}-`) `` 的 tail 是 `-`，渲染出来是 `…-`——那比「未命名智能体」
 * 更差，读者既得不到名字，还多了一串标点。`\p{L}` 覆盖 CJK，所以「研究员」照常通过。
 */
function meaningfulAffix(text: string | undefined): string | undefined {
  const trimmed = text?.trim();
  if (trimmed === undefined || trimmed === "") return undefined;
  return /[\p{L}\p{N}]/u.test(trimmed) ? trimmed : undefined;
}

/** world-read label: the op name, plus a string-literal first argument when present. */
export function worldReadLabel(op: WorldReadOp, arg: ts.Expression | undefined): string {
  if (arg !== undefined && ts.isStringLiteralLike(arg)) return `${op} ${arg.text}`;
  return op;
}

export function eachCandidate(
  call: ts.CallExpression,
  semantics: CallbackSemantics,
  order: number,
  loc: ScriptLoc,
): IterationCandidate | undefined {
  const index = semantics.callbacks[0];
  const argument = index === undefined ? undefined : call.arguments[index];
  const iterated = semantics.iterated;
  if (argument === undefined || iterated === undefined) return undefined;
  const literal = ts.isArrowFunction(argument) || ts.isFunctionExpression(argument);
  return {
    body: literal ? argument.body : argument,
    ...(literal ? { callback: argument } : { callbackExpr: argument }),
    call,
    element: literal ? argument.parameters[semantics.elementParams?.[0] ?? 0]?.name : undefined,
    form: "array-method",
    iterated,
    loc,
    method: semantics.label,
    order,
    semantics,
  };
}

export function forOfCandidate(
  statement: ts.ForOfStatement,
  order: number,
  loc: ScriptLoc,
): IterationCandidate {
  let element: ts.BindingName | undefined;
  if (ts.isVariableDeclarationList(statement.initializer)) {
    element = statement.initializer.declarations[0]?.name;
  }
  return {
    body: statement.statement,
    element,
    form: "for-of",
    iterated: statement.expression,
    loc,
    order,
  };
}
