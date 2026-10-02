import type { ProviderApiKey } from "@lcode/provider";
import { normalizeProviderApiKeys } from "./providerApiKeys.js";
import {
  mergeProviderApiKeyImport,
  parseProviderApiKeyImport,
  ProviderApiKeyImportError,
  readProviderApiKeyImportFiles,
} from "./providerApiKeyImport.js";
import { removeInvalidProviderApiKeys } from "./providerApiKeyList.js";
import {
  API_KEY_TRANSFER_BATCH_SIZE,
  type ProviderApiKeyWorkerRequest,
  type ProviderApiKeyWorkerResponse,
} from "./providerApiKeyImportWorkerProtocol.js";

const snapshot: ProviderApiKey[] = [];
const send = (message: ProviderApiKeyWorkerResponse) => self.postMessage(message);

self.onmessage = async (event: MessageEvent<ProviderApiKeyWorkerRequest>) => {
  const message = event.data;
  if (message.type === "seed") {
    snapshot.push(...message.keys);
    return;
  }
  try {
    const task = message.task;
    let keys: ProviderApiKey[];
    let added = 0;
    let duplicates = 0;
    if (task.kind === "import") {
      const imported =
        typeof task.source === "string"
          ? parseProviderApiKeyImport(task.source)
          : await readProviderApiKeyImportFiles(task.source);
      const result = mergeProviderApiKeyImport(snapshot, imported);
      keys = result.draft.slice(snapshot.length);
      added = result.added;
      duplicates = result.duplicates;
    } else if (task.kind === "normalize") {
      keys = normalizeProviderApiKeys(snapshot);
    } else {
      keys = removeInvalidProviderApiKeys(snapshot, new Set(task.invalidIds));
    }
    for (let index = 0; index < keys.length; index += API_KEY_TRANSFER_BATCH_SIZE) {
      send({ type: "chunk", keys: keys.slice(index, index + API_KEY_TRANSFER_BATCH_SIZE) });
    }
    send({ type: "complete", added, duplicates });
  } catch (error) {
    send({
      type: "error",
      code: error instanceof ProviderApiKeyImportError ? error.code : "workerFailed",
    });
  }
};
