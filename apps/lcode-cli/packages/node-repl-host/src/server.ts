import { Worker } from "node:worker_threads";
import { INVALID_PARAMS, Server, type Tool } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { JsInputJsonSchema } from "@lcode/contracts/tools/node-repl";
import {
  runtimeMemoryBudget,
  readRuntimeMemorySnapshot,
  RuntimeMemoryBudgetError,
  RUNTIME_MEMORY_SYSTEM_HEADROOM_BYTES,
} from "@lcode/shared/node";
import type { NodeReplRequestMeta, NodeReplRunResult } from "@lcode/core/repl";
import {
  createComputerUseRuntime,
  type ComputerUseRuntime,
  type ComputerUseRuntimeLogger,
} from "@lcode/lcode-cua";
import {
  BROKER_CAPABILITY_ENV,
  BROKER_GENERATION_ENV,
  BROKER_SOCKET_ENV,
} from "@lcode/lcode-cua/broker";
import { z } from "zod";
import type { NodeReplCuaBrokerConnection } from "./cua-bridge.js";
import { createNodeReplCuaBroker } from "./cua-broker.js";
import {
  isDirectMcpEntrypoint,
  installNodeReplProcessGuards,
  installNodeReplShutdownTriggers,
} from "./process-lifecycle.js";
import { toMcpRunResult } from "./result.js";
import {
  JS_TOOL_DESCRIPTION,
  NODE_REPL_DEFAULT_TIMEOUT_MS,
  NODE_REPL_SERVER_INSTRUCTIONS,
  NODE_REPL_SERVER_VERSION,
} from "./tool-contract.js";

const MAX_SYNC_TIMEOUT_MS = 120_000;
const MEMORY_SAMPLE_INTERVAL_MS = 100;
const UNTRUSTED_SESSION_KEY = "__unscoped__";
export const NODE_REPL_MCP_PROCESS_TITLE = "lcode-node-repl-mcp";
const jsInputSchema = z
  .object({
    code: z.string(),
    timeout_ms: z.number().int().min(1).max(MAX_SYNC_TIMEOUT_MS).optional(),
    // tools/list 对新调用强制 title，但执行层必须继续接受旧 provider 和历史回放的 code-only 输入。
    title: z.string().min(1).max(120).optional(),
  })
  .strict();
const requestContextSchema = z
  .object({
    parent_span_id: z.string().optional(),
    runtime_scope: z.enum(["main", "subagent"]).default("main"),
    session_id: z.string().trim().min(1).optional(),
    span_id: z.string().optional(),
    trace_id: z.string().optional(),
    turn_id: z.string().optional(),
    workspace_identity: z.string().optional(),
    workspace_key: z.string().optional(),
    workspace_path: z.string().optional(),
    remote_session_id: z.string().optional(),
    client_mode: z.string().optional(),
    delivery_kind: z.string().optional(),
  })
  .passthrough();

const tools: Tool[] = [
  {
    name: "js",
    description: JS_TOOL_DESCRIPTION,
    // host MCP 曾手写出 title optional 的模型合同，和 built-in 合同分叉后 UI 只能显示固定完成文案。
    inputSchema: JsInputJsonSchema as Tool["inputSchema"],
  },
];

export interface NodeReplExecuteInput {
  code: string;
  requestMeta: NodeReplRequestMeta;
  signal: AbortSignal;
  syncTimeoutMs: number;
  cuaBroker?: NodeReplCuaBrokerConnection;
}

export type NodeReplExecutor = (input: NodeReplExecuteInput) => Promise<NodeReplRunResult>;

export interface NodeReplMcpRuntime {
  dispose(): void;
  server: Server;
}

export function setNodeReplMcpProcessTitle(target: { title: string } = process): void {
  target.title = NODE_REPL_MCP_PROCESS_TITLE;
}

/**
 * 测试与同进程嵌入入口使用同一条执行逻辑；生产 stdio 默认在一次性 Worker 中调用它，
 * 从而连 Node 的模块缓存也随调用一起销毁。
 */
