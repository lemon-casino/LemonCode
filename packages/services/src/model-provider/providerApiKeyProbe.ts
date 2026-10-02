import type { ProviderApiKeyProbeResult } from "./providerCatalogClient.js";

export interface ProviderApiKeyProbeProgress {
  readonly total: number;
  readonly completed: number;
  readonly results: readonly ProviderApiKeyProbeResult[];
}

export interface ProviderApiKeyProbeOptions {
  readonly signal?: AbortSignal;
  readonly onProgress?: (progress: ProviderApiKeyProbeProgress) => void;
  readonly timeoutMs?: number;
}

export async function runProviderApiKeyProbe<T extends { id: string }>(
  keys: readonly T[],
  probe: (key: T, signal: AbortSignal) => Promise<ProviderApiKeyProbeResult>,
  options: ProviderApiKeyProbeOptions = {},
): Promise<readonly ProviderApiKeyProbeResult[]> {
  // 修复：Promise.all(keys.map(...)) 会同时创建十万条网络请求；只创建固定的八个消费者。
  const results: (ProviderApiKeyProbeResult | undefined)[] = [];
  let cursor = 0;
  let completed = 0;
  let pending: ProviderApiKeyProbeResult[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    const batch = pending;
    pending = [];
    options.onProgress?.({ total: keys.length, completed, results: batch });
  };
  options.onProgress?.({ total: keys.length, completed: 0, results: [] });
  const timer = setInterval(flush, 100);
  try {
    await Promise.all(
      Array.from({ length: Math.min(8, keys.length) }, async () => {
        let processed = 0;
        while (cursor < keys.length && !options.signal?.aborted) {
          const index = cursor++;
          const key = keys[index]!;
          const controller = new AbortController();
          const signal = options.signal
            ? AbortSignal.any([options.signal, controller.signal])
            : controller.signal;
          const deadline = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000);
          try {
            const result = await new Promise<ProviderApiKeyProbeResult>((resolve, reject) => {
              const abort = () => {
                signal.removeEventListener("abort", abort);
                reject(new DOMException("Aborted", "AbortError"));
              };
              signal.addEventListener("abort", abort, { once: true });
              // 同时监听信号与 Promise，防止忽略 AbortSignal 的网络适配器无限占住槽位。
              Promise.resolve()
                .then(() => probe(key, signal))
                .then(resolve, reject)
                .finally(() => signal.removeEventListener("abort", abort));
              if (signal.aborted) abort();
            });
            if (options.signal?.aborted) return;
            results[index] = result;
          } catch (error) {
            if (options.signal?.aborted) return;
            results[index] = {
              keyId: key.id,
              status: "error",
              message: controller.signal.aborted
                ? "Request timed out"
                : error instanceof Error
                  ? error.message
                  : String(error),
            };
          } finally {
            clearTimeout(deadline);
          }
          completed++;
          pending.push(results[index]!);
          if (pending.length === 64) flush();
          // 快速响应也分段让出事件循环，确保取消命令和进度事件有机会被处理。
          if (++processed % 32 === 0) await new Promise<void>((resolve) => setTimeout(resolve, 0));
        }
      }),
    );
  } finally {
    clearInterval(timer);
    flush();
  }
  return results.filter((result): result is ProviderApiKeyProbeResult => result !== undefined);
}
