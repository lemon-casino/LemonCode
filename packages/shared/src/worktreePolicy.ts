import { z } from "zod";
import type { AppSettings } from "./protocol.js";

export const sessionExecutionModeSchema = z.enum(["local", "worktree"]);
export type SessionExecutionMode = z.infer<typeof sessionExecutionModeSchema>;
/**
 * 工作树执行的环境策略。inherit 由已持久化/项目策略决定；managed 才是显式托管请求；
 * local 明确沿用 Host 本机环境。旧 Host/旧记录缺省该字段，不得据此隐式升级。
 */
export const runtimeEnvironmentPolicySchema = z.enum(["inherit", "managed", "local"]);
export type RuntimeEnvironmentPolicy = z.infer<typeof runtimeEnvironmentPolicySchema>;
export const inheritedBooleanSchema = z.enum(["inherit", "enabled", "disabled"]);
export const gitCommitReviewModeSchema = z.enum(["off", "draft", "draft-and-review"]);
export type GitCommitReviewMode = z.infer<typeof gitCommitReviewModeSchema>;
export const projectExecutionPreferenceSchema = z
  .object({
    executionMode: z.enum(["inherit", "local", "worktree"]).optional(),
    environmentPolicy: runtimeEnvironmentPolicySchema.optional(),
    gitCommitReviewMode: z.enum(["inherit", ...gitCommitReviewModeSchema.options]).optional(),
    // 旧两项仅用于兼容读取；显式统一模式（含 inherit）优先。
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

type ReviewSettings = Pick<
  AppSettings,
  "gitCommitReviewMode" | "autoGenerateGitCommitMessage" | "autoOpenGitCommitReview"
>;

function reviewModeFromLegacy(generation: boolean, opening: boolean): GitCommitReviewMode {
  return !generation ? "off" : opening ? "draft-and-review" : "draft";
}

export function resolveGlobalGitCommitReviewMode(settings: ReviewSettings): GitCommitReviewMode {
  return (
    settings.gitCommitReviewMode ??
    reviewModeFromLegacy(
      settings.autoGenerateGitCommitMessage === true,
      settings.autoOpenGitCommitReview !== false,
    )
  );
}

export function resolveProjectExecutionPolicy(
  settings: Pick<
    AppSettings,
    | "defaultSessionExecutionMode"
    | "projectExecutionPreferences"
    | "gitCommitReviewMode"
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
  const globalReviewMode = resolveGlobalGitCommitReviewMode(settings);
  // 旧全局生成关闭时仍可能默认打开审核；项目只覆盖生成时须先分别继承旧值，再归并模式。
  // 项目选择统一模式后（包括 inherit），旧字段不再参与解析，避免被合并保存的历史值反向覆盖。
  const gitCommitReviewPreference =
    project?.gitCommitReviewMode ??
    ((generation && generation !== "inherit") || (review && review !== "inherit")
      ? reviewModeFromLegacy(
          generation && generation !== "inherit"
            ? generation === "enabled"
            : settings.gitCommitReviewMode !== undefined
              ? globalReviewMode !== "off"
              : settings.autoGenerateGitCommitMessage === true,
          review && review !== "inherit"
            ? review === "enabled"
            : settings.gitCommitReviewMode !== undefined
              ? globalReviewMode === "draft-and-review"
              : settings.autoOpenGitCommitReview !== false,
        )
      : "inherit");
  const sources: Record<"executionMode" | "gitCommitReviewMode", PolicySource> = {
    executionMode: intentMode ? "session" : mode && mode !== "inherit" ? "project" : "global",
    gitCommitReviewMode: gitCommitReviewPreference === "inherit" ? "global" : "project",
  };
  return {
    executionMode:
      intentMode ??
      (mode && mode !== "inherit" ? mode : (settings.defaultSessionExecutionMode ?? "local")),
    gitCommitReviewMode:
      gitCommitReviewPreference === "inherit" ? globalReviewMode : gitCommitReviewPreference,
    gitCommitReviewPreference,
    // 默认放行仍由 Host 能力决定；inherit 不能把旧本机会话隐式升级为托管。
    environmentPreference: project?.environmentPolicy ?? "inherit",
    environmentPolicy: project?.environmentPolicy === "managed" ? "managed" as const : "local" as const,
    sources,
    setupCommands: project?.setupCommands ?? [],
    setupCommandsConfigured: project?.setupCommands !== undefined,
    copyIgnoredPaths: project?.copyIgnoredPaths ?? [],
    validationCommands: project?.validationCommands ?? [],
  };
}
