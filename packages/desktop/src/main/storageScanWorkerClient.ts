/**
 * ScanRunnerPort 的 Worker 实现：每次扫描起一个 worker_threads，主线程只接收节流后的快��。
 * 取消时先发 abort 让 Worker 收敛，随后无论如何 terminate，保证 main 不会残留遍历线程。
 */
import { Worker } from "node:worker_threads";
import type { StorageScanProgress, StorageScanRunnerPort } from "@lcode/services/node";
import {
  isStorageScanWorkerMessage,
  type StorageScanWorkerData,
} from "./storageScanWorkerProtocol.js";

const DEFAULT_PROGRESS_INTERVAL_MS = 300;
const ABORT_GRACE_MS = 500;

function abortError(): Error {
  return new DOMException("storage scan aborted", "AbortError");
}

export function createStorageScanWorkerRunner(
  options: { progressIntervalMs?: number; workerUrl?: URL } = {},
): StorageScanRunnerPort {
  const workerUrl = options.workerUrl ?? new URL("./storageScanWorker.js", import.meta.url);
  const progressIntervalMs = options.progressIntervalMs ?? DEFAULT_PROGRESS_INTERVAL_MS;
  return {
    run: ({ roots, signal, onProgress }) =>
      new Promise<StorageScanProgress>((resolve, reject) => {
        const workerData: StorageScanWorkerData = { roots, progressIntervalMs };
        const worker = new Worker(workerUrl, { workerData });
        let settled = false;
        let graceTimer: NodeJS.Timeout | null = null;
        const finish = (run: () => void) => {
          if (settled) return;
          settled = true;
          signal.removeEventListener("abort", onAbort);
          if (graceTimer) clearTimeout(graceTimer);
          void worker.terminate();
          run();
        };
        const onAbort = () => {
          worker.postMessage({ type: "abort" });
          graceTimer = setTimeout(() => finish(() => reject(abortError())), ABORT_GRACE_MS);
          graceTimer.unref?.();
        };
        worker.on("message", (message: unknown) => {
          if (!isStorageScanWorkerMessage(message)) return;
          if (message.type === "progress") {
            if (!settled) onProgress(message.progress);
            return;
          }
          if (message.type === "done") {
            finish(() => resolve(message.progress));
            return;
          }
          if (message.type === "aborted") {
            finish(() => reject(abortError()));
            return;
          }
          finish(() => reject(Object.assign(new Error(message.message), { code: message.code })));
        });
        worker.once("error", (error) => finish(() => reject(error)));
        worker.once("exit", (code) => {
          if (code !== 0) {
            finish(() => reject(new Error(`storage scan worker exited with code ${code}`)));
          }
        });
        if (signal.aborted) {
          finish(() => reject(abortError()));
          return;
        }
        signal.addEventListener("abort", onAbort, { once: true });
        worker.unref();
      }),
  };
}
