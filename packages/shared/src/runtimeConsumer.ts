import { z } from "zod";

const text = z.string().trim().min(1).max(4096);
const id = z.string().regex(/^[a-f0-9]{32}$/);
const generation = z.number().int().positive();
const scope = { workspacePath: text, workspaceIdentity: text.optional() };

export const runtimeEnvironmentBindingReferenceSchema = z
  .object({
    environmentId: id,
    /** 绑定记录兼容 preparation 的未完成 revision=0；消费/执行引用仍要求正 revision。 */
    revision: z.number().int().nonnegative(),
    manifestDigest: text.optional(),
  })
  .strict();
export type RuntimeEnvironmentBindingReference = z.infer<
  typeof runtimeEnvironmentBindingReferenceSchema
>;

export const runtimeEnvironmentReferenceSchema = z
  .object({
    environmentId: id,
    revision: z.number().int().positive(),
    /** 新环境实现可用完整冻结摘要对账；旧引用缺省仍按 environmentId+revision 兼容读取。 */
    manifestDigest: text.optional(),
  })
  .strict();
export type RuntimeEnvironmentReference = z.infer<typeof runtimeEnvironmentReferenceSchema>;

export const runtimeConsumerKindSchema = z.enum([
  "session",
  "process",
  "terminal",
  "mcp",
  "command",
  "service",
  "candidate",
]);
export const runtimeConsumerReferenceSchema = z
  .object({
    environmentId: id,
    kind: runtimeConsumerKindSchema,
    id: text,
    revision: z.number().int().positive(),
    ownerId: text,
    ownerGeneration: generation,
    lease: text,
    state: z.enum(["active", "released"]),
    createdAt: text,
    updatedAt: text,
  })
  .strict();
export type RuntimeConsumerReference = z.infer<typeof runtimeConsumerReferenceSchema>;

export const runtimeConsumerAcquireParamsSchema = z
  .object({
    ...scope,
    ...runtimeEnvironmentReferenceSchema.shape,
    kind: runtimeConsumerKindSchema,
    id: text,
    ownerId: text,
    expectedOwnerGeneration: z.number().int().nonnegative().optional(),
  })
  .strict();
export type RuntimeConsumerAcquireParams = z.infer<typeof runtimeConsumerAcquireParamsSchema>;

export const runtimeConsumerReleaseParamsSchema = z
  .object({
    ...scope,
    environmentId: id,
    kind: runtimeConsumerKindSchema,
    id: text,
    ownerId: text,
    ownerGeneration: generation,
    lease: text,
  })
  .strict();
export type RuntimeConsumerReleaseParams = z.infer<typeof runtimeConsumerReleaseParamsSchema>;
export const runtimeConsumerReleaseResultSchema = z
  .object({ removed: z.number().int().nonnegative(), remaining: z.number().int().nonnegative() })
  .strict();
export type RuntimeConsumerReleaseResult = z.infer<typeof runtimeConsumerReleaseResultSchema>;

export const runtimeConsumerSessionDeletionParamsSchema = z
  .object({ ...scope, environmentId: id, bindingId: text, sessionIds: z.array(text).max(4096) })
  .strict();
export type RuntimeConsumerSessionDeletionParams = z.infer<
  typeof runtimeConsumerSessionDeletionParamsSchema
>;

// 请求只携带绑定身份，内部 owner/代际/lease 由 Host client 所有者派生。
const executionIdentity = {
  sessionId: text,
  executionBindingId: text,
  workspaceIdentity: text.optional(),
  remoteSessionId: text.optional(),
};
export const runtimeEnvironmentRetainSessionParamsSchema = z
  .object({
    ...executionIdentity,
    workspacePath: text,
    environmentRef: runtimeEnvironmentReferenceSchema,
  })
  .strict();
export type RuntimeEnvironmentRetainSessionParams = z.infer<
  typeof runtimeEnvironmentRetainSessionParamsSchema
>;
export const runtimeEnvironmentRetainSessionResultSchema = z
  .object({ retained: z.literal(true) })
  .strict();

export const runtimeEnvironmentReleaseConsumerParamsSchema = z
  .object({ ...executionIdentity, environmentId: id, consumer: text })
  .strict();
export type RuntimeEnvironmentReleaseConsumerParams = z.infer<
  typeof runtimeEnvironmentReleaseConsumerParamsSchema
>;
export const runtimeEnvironmentReleaseConsumerResultSchema = runtimeConsumerReleaseResultSchema;
export type RuntimeEnvironmentReleaseConsumerResult = RuntimeConsumerReleaseResult;
