import { useEffect, useState } from "react";
import type { PatchCodeViewerSource, ReviewPreviewFile } from "@/lib/codeViewer.js";
import { useWorkspaceServices } from "@/hooks/useWorkspaceServices.js";
import { getErrorMessage } from "@/lib/errorMessage.js";

export function useReviewFileDiff(
  source: PatchCodeViewerSource,
  file?: ReviewPreviewFile,
): { patch: string; loading: boolean; error?: string } {
  const { gitService } = useWorkspaceServices(
    source.workspacePath,
    source.workspaceRemoteSessionId,
    source.workspaceIdentity,
  );
  const [result, setResult] = useState<{ key: string; patch: string; error?: string } | null>(null);
  const key = JSON.stringify([
    source.reviewReturnToken,
    source.workspaceIdentity ?? source.workspacePath,
    file?.path,
    file?.staged,
  ]);
  useEffect(() => {
    if (!file || file.patch !== undefined || !source.workspacePath) return;
    let active = true;
    void gitService
      .getDiff({
        workspacePath: source.workspacePath,
        workspaceIdentity: source.workspaceIdentity,
        path: file.path,
        staged: file.staged,
      })
      .then(
        (diff) => {
          if (active)
            setResult({
              key,
              patch: diff.patch ?? "",
              ...(diff.availability !== "patch"
                ? { error: diff.summary ?? diff.availability }
                : {}),
            });
        },
        (error: unknown) => {
          if (active) setResult({ key, patch: "", error: getErrorMessage(error) });
        },
      );
    return () => {
      active = false;
    };
  }, [key, file, gitService, source.workspacePath, source.workspaceIdentity]);
  if (file?.patch !== undefined) return { patch: file.patch, loading: false };
  return result?.key === key
    ? { ...result, loading: false }
    : { patch: "", loading: Boolean(file) };
}