export function createInProcessNodeReplExecutor(): NodeReplExecutor {
  // 控制进程仅持有协议；解析器/VM/领域桥只在实际执行 Worker 中加载。
  return async (input) => (await import("./executor.js")).createInProcessNodeReplExecutor()(input);
}

export function createNodeReplMcpRuntime(
  input: { executeJs?: NodeReplExecutor; cuaRuntime?: ComputerUseRuntime } = {},
): NodeReplMcpRuntime {
  const executeJs = input.executeJs ?? executeJsInWorker;
  const cuaRuntime = input.cuaRuntime ?? captureComputerUseRuntimeFromEnvironment();
  const cuaBroker = cuaRuntime
    ? createNodeReplCuaBroker({ runtime: cuaRuntime, platform: process.platform })
    : undefined;
  const queues = new Map<string, Promise<void>>();
  const activeCalls = new Set<AbortController>();
  let disposed = false;

  const serialized = async <T>(key: string, run: () => Promise<T>): Promise<T> => {
    const previous = queues.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const next = new Promise<void>((resolveQueue) => {
      release = resolveQueue;
    });
    queues.set(key, next);
    await previous;
    try {
      return await run();
    } finally {
      release();
      if (queues.get(key) === next) queues.delete(key);
    }
  };

  const server = new Server(
    { name: "node_repl", version: NODE_REPL_SERVER_VERSION },
    { capabilities: { tools: {} }, instructions: NODE_REPL_SERVER_INSTRUCTIONS },
  );

  server.setRequestHandler("tools/list", async () => ({ tools }));
  server.setRequestHandler("tools/call", async (request, extra) => {
    if (disposed) throw new Error("node_repl runtime is disposed");
    const name = request.params.name;
    const requestMeta = buildRequestMeta(extra.mcpReq._meta);
    const sessionKey = requestSessionKey(requestMeta);
    if (name === "js") {
      const args = parseToolInput(jsInputSchema, request.params.arguments, name);
      return await serialized(sessionKey, async () => {
        if (disposed) throw new Error("node_repl runtime is disposed");
        extra.mcpReq.signal.throwIfAborted();
        if (!args.code) {
          return {
            content: [{ type: "text" as const, text: "js expects non-empty JavaScript source" }],
            isError: true,
          };
        }
        const callController = new AbortController();
        activeCalls.add(callController);
        const timeoutMs = args.timeout_ms ?? NODE_REPL_DEFAULT_TIMEOUT_MS;
        const callMeta = { ...requestMeta, ...(args.title ? { title: args.title } : {}) };
        try {
          const signal = AbortSignal.any([
            extra.mcpReq.signal,
            callController.signal,
            AbortSignal.timeout(timeoutMs),
          ]);
          const run = await executeJs({
            code: args.code,
            requestMeta: callMeta,
            signal,
            syncTimeoutMs: Math.min(timeoutMs, MAX_SYNC_TIMEOUT_MS),
            cuaBroker: cuaBroker?.connection,
          });
          return toMcpRunResult(run);
        } finally {
          activeCalls.delete(callController);
        }
      });
    }
    invalidParams(`Tool ${name} not found`);
  });

  return {
    server,
    dispose: () => {
      disposed = true;
      for (const controller of activeCalls) controller.abort();
      activeCalls.clear();
      queues.clear();
      void cuaBroker?.close();
      void cuaRuntime?.dispose();
    },
  };
}

