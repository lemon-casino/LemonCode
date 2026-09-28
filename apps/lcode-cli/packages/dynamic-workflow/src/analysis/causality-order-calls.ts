import ts from "typescript";
import { callbackSemanticsOf, DEFAULT_CALLBACK_SEMANTICS } from "./callbacks.js";
import {
  functionName,
  resolveCallDeclaration,
  type ScriptFunction,
} from "./causality-order-functions.js";
import {
  applicationsAt,
  innermost,
  issue,
  issuesSince,
  jump,
  locOf,
  openRegion,
  type TraceState,
} from "./causality-order-state.js";
import { barrier, settlesAt } from "./causality-order-settle.js";
import {
  closeStrand,
  isAsyncFunction,
  openStrand,
  type StrandRecord,
} from "./causality-order-strands.js";

// causality-order.ts 顶到 oxlint max-lines 上限（400 行），把调用这一组（调用表达式
// 的访问器、通用调用规则 applyAt、函数体内联 inlineBody）拆到本文件；公开面仍从
// causality-order.ts 导出。递归回 walk 一律经 `state.walk`，本文件不 import walk 模块。

export function walkCall(
  state: TraceState,
  node: ts.CallExpression,
  chain: readonly string[],
): void {
  const { walk } = state;
  // Receiver and arguments first, then the call itself — JavaScript's own order. (A
  // function-like argument is deferred by `walk` itself: its body runs when applied.)
  const receiverMark = state.events.length;
  walk(node.expression, chain);
  const receiverIssues = issuesSince(state, receiverMark);
  for (const argument of node.arguments) walk(argument, chain);

  // A per-element callback call: the body runs once per element, inside a `fanout`.
  const handled = new Set<ts.Node>();
  const cand = state.candByCall.get(node);
  if (cand !== undefined) {
    // An `async` literal callback makes the FAN-OUT the strand: every element's activation
    // runs alongside the main line, and only a later await of the mapped array joins them.
    // A named callback (`xs.map(review)`) inlines as a `call` inside the fan-out, and that
    // `call` is the strand when `review` is async — {@link inlineBody} decides it there.
    const strand = cand.callback !== undefined && isAsyncFunction(cand.callback);
    const id = openRegion(state, "fanout", innermost(state, chain), {
      entered: false,
      label: cand.method,
      loc: cand.loc,
      ...(strand ? { strand: true as const } : {}),
    });
    const inside = [...chain, id];
    if (cand.callback !== undefined) {
      const record = strand ? openStrand(state, id) : undefined;
      // A `return` in the literal ends THIS element's iteration: it targets the fanout.
      state.returnTargets.push(id);
      walk(cand.body, inside);
      state.returnTargets.pop();
      if (record !== undefined) closeStrand(state, record);
    } else {
      // A named / held callback: the oracle's argument applications, each an inlined call.
      for (const fn of applicationsAt(state, node, "argument")) {
        handled.add(fn);
        inlineBody(state, fn, inside, node);
      }
    }
  }

  const ask = state.askByCall.get(node);
  if (ask !== undefined) {
    issue(state, ask, chain);
    return;
  }
  const read = state.readByCall.get(node);
  if (read !== undefined) {
    issue(state, read, chain);
    return;
  }
  const actor = state.actorByCall.get(node);
  if (actor !== undefined) {
    state.events.push({ actor, at: "actor", regions: chain });
    return;
  }
  applyAt(state, node, chain, handled, receiverIssues);
}

/**
 * THE GENERIC CALL RULE: apply what the oracle recorded at this node.
 *
 *  - Callee applications inline the body as a `call` region (the helper's boundary, a
 *    `return` target). Several candidates (an indirect dispatch that may reach any of
 *    them) become the arms of one exhaustive `choice`: exactly one runs, we cannot say
 *    which. With no oracle record the checker's resolved declaration is the fallback — a
 *    value the interpreter could not track still has a syntactic answer.
 *  - Argument applications are callbacks a library may invoke, per the registry: `once`
 *    (the default) inlines the body as a `call`; when the library does not provably invoke
 *    it (`.then`, an unknown callee) the call sits in a one-arm skippable `choice` — the
 *    exact shape of an `if` without `else`, so certainty and the control-flow picture read
 *    "may not run" through the vocabulary they already have. `each` callbacks are handled
 *    by {@link walkCall} (their fanout) and arrive here in `handled`.
 *  - A DEFERRED callback (`.then` / `.catch` / `.finally`, a timer) runs after its receiver
 *    settles, so it is a STRAND whose PROLOGUE is an ordinary barrier over the receiver:
 *    the steps issued while evaluating the receiver (`receiverIssues`, the syntactic half)
 *    plus the oracle's claim keyed by the member-name token (see calls.ts), split by the
 *    settle-certainty rule like any other await. It needs no special certainty any more:
 *    the barrier runs inside the strand's own frame, so it orders the continuation's body
 *    without asserting anything about steps the MAIN LINE issues afterwards, and without
 *    robbing the main line's later `await` of its own certain settle. That scoping is what
 *    `settleLocally`'s may-claim used to approximate.
 */
