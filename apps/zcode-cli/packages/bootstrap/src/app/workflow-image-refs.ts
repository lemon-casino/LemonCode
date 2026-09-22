import { stat } from "node:fs/promises";
import type { ToolArtifactStorePort } from "@zcode/contracts";
import type { WorkflowImageRef } from "@zcode/dynamic-workflow";

/** 对图片引用做准入检查，避免运行时把失效图片降级成纯文字占位。 */
export async function verifyWorkflowImageRefs(
  refs: readonly WorkflowImageRef[] | undefined,
  artifactStore?: ToolArtifactStorePort,
): Promise<boolean> {
  if (refs === undefined || refs.length === 0) return true;
  if (refs.length > 8) return false;
  try {
    for (const ref of refs) {
      if (
        !ref.mime.toLowerCase().startsWith("image/") || ref.mime.length > 128 ||
        !ref.ref || ref.ref.length > 4096 || !ref.fileName || ref.fileName.length > 255 ||
        !Number.isSafeInteger(ref.bytes) || ref.bytes < 0
      ) return false;
      if (ref.ref.startsWith("zcode-artifact://")) {
        if (!artifactStore) return false;
        const artifact = await artifactStore.readToolResultArtifact({ uri: ref.ref });
        if (!artifact.content.startsWith("data:image/")) return false;
      } else {
        if (/^[a-z][a-z\d+.-]*:\/\//i.test(ref.ref)) return false;
        if (!(await stat(ref.ref)).isFile()) return false;
      }
    }
    return true;
  } catch {
    return false;
  }
}

export function workflowImageTurnAttachments(refs: readonly WorkflowImageRef[] | undefined) {
  return refs?.map((ref) => ({
    type: "image" as const,
    ...(ref.ref.startsWith("zcode-artifact://")
      ? { content: ref.ref, path: ref.fileName }
      : { path: ref.ref }),
    filename: ref.fileName,
    mimeType: ref.mime,
    sizeBytes: ref.bytes,
  }));
}
