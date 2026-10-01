import type { ModelConnectivityResult } from "@lcode/shared";
import {
  MODEL_PROBE_CONCURRENCY,
  normalizeModelIds,
  runCancelablePool,
} from "./syncModelOperations.js";

export interface RemoveInvalidModelResult {
  readonly id: string;
  readonly status: "valid" | "removed" | "unconfirmed" | "deleteFailed";
  readonly message?: string;
}

interface RemoveInvalidModelsOptions {
  ids: readonly string[];
  signal: AbortSignal;
  probe: (id: string, options: { mode: "temporary" }) => Promise<ModelConnectivityResult>;
  remove: (id: string, options: { silentFeedback: true }) => void | Promise<void>;
  onStart?: (id: string) => void;
  onResult: (result: RemoveInvalidModelResult) => void;
}

export async function removeInvalidModels({
  ids,
  signal,
  probe,
  remove,
  onStart,
  onResult,
}: RemoveInvalidModelsOptions): Promise<void> {
  await runCancelablePool({
    items: normalizeModelIds(ids),
    concurrency: MODEL_PROBE_CONCURRENCY,
    shouldContinue: () => !signal.aborted,
    run: async (id): Promise<RemoveInvalidModelResult> => {
      onStart?.(id);
      // 开始通知可能同步触发卸载；发送探测前仍须确认本批次未被取消。
      if (signal.aborted) return { id, status: "unconfirmed" };
      let result: ModelConnectivityResult;
      try {
        result = await probe(id, { mode: "temporary" });
      } catch (error) {
        return { id, status: "unconfirmed", message: errorMessage(error) };
      }
      // 关闭后的迟到结果不能提交删除；已接受的删除仍由原有 Provider 写队列完成。
      if (signal.aborted) return { id, status: "unconfirmed" };
      if (result.success) return { id, status: "valid" };
      // HTTP 状态、文字和本地资格错误均不能证明模型失效，只认执行链的结构化确认。
      if (result.error.code !== "model-not-found") {
        return { id, status: "unconfirmed", message: result.error.message };
      }
      try {
        await remove(id, { silentFeedback: true });
        return { id, status: "removed", message: result.error.message };
      } catch (error) {
        return { id, status: "deleteFailed", message: errorMessage(error) };
      }
    },
    onResult,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
