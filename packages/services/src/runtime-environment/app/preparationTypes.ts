import type {
  FrozenManifest,
  RuntimeEnvironmentError,
  RuntimeEnvironmentRecord,
  RuntimePreparationOperation,
} from "@lcode/shared";
import type { RuntimeEnvironmentPrepareRequest } from "../contract.js";
import type {
  DeclarationReaderPort,
  DependencyInstallPort,
  RuntimeEnvironmentStore,
  ToolBackendPort,
} from "./ports.js";

export interface PreparationOptions {
  store: RuntimeEnvironmentStore;
  backend: ToolBackendPort;
  declarations: DeclarationReaderPort;
  stamp(): string;
  managed: boolean;
  missingReason?: string;
  appDefaultTools: ReadonlyArray<{ key: string; version: string }>;
  backendVersion: string;
  dependencies?: DependencyInstallPort;
  dependencyResourceRoot?: string;
  ensureResources?: (environmentId: string) => Promise<NonNullable<FrozenManifest["resources"]>>;
  acquireWriter?: (params: {
    workspacePath: string;
    ownerId: string;
  }) => Promise<() => Promise<void>>;
}
export interface PreparationRun {
  params: RuntimeEnvironmentPrepareRequest;
  operation: RuntimePreparationOperation;
  record: RuntimeEnvironmentRecord;
  release: () => Promise<void>;
}
export function preparationError(
  code: RuntimeEnvironmentError["code"],
  stage: RuntimeEnvironmentError["stage"],
  message: string,
): RuntimeEnvironmentError {
  return {
    code,
    stage,
    message: message.slice(0, 8192),
    retryable: !["unsupported-declaration", "scope-mismatch"].includes(code),
  };
}
