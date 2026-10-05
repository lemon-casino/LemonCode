import { z } from "zod";

/**
 * 运行环境协议类型（spec: specs/worktree-runtime-environments.md §8/§9）。
 * 只暴露协议所需字段；token/lease 仅内部，不进协议与 UI 投影。
 */

const text = z.string().trim().min(1);
const environmentId = z.string().regex(/^[a-f0-9]{32}$/, "environmentId must be a 32-char hex id");
const revision = z.number().int().nonnegative();

/** 工作树/候选用途；后续可扩展实际本地 checkout（spec §8.1）。 */
export const runtimeEnvironmentPurposeSchema = z.enum(["worktree", "integration-candidate"]);
export type RuntimeEnvironmentPurpose = z.infer<typeof runtimeEnvironmentPurposeSchema>;

export const runtimeEnvironmentScopeSchema = z
  .object({
    workspacePath: text,
    workspaceIdentity: text.optional(),
  })
  .strict();
export type RuntimeEnvironmentScope = z.infer<typeof runtimeEnvironmentScopeSchema>;

/** 环境状态机（spec §10.1）；releasing/releaseBlocked 是 owner 结算后的持久状态。 */
export const runtimeEnvironmentStatusSchema = z.enum([
  "allocated",
  "resolvingTools",
  "installingTools",
  "preparingDependencies",
  "ready",
  "needsUpdate",
  "failed",
  "cancelling",
  "cancelled",
  "releasing",
  "releaseBlocked",
  "released",
]);
export type RuntimeEnvironmentStatus = z.infer<typeof runtimeEnvironmentStatusSchema>;

