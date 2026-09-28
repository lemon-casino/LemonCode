// ============================================================
// Dynamic Workflow Snippet Port - snippet 的同步编译执行边界
// ============================================================
// 与 {@link import("./dynamic-workflow-run.port.js").DynamicWorkflowRunPort} 并列而非合并：
// run 端口的构造前提是 durable journal（没有持久化就没有 run），而 snippet 完全瞬态、
// 只依赖两个执行端口——把它挂在 run 端口上等于让实验通道被 durability 前提连坐。

import type { TraceContext } from "../tracing/tracer.js";

/** 一条编译诊断的 JSON 形状（与 CreateWorkflow 的诊断同形；端口不 import zod schema）。 */
export interface DynamicWorkflowSnippetDiagnostic {
  code: number;
  column: number;
  line: number;
  message: string;
}

export interface DynamicWorkflowSnippetEvalRequest {
  /** snippet 源码（scratch facade 词汇：files.*、git.*、log、纯 TS）。 */
  code: string;
  /** 执行工作目录（沙箱子进程 cwd、world-read 的根）。 */
  cwd: string;
  /** 整段 snippet 的墙钟（ms）。钳制归工具层；端口只按值执行。 */
  timeoutMs: number;
  trace: TraceContext;
}

export interface DynamicWorkflowSnippetEvalOptions {
  signal?: AbortSignal;
}

/**
 * eval 的结构化结果。三种形态互斥：
 *   - 编译不过：`diagnostics` 非空，未执行任何东西；
 *   - 执行完成：`artifact` 是脚本顶层返回值（`undefined` 产物即字段缺席）；
 *   - 执行失败：`error` 携带稳定错误码（超时 / 脚本抛错 / cap 拒绝都在此形态）。
 * logs 在后两种形态都在场（失败前的叙事同样有价值）。
 */
export type DynamicWorkflowSnippetEvalResult =
  | { kind: "diagnostics"; diagnostics: DynamicWorkflowSnippetDiagnostic[] }
  | { kind: "completed"; artifact?: unknown; logs: string[]; logsTruncated: boolean }
  | {
      kind: "failed";
      error: { code: string; message: string };
      logs: string[];
      logsTruncated: boolean;
    };

export interface DynamicWorkflowSnippetPort {
  /** 编译一次并同步执行至结算（完全瞬态：无 dwf_* 行、无后台任务）。 */
  evalSnippet(
    request: DynamicWorkflowSnippetEvalRequest,
    options?: DynamicWorkflowSnippetEvalOptions,
  ): Promise<DynamicWorkflowSnippetEvalResult>;
}
