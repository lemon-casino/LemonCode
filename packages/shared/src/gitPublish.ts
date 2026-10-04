import { z } from "zod";
import { gitCommitReviewSelectionSchema } from "./gitCommitReview.js";

// 中文依据：RPC 输入不可信；只接受引用名，不能让选项、refspec 或 revision 表达式扩大发布范围。
const refName = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (name) =>
      !/^[+-]/.test(name) &&
      name !== "@" &&
      !name.startsWith("refs/") &&
      ![...name].some(
        (character) =>
          character.charCodeAt(0) <= 32 ||
          character.charCodeAt(0) === 127 ||
          "~^:?*[\\".includes(character),
      ) &&
      !name.includes("..") &&
      !name.includes("@{") &&
      !name.endsWith(".") &&
      name
        .split("/")
        .every((part) => part.length > 0 && !part.startsWith(".") && !part.endsWith(".lock")),
    "Invalid Git reference name",
  );
const oid = z.string().regex(/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/);
const path = z
  .string()
  .min(1)
  .refine((value) => !value.includes("\0"));
export const gitRepositoryRequestSchema = z
  .object({
    workspacePath: path,
    workspaceIdentity: z.string().optional(),
  })
  .strict();
export const gitPublicationRequestSchema = gitRepositoryRequestSchema
  .extend({ sourceBranch: refName.optional() })
  .strict();
export const gitPublishStateSchema = z
  .object({
    headCommitHash: oid.nullable(),
    branchName: z.string().min(1).nullable(),
    indexFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    worktreeFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
  })
  .strict();
export const gitDeleteBranchRequestSchema = gitRepositoryRequestSchema
  .extend({
    branchName: z.string().min(1).max(255),
    expectedCommitHash: z.string().regex(/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/i),
  })
  .strict();

export const gitPushRequestSchema = gitPublicationRequestSchema
  .extend({
    remote: refName.optional(),
    branch: refName.optional(),
    tag: refName.optional(),
    tagCommitHash: oid.optional(),
    expectedState: gitPublishStateSchema.optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    const explicit =
      value.remote !== undefined ||
      value.branch !== undefined ||
      value.tag !== undefined ||
      value.tagCommitHash !== undefined ||
      value.sourceBranch !== undefined;
    if (explicit && (!value.remote || Boolean(value.branch) === Boolean(value.tag))) {
      ctx.addIssue({
        code: "custom",
        message: "Explicit push requires a remote and exactly one branch or tag",
      });
    }
    if (value.tagCommitHash && !value.tag) {
      ctx.addIssue({ code: "custom", message: "tagCommitHash requires a tag" });
    }
  });
export const gitCreateTagRequestSchema = gitPublicationRequestSchema
  .extend({
    name: refName,
    ref: oid.optional(),
    expectedState: gitPublishStateSchema.optional(),
  })
  .strict();
export const gitRemoteInfoSchema = z.object({ name: z.string().min(1), url: z.string() }).strict();
export const gitRemoteListResultSchema = z
  .object({ remotes: z.array(gitRemoteInfoSchema) })
  .strict();
export const gitTagInfoSchema = z.object({ name: z.string().min(1), commitHash: oid }).strict();
export const gitUnsupportedTagInfoSchema = z
  .object({ name: z.string().min(1), objectType: z.enum(["tree", "blob"]) })
  .strict();
export const gitTagListResultSchema = z
  .object({
    tags: z.array(gitTagInfoSchema),
    unsupportedTags: z.array(gitUnsupportedTagInfoSchema).optional(),
  })
  .strict();
export const gitCreateTagResultSchema = gitTagInfoSchema.extend({ created: z.boolean() }).strict();
export const gitCommitRequestSchema = gitRepositoryRequestSchema
  .extend({
    message: z
      .string()
      .refine((value) => value.trim().length > 0, "Commit message cannot be empty"),
    paths: z.array(path).min(1).optional(),
    stagedOnly: z.boolean().optional(),
    review: gitCommitReviewSelectionSchema.optional(),
    expectedState: gitPublishStateSchema.optional(),
  })
  .strict();
export const gitGenerateCommitMessageRequestSchema = gitRepositoryRequestSchema
  .extend({
    review: z.boolean().optional(),
    locale: z.enum(["zh-CN", "en-US"]).optional(),
    includeUnstaged: z.boolean().optional(),
    currentSessionFilePaths: z.array(path).optional(),
    excludedFilePaths: z.array(path).optional(),
    conversationContext: z
      .object({
        sessionId: z.string().optional(),
        omittedMessageCount: z.number().int().nonnegative().optional(),
        messages: z.array(
          z.object({ role: z.enum(["user", "assistant"]), content: z.string() }).strict(),
        ),
      })
      .strict()
      .optional(),
  })
  .strict();
