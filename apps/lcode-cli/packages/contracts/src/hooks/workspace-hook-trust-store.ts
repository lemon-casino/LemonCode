/**
 * Trust store 文件 schema 已下沉到 `@lcode/shared/workspace-hook-trust-store-file`
 * 作为单一权威实现（services 层无法依赖 apps 下的 contracts，
 * 只好手写局部校验，导致 UI 与 runtime 对同一损坏文件结论分裂）。
 *
 * 此处 re-export 保持 contracts 既有 import 路径（adapters/bootstrap/core 等）
 * 不变；shared 与 contracts 分属 zod4 / zod3 实例，本 re-export 不得被
 * contracts 内部的 zod3 schema 组合引用。
 */
export {
  WORKSPACE_HOOK_TRUST_STORE_SCHEMA_VERSION,
  workspaceHookTrustRecordSchema,
  workspaceHookTrustStoreFileSchema,
} from "@lcode/shared/workspace-hook-trust-store-file";
export type {
  WorkspaceHookTrustRecord,
  WorkspaceHookTrustStoreFile,
} from "@lcode/shared/workspace-hook-trust-store-file";

import { z } from "zod";

const nonEmptyStringSchema = z.string().trim().min(1);

export const workspaceHookPolicySchema = z.discriminatedUnion("mode", [
  z
    .object({
      mode: z.literal("deny"),
      reason: nonEmptyStringSchema,
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("user_decides"),
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
  z
    .object({
      mode: z.literal("allow_trusted_only"),
      reason: nonEmptyStringSchema.optional(),
      policyRevision: nonEmptyStringSchema,
    })
    .strict(),
]);
export type WorkspaceHookPolicy = z.infer<typeof workspaceHookPolicySchema>;
