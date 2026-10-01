import type { WorkspaceCheckpointArtifact } from "@lcode/contracts";
import { applyPatch, type StructuredPatch } from "diff";

export function resolveWorkspaceCheckpointAfterContent(
  file: WorkspaceCheckpointArtifact["files"][number],
): string | undefined {
  if (typeof file.afterContent === "string") return file.afterContent;
  if (!file.existedBefore && file.beforeContent === null && file.structuredPatch.length === 0)
    return undefined;
  const patch: StructuredPatch = {
    oldFileName: file.path,
    newFileName: file.path,
    oldHeader: undefined,
    newHeader: undefined,
    hunks: file.structuredPatch,
  };
  // Edit 只返回精确 structuredPatch；禁用模糊匹配和隐式换行转换才能把补丁作为归属证据。
  const content = applyPatch(file.beforeContent ?? "", patch, {
    autoConvertLineEndings: false,
    fuzzFactor: 0,
  });
  return typeof content === "string" ? content : undefined;
}
