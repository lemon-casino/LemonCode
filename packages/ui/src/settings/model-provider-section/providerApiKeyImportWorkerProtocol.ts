import type { ProviderApiKey } from "@zcode/provider";
import type { ProviderApiKeyImportError } from "./providerApiKeyImport.js";

export const API_KEY_TRANSFER_BATCH_SIZE = 2_000;
export type ProviderApiKeyWorkerTask =
  | { kind: "import"; source: string | File[] }
  | { kind: "normalize" }
  | { kind: "removeInvalid"; invalidIds: string[] };
export type ProviderApiKeyWorkerRequest =
  | { type: "seed"; keys: ProviderApiKey[] }
  | { type: "run"; task: ProviderApiKeyWorkerTask };
export type ProviderApiKeyWorkerResponse =
  | { type: "chunk"; keys: ProviderApiKey[] }
  | { type: "complete"; added: number; duplicates: number }
  | { type: "error"; code: ProviderApiKeyImportError["code"] };
export interface ProviderApiKeyWorkerResult {
  keys: ProviderApiKey[];
  added: number;
  duplicates: number;
}
