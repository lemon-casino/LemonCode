import { runInContext, type Context } from "node:vm";
import {
  instrumentForContextPersistence,
  parseReplCode,
  rewriteDynamicImportsForRepl,
} from "./instrument.js";

/**
 * ReplExecutor —— 「执行 + 跨调用持久」策略接缝（A-ready）。
 *
 * NodeReplSession.run 只调 executor.run，切换实现即切换路线：
 * - 路线 B（当前）：IifeContextExecutor —— instrument 顶层声明 → async-IIFE → runInContext。
 * - 路线 A（将来，需 --experimental-vm-modules）：SourceTextModuleExecutor —— harvest 版 instrument
 *   → SourceTextModule.evaluate → 收割 namespace。主体不动，仅替换此实现。
 *
 * 契约：返回完成值；出错则 throw（由 NodeReplSession 的 try/catch 归一为结构化 error）。
 * signal 支持取消（超时/停止）。
 */
export interface ReplExecutor {
  run(
    code: string,
    context: Context,
    signal?: AbortSignal,
    syncTimeoutMs?: number,
  ): Promise<unknown>;
}

/**
 * 路线 B 执行器：解析用户代码，instrument 顶层声明使其复制到持久 context（globalThis），
 * 再包成 async-IIFE 拿 top-level await，runInContext 于持久 context 执行。
 *
 * parse 失败 → 回退用原始 code（保证不因 instrument 崩），此时顶层 const/let 不持久但仍能执行。
 */
export class IifeContextExecutor implements ReplExecutor {
  async run(
    code: string,
    context: Context,
    signal?: AbortSignal,
    syncTimeoutMs = 5_000,
  ): Promise<unknown> {
    if (signal?.aborted) {
      throw abortReason(signal);
    }
    // instrument：顶层声明后注入 globalThis 赋值。parse 失败回退原样。
    const rewrittenCode = rewriteDynamicImportsForRepl(code);
    const rewrittenParsed = parseReplCode(rewrittenCode);
    const effectiveCode =
      "ast" in rewrittenParsed
        ? instrumentForContextPersistence(rewrittenCode, rewrittenParsed.ast)
        : rewrittenCode;

    // 包成 async IIFE 支持顶层 await。动态加载用注入的 importModule（见 NodeReplSession.buildContext），
    // 不传 importModuleDynamically 以免触发 vm 的 --experimental-vm-modules 要求。
    const wrapped = `(async () => {\n${effectiveCode}\n})()`;
    // Promise race 只能取消已经把控制权交回 event loop 的异步代码；`while(true){}`
    // 会把 agent 线程永久占住，使外层 timeout/AbortSignal 的 timer 根本没有机会执行。
    // vm 自身的同步执行预算由 V8 interrupt 检查实现，能真正打断同步死循环。预算只覆盖
    // runInContext 的同步段，await 后的异步等待仍由 AbortSignal race 负责。
    const promise = runInContext(wrapped, context, {
      timeout: Math.max(1, Math.trunc(syncTimeoutMs)),
    }) as Promise<unknown>;

    return signal ? await raceAbort(promise, signal) : await promise;
  }
}

function abortReason(signal: AbortSignal): unknown {
  // AbortSignal.timeout 的 reason 是 TimeoutError。统一重写为 AbortError 会让
  // MCP hard timeout 与用户主动停止无法区分，也无法给出准确的 kernel reset 恢复指引。
  const reason = signal.reason;
  if (reason && typeof reason === "object" && "name" in reason) return reason;
  return new DOMException(typeof reason === "string" ? reason : "aborted", "AbortError");
}

/** 将 promise 与 signal.abort 竞速：aborted 立即 reject signal.reason，否则透传 promise 结果。 */
function raceAbort(promise: Promise<unknown>, signal: AbortSignal): Promise<unknown> {
  if (signal.aborted) {
    return Promise.reject(abortReason(signal));
  }
  return new Promise<unknown>((resolve, reject) => {
    const onAbort = () => reject(abortReason(signal));
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    promise.then(
      (v) => {
        signal.removeEventListener("abort", onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}