async function executeJsInWorker(input: NodeReplExecuteInput): Promise<NodeReplRunResult> {
  if (input.signal.aborted) throw input.signal.reason;
  const memoryLease = await runtimeMemoryBudget.acquire("repl-worker");
  if (input.signal.aborted) {
    memoryLease.release();
    throw input.signal.reason;
  }
  const data: Omit<NodeReplExecuteInput, "signal"> = {
    code: input.code,
    requestMeta: input.requestMeta,
    syncTimeoutMs: input.syncTimeoutMs,
    cuaBroker: input.cuaBroker,
  };
  let worker: Worker;
  try {
    worker = new Worker(new URL("./executor-worker.js", import.meta.url), {
      workerData: data,
      // 原来每个会话都能同时创建无上限 isolate，全部能力开启时会把 1 GiB 主机耗尽。
      resourceLimits: {
        maxOldGenerationSizeMb: memoryLease.heapMb,
        maxYoungGenerationSizeMb: 16,
        stackSizeMb: 4,
      },
    });
  } catch (error) {
    memoryLease.release();
    throw error;
  }
  return await new Promise<NodeReplRunResult>((resolveRun, rejectRun) => {
    let settled = false;
    const cleanup = () => {
      clearInterval(memoryMonitor);
      input.signal.removeEventListener("abort", onAbort);
      worker.removeAllListeners();
    };
    const finish = (error?: unknown, result?: NodeReplRunResult) => {
      if (settled) return;
      settled = true;
      // result 到达不等于 isolate 已退出；必须先回收，才能让下一次调用复用同一份内存预算。
      void worker.terminate().then(
        () => {
          cleanup();
          memoryLease.release();
          if (error !== undefined) rejectRun(error);
          else if (result) resolveRun(result);
          else rejectRun(new Error("node_repl worker returned no result"));
        },
        (error) => {
          cleanup();
          rejectRun(error);
        },
      );
    };
    let sampling = false;
    // ArrayBuffer/native 不计入 V8 堆，执行期间还要观察 cgroup/系统余量；主线程可中止阻塞中的 Worker。
    const memoryMonitor = setInterval(() => {
      if (sampling || settled) return;
      sampling = true;
      void readRuntimeMemorySnapshot()
        .then(
          (snapshot) => {
            if (!settled && snapshot.availableBytes < RUNTIME_MEMORY_SYSTEM_HEADROOM_BYTES)
              finish(new RuntimeMemoryBudgetError("repl-worker"));
          },
          (error) => finish(error),
        )
        .finally(() => {
          sampling = false;
        });
    }, MEMORY_SAMPLE_INTERVAL_MS);
    memoryMonitor.unref();
    const onAbort = () => finish(input.signal.reason ?? new DOMException("aborted", "AbortError"));
    input.signal.addEventListener("abort", onAbort, { once: true });
    worker.once("message", (message: unknown) => finish(undefined, message as NodeReplRunResult));
    worker.once("error", finish);
    worker.once("exit", (code) => {
      if (!settled)
        finish(new Error(`node_repl worker exited before returning a result (${code})`));
    });
    if (input.signal.aborted) onAbort();
  });
}

function parseToolInput<T>(schema: z.ZodType<T>, input: unknown, toolName: string): T {
  const parsed = schema.safeParse(input ?? {});
  if (parsed.success) return parsed.data;
  const issue = parsed.error.issues[0];
  invalidParams(`${toolName}: ${issue?.message ?? "invalid arguments"}`);
}

function invalidParams(message: string): never {
  throw Object.assign(new Error(message), { code: INVALID_PARAMS });
}

function buildRequestMeta(meta: Record<string, unknown> | undefined): NodeReplRequestMeta {
  const parsed = requestContextSchema.safeParse(meta?.["com.zcode/request-context"]);
  // 安全边界：顶层 MCP _meta 是第三方可扩展字段，不能成为 LCode session 路由凭据。
  // 只有 host client 写入的命名空间会进入 Browser bridge；旧 client 的普通 JS 仍可执行。
  return parsed.success ? parsed.data : {};
}

function requestSessionKey(meta: NodeReplRequestMeta): string {
  const sessionId = meta.session_id;
  return typeof sessionId === "string" && sessionId.trim() ? sessionId : UNTRUSTED_SESSION_KEY;
}

export { installNodeReplProcessGuards, installNodeReplShutdownTriggers };

