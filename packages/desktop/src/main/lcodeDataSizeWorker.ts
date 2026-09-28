import { isMainThread, parentPort, workerData } from "node:worker_threads";

import { scanLCodeDataDirectory, type LCodeDataSizeScanRequest } from "./lcodeDataSizeScanner.js";

type WorkerResponse =
  | { ok: true; result: Awaited<ReturnType<typeof scanLCodeDataDirectory>> }
  | { ok: false; error: string };

const workerParentPort = parentPort;
if (!isMainThread && workerParentPort) {
  void scanLCodeDataDirectory(workerData as LCodeDataSizeScanRequest)
    .then((result) => {
      workerParentPort.postMessage({ ok: true, result } satisfies WorkerResponse);
    })
    .catch((error) => {
      workerParentPort.postMessage({
        ok: false,
        error: error instanceof Error ? error.message : "unknown worker error",
      } satisfies WorkerResponse);
    });
}
