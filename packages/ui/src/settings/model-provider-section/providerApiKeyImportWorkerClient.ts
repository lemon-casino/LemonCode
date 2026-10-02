import type { ProviderApiKey } from "@lcode/provider";
import { ProviderApiKeyImportError } from "./providerApiKeyImport.js";

import {
  API_KEY_TRANSFER_BATCH_SIZE,
  type ProviderApiKeyWorkerRequest,
  type ProviderApiKeyWorkerResponse,
  type ProviderApiKeyWorkerResult,
  type ProviderApiKeyWorkerTask,
} from "./providerApiKeyImportWorkerProtocol.js";

export function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => {
    // 块间让出事件循环供输入/绘制使用；完成仍由 Worker 消息决定，不用延迟猜测同步状态。
    const channel = new MessageChannel();
    channel.port1.onmessage = () => {
      channel.port1.close();
      channel.port2.close();
      resolve();
    };
    channel.port2.postMessage(null);
  });
}

export function runProviderApiKeyWorker(
  draft: readonly ProviderApiKey[],
  task: ProviderApiKeyWorkerTask,
  signal: AbortSignal,
  createWorker: () => Worker = () =>
    new Worker(new URL("./providerApiKeyImport.worker.ts", import.meta.url), {
      type: "module",
      name: "zcode-api-key-import",
    }),
): Promise<ProviderApiKeyWorkerResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    let worker: Worker;
    try {
      worker = createWorker();
    } catch {
      reject(new ProviderApiKeyImportError("workerFailed"));
      return;
    }
    const chunks: ProviderApiKey[][] = [];
    let settled = false;
    const finish = (result: ProviderApiKeyWorkerResult | null, error?: unknown) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", abort);
      worker.terminate();
      if (result) resolve(result);
      else reject(error);
    };
    const abort = () => finish(null, new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    worker.onerror = () => finish(null, new ProviderApiKeyImportError("workerFailed"));
    worker.onmessageerror = () => finish(null, new ProviderApiKeyImportError("workerFailed"));
    worker.onmessage = (event: MessageEvent<ProviderApiKeyWorkerResponse>) => {
      if (settled) return;
      const message = event.data;
      if (message.type === "chunk") chunks.push(message.keys);
      if (message.type === "error") finish(null, new ProviderApiKeyImportError(message.code));
      if (message.type === "complete") {
        finish({ keys: chunks.flat(), added: message.added, duplicates: message.duplicates });
      }
    };
    void (async () => {
      try {
        await yieldToBrowser();
        for (let index = 0; index < draft.length; index += API_KEY_TRANSFER_BATCH_SIZE) {
          if (settled) return;
          worker.postMessage({
            type: "seed",
            keys: draft.slice(index, index + API_KEY_TRANSFER_BATCH_SIZE),
          } satisfies ProviderApiKeyWorkerRequest);
          await yieldToBrowser();
        }
        if (!settled)
          worker.postMessage({ type: "run", task } satisfies ProviderApiKeyWorkerRequest);
      } catch {
        finish(null, new ProviderApiKeyImportError("workerFailed"));
      }
    })();
  });
}
