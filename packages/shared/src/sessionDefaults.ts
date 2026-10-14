import { z } from "zod";
import { modelSelectionSchema } from "./model-selection.js";
import type { AppSettings } from "./protocol.js";

/** 审批使用现有 Submission mode；计划是独立意图，不属于默认审批策略。 */
export const sessionApprovalModeSchema = z.enum(["build", "edit", "yolo"]);
export const sessionDefaultsShape = {
  defaultSessionModelSelection: modelSelectionSchema.nullable().optional(),
  defaultSessionApprovalMode: sessionApprovalModeSchema.nullable().optional(),
};
export interface SessionDefaults {
  modelSelection?: z.infer<typeof modelSelectionSchema>;
  approvalMode?: z.infer<typeof sessionApprovalModeSchema>;
}

export function resolveSessionDefaults(
  settings: Pick<
    AppSettings,
    "defaultSessionModelSelection" | "defaultSessionApprovalMode" | "projectExecutionPreferences"
  >,
  scope: { workspacePath: string; workspaceIdentity?: string },
): SessionDefaults {
  const project =
    settings.projectExecutionPreferences?.[scope.workspaceIdentity?.trim() || scope.workspacePath];
  return {
    modelSelection:
      project?.defaultSessionModelSelection ?? settings.defaultSessionModelSelection ?? undefined,
    approvalMode:
      project?.defaultSessionApprovalMode ?? settings.defaultSessionApprovalMode ?? undefined,
  };
}