/** 准备操作状态（幂等、断点与崩溃对账的载体，spec §8.2 PreparationOperation）。 */
export const runtimePreparationOperationStatusSchema = z.enum([
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);
export type RuntimePreparationOperationStatus = z.infer<
  typeof runtimePreparationOperationStatusSchema
>;

/** 结构化错误（spec §9.5）：稳定 code + 阶段 + 可重试性，不降级为字符串。 */
export const runtimeEnvironmentErrorCodeSchema = z.enum([
  "configuration-conflict",
  "unsupported-declaration",
  "capability-unavailable",
  "tool-unavailable",
  "download-failed",
  "integrity-failed",
  "dependency-install-failed",
  "stale-reference",
  "scope-mismatch",
  "resource-busy",
  "process-unknown",
  "release-blocked",
  "cancelled",
]);
export type RuntimeEnvironmentErrorCode = z.infer<typeof runtimeEnvironmentErrorCodeSchema>;

export const runtimeEnvironmentErrorSchema = z
  .object({
    code: runtimeEnvironmentErrorCodeSchema,
    stage: z.enum([
      "resolvingTools",
      "installingTools",
      "preparingDependencies",
      "cancelling",
      "releasing",
    ]),
    message: z.string().max(8192),
    retryable: z.boolean(),
    /** 非敏感定位信息：声明来源、字段、路径摘要等；秘密一律不进入。 */
    detail: z.record(z.string(), z.string()).optional(),
  })
  .strict();
export type RuntimeEnvironmentError = z.infer<typeof runtimeEnvironmentErrorSchema>;

/** 冻结清单（spec §6.2）：revision 内不可变；凭据只存引用不展开。 */
export const frozenToolSchema = z
  .object({
    key: text,
    version: text,
    source: z.enum(["project-declaration", "app-default", "user-override"]),
    /** Host 上确切可执行文件路径；无则该工具未落盘。 */
    toolPath: text.optional(),
    installStrategy: z.enum(["managed-tool-store", "system-path"]).optional(),
  })
  .strict();
export type FrozenTool = z.infer<typeof frozenToolSchema>;

export const frozenManifestSchema = z
  .object({
    schemaVersion: z.literal(1),
    backendVersion: text,
    os: z.enum(["windows", "macos", "linux"]),
    arch: z.enum(["x64", "arm64"]),
    tools: z.array(frozenToolSchema),
    declarationDigest: text,
    installStrategy: z.enum(["frozen", "non-frozen"]),
    createdAt: text,
  })
  .strict();
export type FrozenManifest = z.infer<typeof frozenManifestSchema>;

/** 环境持久记录的协议投影（token/lease 与本机路径细节不进协议，spec §9.2）。 */
export const runtimeEnvironmentRecordSchema = z
  .object({
    environmentId,
    scope: runtimeEnvironmentScopeSchema,
    bindingId: text.optional(),
    purpose: runtimeEnvironmentPurposeSchema,
    status: runtimeEnvironmentStatusSchema,
    currentRevision: revision,
    error: runtimeEnvironmentErrorSchema.optional(),
    createdAt: text,
    updatedAt: text,
  })
  .strict();
export type RuntimeEnvironmentRecord = z.infer<typeof runtimeEnvironmentRecordSchema>;

/** 准备操作收据：同 requestId 复用、断点与对账的查询面（spec §8.2/§10.3）。 */
export const runtimePreparationOperationSchema = z
  .object({
    operationId: z.string().regex(/^[a-f0-9]{32}$/),
    requestId: text,
    environmentId,
    status: runtimePreparationOperationStatusSchema,
    stage: runtimeEnvironmentStatusSchema.exclude(["releasing", "releaseBlocked", "released"]),
    cancelRequested: z.boolean(),
    error: runtimeEnvironmentErrorSchema.optional(),
    createdAt: text,
    updatedAt: text,
  })
  .strict();
export type RuntimePreparationOperation = z.infer<typeof runtimePreparationOperationSchema>;

/** UI 只读投影：不含 resourceLeaseToken 与本机工具存储路径（spec §9.2）。 */
export const runtimeEnvironmentProjectionSchema = z
  .object({
    environmentId,
    purpose: runtimeEnvironmentPurposeSchema,
    status: runtimeEnvironmentStatusSchema,
    currentRevision: revision,
    tools: z.array(frozenToolSchema),
    manifestDigest: text.optional(),
    installStrategy: frozenManifestSchema.shape.installStrategy.optional(),
    /** 托管服务地址事实（spec §12.3，M3 P3-06）：只读投影，手机预览经平台通路消费。 */
    services: z
      .array(
        z
          .object({
            serviceId: text,
            state: z.enum(["starting", "running", "stopping", "stopped", "failed"]),
            urls: z.array(text),
          })
          .strict(),
      )
      .optional(),
    error: runtimeEnvironmentErrorSchema.optional(),
    updatedAt: text,
  })
  .strict();
export type RuntimeEnvironmentProjection = z.infer<typeof runtimeEnvironmentProjectionSchema>;

/** 能力上报（spec §9.1 capabilities）：缺能力必须给原因，不伪造托管成功。 */
export const runtimeEnvironmentCapabilitiesSchema = z
  .object({
    managedEnvironments: z.boolean(),
    platform: z.enum(["windows", "macos", "linux"]).optional(),
    backend: z
      .object({ kind: z.literal("mise"), version: text, available: z.boolean() })
      .strict()
      .optional(),
    missingReason: z.string().max(2048).optional(),
  })
  .strict()
  .refine(
    (caps) => caps.managedEnvironments || Boolean(caps.missingReason),
    "managedEnvironments=false requires missingReason",
  );
export type RuntimeEnvironmentCapabilities = z.infer<typeof runtimeEnvironmentCapabilitiesSchema>;

// ---- 协议方法族参数/结果（严格 schema，旧 Host 拒收未知字段；全部字段 optional 兼容）----

const scope = { workspacePath: text, workspaceIdentity: text.optional() };

export const runtimeEnvironmentPrepareParamsSchema = z
  .object({
    ...scope,
    requestId: text,
    bindingId: text.optional(),
    purpose: runtimeEnvironmentPurposeSchema,
    /** 期望的冻结计划代际；stale 检测依据（spec §8.1 revision）。 */
    expectedRevision: revision.optional(),
    cancel: z.boolean().optional(),
  })
  .strict();
export type RuntimeEnvironmentPrepareParams = z.infer<typeof runtimeEnvironmentPrepareParamsSchema>;

export const runtimeEnvironmentPrepareResultSchema = z
  .object({ operation: runtimePreparationOperationSchema })
  .strict();
export type RuntimeEnvironmentPrepareResult = z.infer<typeof runtimeEnvironmentPrepareResultSchema>;

export const runtimeEnvironmentGetParamsSchema = z
  .object({
    ...scope,
    environmentId: environmentId.optional(),
    requestId: text.optional(),
  })
  .strict()
  .refine(
    (value) => Boolean(value.environmentId || value.requestId),
    "Environment id or preparation request id is required",
  );
export type RuntimeEnvironmentGetParams = z.infer<typeof runtimeEnvironmentGetParamsSchema>;

export const runtimeEnvironmentGetResultSchema = z
  .object({ environment: runtimeEnvironmentProjectionSchema.nullable() })
  .strict();
export type RuntimeEnvironmentGetResult = z.infer<typeof runtimeEnvironmentGetResultSchema>;

export const runtimeEnvironmentListParamsSchema = z.object(scope).strict();
export type RuntimeEnvironmentListParams = z.infer<typeof runtimeEnvironmentListParamsSchema>;

export const runtimeEnvironmentListResultSchema = z
  .object({ environments: z.array(runtimeEnvironmentProjectionSchema) })
  .strict();
export type RuntimeEnvironmentListResult = z.infer<typeof runtimeEnvironmentListResultSchema>;

export const runtimeEnvironmentReleaseParamsSchema = z
  .object({
    ...scope,
    requestId: text,
    environmentId,
    expectedRevision: revision.optional(),
  })
  .strict();
export type RuntimeEnvironmentReleaseParams = z.infer<typeof runtimeEnvironmentReleaseParamsSchema>;

export const runtimeEnvironmentReleaseResultSchema = z
  .object({
    status: z.enum(["released", "releaseBlocked"]),
    reason: z.string().max(2048).optional(),
  })
  .strict();
export type RuntimeEnvironmentReleaseResult = z.infer<typeof runtimeEnvironmentReleaseResultSchema>;

export const runtimeEnvironmentCapabilitiesResultSchema = z
  .object({ capabilities: runtimeEnvironmentCapabilitiesSchema })
  .strict();
export type RuntimeEnvironmentCapabilitiesResult = z.infer<
  typeof runtimeEnvironmentCapabilitiesResultSchema
>;

// ---- 执行前上下文解析（P2-03：CLI 每次真实 spawn 前按 cwd 解析所属环境）----

/**
 * 按 checkout cwd 解析（环境记录 scope 即 checkout 路径，取最长前缀匹配）。
 * 无命中返回 context: null —— 非托管 spawn 保持现有继承语义，不是错误。
 */
export const runtimeEnvironmentResolveContextParamsSchema = z
  .object({
    cwd: text,
    /** 消费者标识（session/terminal/mcp/service），用于引用结算与诊断。 */
    consumer: text,
  })
  .strict();
export type RuntimeEnvironmentResolveContextParams = z.infer<
  typeof runtimeEnvironmentResolveContextParamsSchema
>;

/** 冻结上下文 wire 投影：与 §9.2 相同字段，但 resourceLeaseToken 不出 Host（仅内部）。 */
export const resolvedProjectContextWireSchema = z
  .object({
    environmentId,
    revision,
    manifestDigest: text,
    cwd: text,
    toolPaths: z.record(z.string(), text),
    envOverlay: z
      .object({
        base: z.enum(["inherit", "empty"]).optional(),
        set: z.record(z.string(), z.string()).optional(),
        unset: z.array(text).optional(),
      })
      .strict(),
  })
  .strict();
export type ResolvedProjectContextWire = z.infer<typeof resolvedProjectContextWireSchema>;

export const runtimeEnvironmentResolveContextResultSchema = z
  .object({ context: resolvedProjectContextWireSchema.nullable() })
  .strict();
export type RuntimeEnvironmentResolveContextResult = z.infer<
  typeof runtimeEnvironmentResolveContextResultSchema
>;

/**
 * 依赖安装收据（spec §11.1，P2-06）：覆盖声明指纹/锁摘要/Node ABI（版本）/平台；
 * 不匹配即重装，不能因目录存在跳过安装。
 */
export const dependencyReceiptSchema = z
  .object({
    environmentId,
    manager: z.enum(["pnpm", "npm", "yarn", "bun"]),
    command: text,
    strategy: z.enum(["frozen", "non-frozen"]),
    lockDigest: text,
    declarationDigest: text,
    nodeVersion: text,
    platform: z.enum(["windows", "macos", "linux"]),
    arch: z.enum(["x64", "arm64"]),
    exitCode: z.number().int(),
    finishedAt: text,
  })
  .strict();
export type DependencyReceipt = z.infer<typeof dependencyReceiptSchema>;

// ---- 托管服务（spec §12，M3 P3-01/P3-02）----

/**
 * 服务收据（spec §8.2/§12.1）：同环境同服务并发 start 返回同一收据；
 * generation 随旧进程停止递增；PID 仅诊断，不独立授权停止。
 * running 必须有真实监听证据（URL + 探测时间）；stopped 必须有进程 owner 退出证明。
 */
export const managedServiceReceiptSchema = z
  .object({
    environmentId,
    revision,
    serviceId: text,
    generation: z.number().int().positive(),
    state: z.enum(["starting", "running", "stopping", "stopped", "failed"]),
    /** 真实监听地址；running 时必须存在（真实 bind 证据，非探测候选）。 */
    urls: z.array(text),
    pid: z.number().int().positive().optional(),
    startedAt: text,
    /** running 的健康证据：探测到实际监听的时间。 */
    healthCheckedAt: text.optional(),
    /** stopped 的停止证据：进程 owner 确认退出的时间。 */
    stoppedAt: text.optional(),
    exitCode: z.number().int().optional(),
    error: z.string().max(8192).optional(),
  })
  .strict();
export type ManagedServiceReceipt = z.infer<typeof managedServiceReceiptSchema>;
