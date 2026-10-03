import type { ModelConnectivityResult } from "@lcode/shared";

export const MODEL_PROBE_CONCURRENCY = 4;

export interface SyncModelProbeResult {
  readonly id: string;
  readonly success: boolean;
  readonly stage?: "probe" | "save";
  readonly message?: string;
}

export function normalizeModelIds(ids: readonly string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter(Boolean))];
}

export function filterModelIds(ids: readonly string[], query: string): string[] {
  const normalized = query.trim().toLowerCase();
  return ids.filter((id) => id.toLowerCase().includes(normalized));
}

export function selectedModelIds(rows: readonly string[], selected: ReadonlySet<string>): string[] {
  return normalizeModelIds(rows).filter((id) => selected.has(id));
}

export function probeTargetIds(
  rows: readonly string[],
  visibleRows: readonly string[],
  selected: ReadonlySet<string>,
  searching: boolean,
): string[] {
  // 搜索时提交范围收缩为匹配项与勾选交集，避免默认全选的隐藏模型被误检测；未搜索时即全局勾选快照。
  return normalizeModelIds(searching ? visibleRows : rows).filter((id) => selected.has(id));
}

export async function probeAndSyncModel({
  id,
  signal,
  isConfigured,
  probe,
  add,
  setEnabled,
}: {
  id: string;
  signal: AbortSignal;
  isConfigured: () => boolean;
  probe: () => Promise<ModelConnectivityResult>;
  add: () => Promise<void>;
  setEnabled: (enabled: boolean) => Promise<void>;
}): Promise<SyncModelProbeResult> {
  if (signal.aborted) return { id, success: false };
  const wasConfigured = isConfigured();
  let result: ModelConnectivityResult;
  try {
    result = await probe();
  } catch (error) {
    result = { success: false, error: { message: errorMessage(error) } };
  }
  // 临时检测不拥有成员；关闭后的迟到响应或被其他入口删除的旧成员都不能再写配置。
  if (signal.aborted || (wasConfigured && !isConfigured())) return { id, success: false };
  try {
    if (isConfigured()) await setEnabled(result.success);
    else if (result.success) await add();
  } catch (error) {
    return { id, success: false, stage: "save", message: errorMessage(error) };
  }
  return {
    id,
    success: result.success,
    ...(result.success ? {} : { stage: "probe", message: result.error?.message }),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runCancelablePool<TInput, TResult>({
  items,
  concurrency,
  shouldContinue,
  run,
  onResult,
}: {
  items: readonly TInput[];
  concurrency: number;
  shouldContinue: () => boolean;
  run: (item: TInput) => Promise<TResult>;
  onResult: (result: TResult) => void;
}): Promise<void> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("concurrency must be a positive integer");
  }

  let cursor = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && shouldContinue()) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (item === undefined) return;
      try {
        const result = await run(item);
        if (!shouldContinue()) return;
        onResult(result);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()));
}