export function applyAt(
  state: TraceState,
  node: ts.CallExpression | ts.NewExpression | ts.TaggedTemplateExpression,
  chain: readonly string[],
  handled: ReadonlySet<ts.Node> = new Set(),
  receiverIssues: readonly string[] = [],
): void {
  const { checker, program, scriptFile } = state;
  const callees = applicationsAt(state, node, "callee").filter((fn) => !handled.has(fn));
  if (callees.length === 0 && ts.isCallExpression(node)) {
    const decl = resolveCallDeclaration(node, checker, scriptFile);
    if (decl !== undefined) callees.push(decl);
  }
  if (callees.length === 1) {
    inlineBody(state, callees[0] as ScriptFunction, chain, node);
  } else if (callees.length > 1) {
    const choice = openRegion(state, "choice", innermost(state, chain), {
      entered: true,
      exhaustive: true,
      loc: locOf(state, node),
    });
    for (const fn of callees) {
      const arm = openRegion(state, "branch", choice, { entered: false, loc: locOf(state, fn) });
      inlineBody(state, fn, [...chain, choice, arm], node);
    }
  }

  const callbacks = applicationsAt(state, node, "argument").filter((fn) => !handled.has(fn));
  if (callbacks.length === 0) return;
  const semantics = ts.isTaggedTemplateExpression(node)
    ? undefined
    : callbackSemanticsOf(node, checker, program);
  const entered = semantics?.entered ?? DEFAULT_CALLBACK_SEMANTICS.entered;
  const access =
    semantics?.deferred === true &&
    ts.isCallExpression(node) &&
    ts.isPropertyAccessExpression(node.expression)
      ? node.expression
      : undefined;
  const prologue =
    access === undefined
      ? undefined
      : (inside: readonly string[]): void => {
          const claim = settlesAt(state, node, access.name.getStart(scriptFile));
          barrier(state, [...receiverIssues, ...claim.certain], claim.maybe, inside);
        };
  const options = {
    label: semantics?.label,
    prologue,
    ...(semantics?.deferred === true ? { strand: true as const } : {}),
  };
  for (const fn of callbacks) {
    if (entered) {
      inlineBody(state, fn, chain, node, options);
      continue;
    }
    const choice = openRegion(state, "choice", innermost(state, chain), {
      entered: true,
      loc: locOf(state, node),
    });
    const arm = openRegion(state, "branch", choice, { entered: false, loc: locOf(state, fn) });
    inlineBody(state, fn, [...chain, choice, arm], node, options);
  }
}

/** What a call site can say about the body it inlines, beyond where it sits. */
interface InlineOptions {
  /** Overrides the function's own name (an anonymous `.then` callback takes the method's). */
  label?: string;
  /** Force a strand although the body is not `async`: the registry's `deferred` flag. */
  strand?: true;
  /** Run inside the opened region (and, for a strand, inside its frame) before the body. */
  prologue?: (inside: readonly string[]) => void;
}

/**
 * Inline one function body at a site: the `call` region (positioned at the SITE — it is
 * this occurrence, not the declaration), inside a `loop` region when the function is
 * recursive, with re-entry cut to a `recur` jump.
 *
 * The body is a STRAND when the applied function is `async` or the caller forces it (a
 * deferred callback): it then gets a frame of its own, so the `await`s inside it suspend
 * this activation and settle nothing for the spawner — which is the JavaScript semantics
 * the single global settled set used to flatten.
 */
function inlineBody(
  state: TraceState,
  decl: ScriptFunction,
  chain: readonly string[],
  site: ts.Node,
  options: InlineOptions = {},
): void {
  const { fnStack, sccLoopByDecl } = state;
  const { label, prologue } = options;
  if (fnStack.includes(decl)) {
    // Recursion: the enclosing `loop` region carries it; the re-entrant call itself is a
    // back edge to that loop for the control-flow projection.
    const loop = sccLoopByDecl.get(decl);
    if (loop !== undefined) jump(state, "recur", loop, chain);
    return;
  }
  const name = functionName(decl) ?? label;
  const strand = options.strand === true || isAsyncFunction(decl);
  let inside = chain;
  let sccLoop: string | undefined;
  if (state.recursive.has(decl)) {
    // A call-graph SCC containing a step is a `loop` region, never unrolled.
    sccLoop = openRegion(state, "loop", innermost(state, chain), {
      entered: true,
      loc: locOf(state, decl),
      recursive: true,
      ...(name === undefined ? {} : { label: name }),
    });
    inside = [...inside, sccLoop];
  }
  // The inlined body is a `call` region: the helper's boundary, which a `return` inside
  // it targets.
  const call = openRegion(state, "call", innermost(state, inside), {
    entered: true,
    loc: locOf(state, site),
    ...(name === undefined ? {} : { label: name }),
    ...(strand ? { strand: true as const } : {}),
  });
  inside = [...inside, call];
  const record: StrandRecord | undefined = strand ? openStrand(state, call) : undefined;
  if (prologue !== undefined) prologue(inside);
  fnStack.push(decl);
  state.walkedFns.add(decl);
  const outerSccLoop = sccLoopByDecl.get(decl);
  if (sccLoop !== undefined) sccLoopByDecl.set(decl, sccLoop);
  state.returnTargets.push(call);
  state.walk(decl.body as ts.Node, inside);
  state.returnTargets.pop();
  if (outerSccLoop === undefined) sccLoopByDecl.delete(decl);
  else sccLoopByDecl.set(decl, outerSccLoop);
  fnStack.pop();
  if (record !== undefined) closeStrand(state, record);
}
