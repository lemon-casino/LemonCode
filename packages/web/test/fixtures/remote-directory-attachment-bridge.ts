import type {
  IServiceAccessor,
  PromptAttachmentStageParams,
  PromptAttachmentStageResult,
  PromptAttachmentTransferProgress,
} from "@lcode/services";
import type { IPlatformService } from "@lcode/shared";

interface TestBridge {
  __folderLocalPath: string;
  __folderStage(params: PromptAttachmentStageParams): Promise<PromptAttachmentStageResult>;
  __folderCancel(operationId: string): Promise<void>;
  __folderAdopt(operationId: string): Promise<void>;
  __folderProgress(progress: PromptAttachmentTransferProgress): void;
}

/** Browser bridge calls the actual Node Host service; no ready result is fabricated here. */
export function installRemoteDirectoryAttachmentBridge(
  services: IServiceAccessor,
  platform: IPlatformService,
): IPlatformService {
  const bridge = globalThis as unknown as TestBridge;
  const events = new Map<string, Set<(progress: PromptAttachmentTransferProgress) => void>>();
  bridge.__folderProgress = (progress) =>
    events.get(progress.operationId)?.forEach((listener) => listener(progress));
  services.promptAttachmentTransferService = {
    stage: (params) => bridge.__folderStage(params),
    cancel: (id) => bridge.__folderCancel(id),
    cleanup: (id) => bridge.__folderCancel(id),
    adopt: (id) => bridge.__folderAdopt(id),
    onDynamicProgress: (id) => {
      return (listener) => {
        let listeners = events.get(id);
        if (!listeners) {
          listeners = new Set();
          events.set(id, listeners);
        }
        listeners.add(listener);
        return {
          dispose: () => {
            listeners.delete(listener);
          },
        };
      };
    },
  };
  return { ...platform, getPathForFile: () => bridge.__folderLocalPath };
}
