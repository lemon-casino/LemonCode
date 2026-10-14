import { createNodeFileSystemAdapter } from "@lcode/adapters/fs";
import type { FileSystemPort, ModelSelection, ToolArtifactStorePort } from "@lcode/contracts";
import type { ProviderRegistryModelSource } from "./provider-registry-model-runtime.js";
import { getRegistryBackedModel } from "./provider-registry-selection.js";

export interface ConversationReadPorts {
  artifactStore: ToolArtifactStorePort;
  fileSystemPort: FileSystemPort;
  modelContextWindow?(selection: ModelSelection): number | undefined;
}

/** 复用进程既有产物 store 和模型目录；只读详情不经过 app factory。 */
export function createConversationReadPorts(
  artifactStore: ToolArtifactStorePort,
  registry: ProviderRegistryModelSource,
): ConversationReadPorts {
  return {
    artifactStore,
    fileSystemPort: createNodeFileSystemAdapter(),
    modelContextWindow: (selection) => getRegistryBackedModel(registry, selection)?.contextWindow,
  };
}
