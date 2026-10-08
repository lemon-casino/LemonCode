import { z } from "zod";

const nonempty = z.string().trim().min(1).max(8192);
export const gitReviewWorkspaceScopeSchema = z
  .object({
    workspacePath: nonempty,
    workspaceIdentity: nonempty.optional(),
    scopeId: nonempty,
  })
  .strict();
export const gitReviewWorkspaceDataSchema = z
  .object({
    draft: z
      .object({
        message: z.string().max(200_000),
        previousMessage: z.string().max(200_000).nullable(),
        edited: z.boolean(),
        requiresRegeneration: z.boolean(),
      })
      .strict(),
    includeUnstaged: z.boolean(),
    excludedFiles: z.array(nonempty).max(100_000),
    selectedPaths: z.array(nonempty).max(100_000).nullable(),
    sourceReview: z.object({ id: nonempty }).strict().nullable(),
    browsePosition: z.number().int().min(0).max(20),
    mergeView: z.object({ operationId: nonempty, source: z.boolean() }).strict().nullable(),
    publicationView: z
      .object({ operationId: nonempty, view: z.enum(["push", "result"]) })
      .strict()
      .nullable()
      .optional(),
    worktreeView: z
      .object({ key: nonempty, stage: z.number().int().min(0).max(3) })
      .strict()
      .nullable(),
    integrationId: nonempty.nullable(),
    targetBranch: nonempty.nullable(),
    validationCommands: z.string().max(200_000).nullable(),
  })
  .strict();
export type GitReviewWorkspaceScope = z.infer<typeof gitReviewWorkspaceScopeSchema>;
export const gitCommitReviewReadSchema = gitReviewWorkspaceScopeSchema
  .omit({ scopeId: true })
  .extend({ reviewId: nonempty })
  .strict();
export type GitReviewWorkspaceData = z.infer<typeof gitReviewWorkspaceDataSchema>;
export const gitReviewWorkspaceFields = Object.keys(
  gitReviewWorkspaceDataSchema.shape,
) as (keyof GitReviewWorkspaceData)[];
export const gitReviewWorkspacePatchSchema = gitReviewWorkspaceDataSchema
  .partial()
  .refine((patch) => Object.keys(patch).length > 0, { message: "Empty review workspace patch" });
// 兼容旧持久快照：新浏览字段尚未写入时版本为 0，不改动其它字段或业务事实。
const revisions = z.preprocess(
  (value) =>
    value && typeof value === "object" && !Array.isArray(value) && !("publicationView" in value)
      ? { ...value, publicationView: 0 }
      : value,
  z.record(z.enum(gitReviewWorkspaceFields), z.number().int().nonnegative()),
);
export const gitReviewWorkspaceSnapshotSchema = z
  .object({
    scope: gitReviewWorkspaceScopeSchema,
    revision: z.number().int().nonnegative(),
    lastCommandId: nonempty.nullable(),
    fieldRevisions: revisions,
    data: gitReviewWorkspaceDataSchema,
  })
  .strict();
export const gitReviewWorkspaceUpdateSchema = z
  .object({
    scope: gitReviewWorkspaceScopeSchema,
    commandId: nonempty,
    expectedFieldRevisions: z.partialRecord(
      z.enum(gitReviewWorkspaceFields),
      z.number().int().nonnegative(),
    ),
    patch: gitReviewWorkspacePatchSchema,
  })
  .strict();
export type GitReviewWorkspaceSnapshot = z.infer<typeof gitReviewWorkspaceSnapshotSchema>;
export type GitReviewWorkspaceUpdate = z.infer<typeof gitReviewWorkspaceUpdateSchema>;
export const gitReviewWorkspaceUpdateResultSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("accepted"),
      commandRevision: z.number().int().positive(),
      snapshot: gitReviewWorkspaceSnapshotSchema,
    })
    .strict(),
  z
    .object({
      status: z.literal("conflict"),
      snapshot: gitReviewWorkspaceSnapshotSchema,
    })
    .strict(),
]);
export type GitReviewWorkspaceUpdateResult = z.infer<typeof gitReviewWorkspaceUpdateResultSchema>;
export function createGitReviewWorkspaceSnapshot(
  scope: GitReviewWorkspaceScope,
): GitReviewWorkspaceSnapshot {
  return {
    scope,
    revision: 0,
    lastCommandId: null,
    fieldRevisions: Object.fromEntries(
      gitReviewWorkspaceFields.map((field) => [field, 0]),
    ) as GitReviewWorkspaceSnapshot["fieldRevisions"],
    data: {
      draft: { message: "", previousMessage: null, edited: false, requiresRegeneration: false },
      includeUnstaged: true,
      excludedFiles: [],
      selectedPaths: null,
      sourceReview: null,
      browsePosition: 0,
      mergeView: null,
      publicationView: null,
      worktreeView: null,
      integrationId: null,
      targetBranch: null,
      validationCommands: null,
    },
  };
}
export function gitReviewWorkspaceKey(scope: GitReviewWorkspaceScope): string {
  return JSON.stringify([scope.workspaceIdentity?.trim() || scope.workspacePath, scope.scopeId]);
}
