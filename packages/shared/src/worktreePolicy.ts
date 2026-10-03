import { z } from "zod";
import type { AppSettings } from "./protocol.js";

export const sessionExecutionModeSchema = z.enum(["local", "worktree"]);
export type SessionExecutionMode = z.infer<typeof sessionExecutionModeSchema>;
export const inheritedBooleanSchema = z.enum(["inherit", "enabled", "disabled"]);
export const projectExecutionPreferenceSchema = z
  .object({
    executionMode: z.enum(["inherit", "local", "worktree"]).optional(),
    autoGenerateGitCommitMessage: inheritedBooleanSchema.optional(),
    autoOpenGitCommitReview: inheritedBooleanSchema.optional(),
    setupCommands: z.array(z.string().trim().min(1)).optional(),
    copyIgnoredPaths: z.array(z.string().trim().min(1)).optional(),
    validationCommands: z.array(z.string().trim().min(1)).optional(),
  })
  .strict();
export const projectExecutionPreferencesSchema = z.record(
  z.string().trim().min(1),
  projectExecutionPreferenceSchema,
);
export type ProjectExecutionPreference = z.infer<typeof projectExecutionPreferenceSchema>;
type PolicySource = "global" | "project" | "session";

export function resolveProjectExecutionPolicy(
  settings: Pick<
    AppSettings,
    | "defaultSessionExecutionMode"
    | "projectExecutionPreferences"
    | "autoGenerateGitCommitMessage"
    | "autoOpenGitCommitReview"
  >,
  scope: { workspacePath: string; workspaceIdentity?: string },
  intentMode?: SessionExecutionMode,
) {
  const key = scope.workspaceIdentity?.trim() || scope.workspacePath;
  const project = settings.projectExecutionPreferences?.[key];
  const mode = project?.executionMode;
  const generation = project?.autoGenerateGitCommitMessage;
  const review = project?.autoOpenGitCommitReview;
  const sources: Record<
    "executionMode" | "autoGenerateGitCommitMessage" | "autoOpenGitCommitReview",
    PolicySource
  > = {
    executionMode: intentMode ? "session" : mode && mode !== "inherit" ? "project" : "global",
    autoGenerateGitCommitMessage: generation && generation !== "inherit" ? "project" : "global",
    autoOpenGitCommitReview: review && review !== "inherit" ? "project" : "global",
  };
  return {
    executionMode:
      intentMode ??
      (mode && mode !== "inherit" ? mode : (settings.defaultSessionExecutionMode ?? "local")),
    autoGenerateGitCommitMessage:
      generation && generation !== "inherit"
        ? generation === "enabled"
        : settings.autoGenerateGitCommitMessage === true,
    autoOpenGitCommitReview:
      review && review !== "inherit"
        ? review === "enabled"
        : settings.autoOpenGitCommitReview !== false,
    sources,
    setupCommands: project?.setupCommands ?? [],
    copyIgnoredPaths: project?.copyIgnoredPaths ?? [],
    validationCommands: project?.validationCommands ?? [],
  };
}
