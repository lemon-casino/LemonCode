import { Emitter } from "@lcode/rpc";
import type { IRemoteBackend } from "@lcode/server/remote";
import type {
  IPromptAttachmentTransferService,
  PromptAttachmentStageResult,
  PromptAttachmentTransferProgress,
} from "@lcode/services";
import type { LCodePromptAttachment } from "@lcode/shared";
import {
  cleanupRemotePromptAttachment,
  cleanupStaleRemotePromptAttachments,
  materializeRemotePromptAttachments,
} from "./remotePromptAttachments.js";

interface TransferRecord {
  controller: AbortController;
  ref?: string;
  bytes: number;
  adopted: boolean;
}

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

/**
 * 远程 workspace 的 eager staging 实现。记录只存在当前 workspace host，
 * relay/main 不持有附件进度或暂存生命周期。
 */
export function createRemotePromptAttachmentTransferService(
  backend: Pick<IRemoteBackend, "exec" | "upload">,
  options: { onJanitorError?: (error: unknown) => void } = {},
): IPromptAttachmentTransferService {
  const records = new Map<string, TransferRecord>();
  const emitters = new Map<string, Emitter<PromptAttachmentTransferProgress>>();

  void cleanupStaleRemotePromptAttachments(backend).catch((error) => {
    options.onJanitorError?.(error);
  });

  const getEmitter = (operationId: string) => {
    const existing = emitters.get(operationId);
    if (existing) return existing;
    const emitter = new Emitter<PromptAttachmentTransferProgress>({
      onDidRemoveLastListener: () => {
        emitters.delete(operationId);
        emitter.dispose();
      },
    });
    emitters.set(operationId, emitter);
    return emitter;
  };

  const cleanup = async (operationId: string, includeAdopted: boolean) => {
    const record = records.get(operationId);
    if (!record) return;
    record.controller.abort();
    if (record.ref && (includeAdopted || !record.adopted)) {
      await cleanupRemotePromptAttachment(backend, record.ref);
    }
    records.delete(operationId);
  };

  return {
    async stage(params): Promise<PromptAttachmentStageResult> {
      await cleanup(params.operationId, false);
      const controller = new AbortController();
      const record: TransferRecord = {
        controller,
        bytes: Math.max(0, params.sizeBytes ?? 0),
        adopted: false,
      };
      records.set(params.operationId, record);
      const emitter = getEmitter(params.operationId);
      let lastPercent = -1;
      let lastEmittedAt = 0;
      let lastUploadedBytes = 0;
      const attachment: LCodePromptAttachment = {
        kind: params.mime.startsWith("image/") ? "image" : "file",
        filename: params.fileName,
        localPath: params.localPath,
        mimeType: params.mime,
        sizeBytes: params.sizeBytes ?? 0,
      } as LCodePromptAttachment;
      const workspaceKey = params.workspaceIdentity?.trim() || params.workspacePath;
      try {
        const materialized = await materializeRemotePromptAttachments(
          {
            taskId:
              params.sessionId ??
              (params.draftId
                ? `draft-${params.draftId}`
                : (() => {
                    throw new Error("Missing attachment target");
                  })()),
            // 暂存目录同时带 workspace identity 与 remote session 维度，避免同一路径、
            // 不同远端身份或 attached session 的 eager attachment 互相覆盖。
            traceId: `${workspaceKey}\u0000${params.remoteSessionId ?? ""}\u0000${params.operationId}`,
            content: "",
            attachments: [attachment],
          },
          {
            backend,
            uploadOptions: {
              signal: controller.signal,
              onProgress(progress) {
                const totalBytes = Math.max(progress.totalBytes, record.bytes);
                record.bytes = totalBytes;
                lastUploadedBytes = Math.max(lastUploadedBytes, progress.uploadedBytes);
                const percent =
                  totalBytes > 0 ? Math.floor((lastUploadedBytes / totalBytes) * 100) : 0;
                const now = Date.now();
                if (percent <= lastPercent && now - lastEmittedAt < 100) return;
                lastPercent = Math.max(lastPercent, percent);
                lastEmittedAt = now;
                emitter.fire({
                  operationId: params.operationId,
                  phase: "uploading",
                  uploadedBytes: lastUploadedBytes,
                  totalBytes,
                });
              },
            },
          },
        );
        const next = materialized.attachments?.[0];
        const ref = next?.localPath?.trim();
        if (!ref) throw new Error("Remote attachment staging returned no path");
        if (records.get(params.operationId) !== record || controller.signal.aborted) {
          throw Object.assign(new Error("Remote upload canceled"), { name: "AbortError" });
        }
        record.ref = ref;
        emitter.fire({
          operationId: params.operationId,
          phase: "committing",
          uploadedBytes: record.bytes,
          totalBytes: record.bytes,
        });
        emitter.fire({
          operationId: params.operationId,
          phase: "complete",
          uploadedBytes: record.bytes,
          totalBytes: record.bytes,
        });
        return {
          operationId: params.operationId,
          ref,
          bytes: record.bytes,
          staged: true,
        };
      } catch (error) {
        if (isAbortError(error) || controller.signal.aborted) {
          emitter.fire({
            operationId: params.operationId,
            phase: "canceled",
            uploadedBytes: 0,
            totalBytes: record.bytes,
          });
        }
        if (records.get(params.operationId) === record) {
          records.delete(params.operationId);
        }
        throw error;
      }
    },
    async adopt(operationId) {
      const record = records.get(operationId);
      if (record?.ref) {
        record.adopted = true;
        records.delete(operationId);
      }
    },
    async cancel(operationId) {
      await cleanup(operationId, false);
    },
    async cleanup(operationId) {
      await cleanup(operationId, false);
    },
    onDynamicProgress: (operationId) => getEmitter(operationId).event,
  };
}
