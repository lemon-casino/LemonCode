import { parentPort, workerData } from "node:worker_threads";
import type { NodeReplRunResult } from "@lcode/core/repl";
import type { NodeReplExecuteInput } from "./server.js";
import { createInProcessNodeReplExecutor } from "./executor.js";

// Worker 只加载执行依赖，不再重复求值 MCP SDK 和控制进程的生命周期。
const data = workerData as Omit<NodeReplExecuteInput, "signal">;
void createInProcessNodeReplExecutor()({ ...data, signal: new AbortController().signal })
  .then((result) => parentPort?.postMessage(result))
  .catch((error) =>
    parentPort?.postMessage({
      logs: "",
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    } satisfies NodeReplRunResult),
  );