export async function main(): Promise<void> {
  setNodeReplMcpProcessTitle();
  const runtimes = new Set<NodeReplMcpRuntime>();
  // 官方 plugin host 在 main() 返回后会清除短暂恢复的 Helper 凭据，而
  // serveStdio 的 server factory 要到 MCP initialize 时才执行。过去在 factory 内读取
  // process.env，必然得到空值，导致 node_repl 永久把 Computer Use 判为 unavailable。
  // 这里在 main() 生命周期内先捕获 runtime；Worker 只收到二次 bridge token，
  // 不会接触 Helper 的原始 socket/token。
  const computerUseRuntime = captureAndClearComputerUseRuntimeFromEnvironment();
  const handle = serveStdio(
    () => {
      const runtime = createNodeReplMcpRuntime({ cuaRuntime: computerUseRuntime });
      runtimes.add(runtime);
      return runtime.server;
    },
    { legacy: "reject" },
  );
  let shutdownStarted = false;
  const shutdown = () => {
    if (shutdownStarted) return;
    shutdownStarted = true;
    for (const runtime of runtimes) runtime.dispose();
    void handle
      .close()
      .catch(() => undefined)
      .finally(() => process.exit(0));
  };
  installNodeReplProcessGuards({
    onOutputClosed: shutdown,
    process,
    writeStderr: (text) => process.stderr.write(text),
  });
  installNodeReplShutdownTriggers({ process, shutdown, stdin: process.stdin });
}

// runtime 低频异常路径（门拒绝/驱动异常/dispose 失败/会话排空）的日志落点：
// node-repl-host 不依赖 services logger，直接走进程 stderr（本文件既有 guards 同通道）。
const cuaRuntimeLogger: ComputerUseRuntimeLogger = {
  warn: (message, meta) => {
    process.stderr.write(`[lcode-cua-runtime] ${message} ${JSON.stringify(meta ?? {})}\n`);
  },
};

export function captureComputerUseRuntimeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ComputerUseRuntime | undefined {
  const socketPath = env[BROKER_SOCKET_ENV]?.trim();
  // 当前 Host 恢复的 plugin authority 是本跳可信 capability。父进程可能残留旧的专用
  // capability env；若让它优先，会覆盖本次 Host tuple 并让所有请求稳定鉴权失败。
  // 专用 env 只保留为无 authority 调用方的兼容回退。
  const brokerCapability =
    env.LCODE_CUA_PLUGIN_AUTHORITY?.trim() || env[BROKER_CAPABILITY_ENV]?.trim();
  // socket 与 capability 必须作为一组出现；半组凭据不能回退到本地驱动。
  if (!socketPath || !brokerCapability) return undefined;
  return createComputerUseRuntime({
    brokerSocketPath: socketPath,
    brokerCapability,
    brokerGeneration: Number(env[BROKER_GENERATION_ENV] ?? 0),
    refreshMarkerPath: env.LCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER?.trim(),
    env: { ...env },
    logger: cuaRuntimeLogger,
  });
}

export function captureAndClearComputerUseRuntimeFromEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): ComputerUseRuntime | undefined {
  try {
    return captureComputerUseRuntimeFromEnvironment(env);
  } finally {
    // 直接 Node 入口没有 CLI plugin-host 的 finally；原始 Helper 凭据不得被执行 Worker 继承。
    for (const key of [
      BROKER_SOCKET_ENV,
      BROKER_CAPABILITY_ENV,
      BROKER_GENERATION_ENV,
      "LCODE_CUA_PLUGIN_AUTHORITY",
      "LCODE_CUA_PERMISSION_BROKER_REFRESH_MARKER",
    ])
      delete env[key];
  }
}

if (await isDirectMcpEntrypoint(import.meta.url, process.argv[1])) {
  void main().catch((error) => {
    process.stderr.write(
      `node_repl MCP server failed: ${error instanceof Error ? error.stack : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
