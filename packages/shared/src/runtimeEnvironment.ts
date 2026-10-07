/* oxlint-disable max-lines -- 运行环境的 M1/M4/M5 公开 schema 必须由同一 shared contract 导出，避免协议、投影和收据分叉。 */
import { z } from "zod";
import { runtimeEnvironmentReferenceSchema } from "./runtimeConsumer.js";

/**
 * 运行环境协议类型（spec: specs/worktree-runtime-environments.md §8/§9）。
 * 只暴露协议所需字段；token/lease 仅内部，不进协议与 UI 投影。
 */

const text = z.string().trim().min(1);
const environmentId = z.string().regex(/^[a-f0-9]{32}$/, "environmentId must be a 32-char hex id");
const revision = z.number().int().nonnegative();
const scope = { workspacePath: text, workspaceIdentity: text.optional() };

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

/** 对外诊断中的阻塞者只允许安全显示标签；ownerId、lease、token 永不进入此结构。 */
export const runtimeEnvironmentBlockerSchema = z
  .object({
    kind: z.enum(["consumer", "service", "writer", "path"]),
    label: z.string().trim().min(1).max(256),
    path: z.string().trim().min(1).max(4096).optional(),
  })
  .strict();
export type RuntimeEnvironmentBlocker = z.infer<typeof runtimeEnvironmentBlockerSchema>;

export const runtimeEnvironmentDiagnosticSchema = z
  .object({
    purpose: runtimeEnvironmentPurposeSchema.optional(),
    environmentId: environmentId.optional(),
    revision: revision.optional(),
    manifestDigest: z.string().trim().min(1).max(256).optional(),
    toolSource: z
      .enum(["project-declaration", "app-default", "user-override", "partial-host"])
      .optional(),
    paths: z.array(z.string().trim().min(1).max(4096)).max(16).optional(),
    command: z.string().trim().min(1).max(4096).optional(),
    exitCode: z.number().int().nullable().optional(),
    stderrTail: z.string().max(8192).optional(),
    logRef: z.string().trim().min(1).max(256).optional(),
    listeners: z
      .array(z.object({ serviceId: text, urls: z.array(text).max(16) }).strict())
      .max(32)
      .optional(),
    blockers: z.array(runtimeEnvironmentBlockerSchema).max(32).optional(),
    sideEffects: z
      .array(
        z.enum([
          "environment-created",
          "manifest-written",
          "tool-installed",
          "dependencies-installed",
          "process-started",
          "files-written",
          "files-removed",
          "session-cleanup-started",
          "snapshot-written",
        ]),
      )
      .max(16)
      .optional(),
  })
  .strict();
export type RuntimeEnvironmentDiagnostic = z.infer<typeof runtimeEnvironmentDiagnosticSchema>;

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
  "port-bind-failed",
  "process-unknown",
  "release-blocked",
  "environment-rebuild-failed",
  "validation-stale",
  "gc-incomplete",
  "restore-data-required",
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
      "updating",
      "startingService",
      "stoppingService",
      "validating",
      "restoring",
      "scanning",
      "collectingGarbage",
      "cancelling",
      "releasing",
    ]),
    message: z.string().max(8192),
    retryable: z.boolean(),
    /** 非敏感定位信息：旧记录兼容字段；新的结构化诊断使用 diagnostic 白名单。 */
    detail: z.record(z.string(), z.string()).optional(),
    diagnostic: runtimeEnvironmentDiagnosticSchema.optional(),
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
    /** 对声明和锁文件内容的统一摘要；旧 manifest 缺省表示尚不能证明锁内容新鲜。 */
    manifestDigest: text.optional(),
    installStrategy: z.enum(["frozen", "non-frozen"]),
    resources: z
      .object({ temp: text, cache: text, data: text, logs: text, packageStore: text })
      .strict()
      .optional(),
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
    /** 环境事实版本；与 currentRevision（冻结 manifest 代际）不同。 */
    stateRevision: revision.optional(),
    currentRevision: revision,
    manifestDigest: text.optional(),
    activeOperationId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    lastOperationId: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    fenceIntent: z.enum(["upgrade", "archive", "discard", "candidate-cancel"]).optional(),
    resourceSummary: z.lazy(() => runtimeEnvironmentResourceSummarySchema).optional(),
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
    requestFingerprint: text.optional(),
    targetRevision: z.number().int().positive().optional(),
    plan: frozenManifestSchema.optional(),
    commitManifest: frozenManifestSchema.optional(),
    error: runtimeEnvironmentErrorSchema.optional(),
    createdAt: text,
    updatedAt: text,
  })
  .strict();
export type RuntimePreparationOperation = z.infer<typeof runtimePreparationOperationSchema>;

export * from "./runtimeConsumer.js";

/** 有界资源扫描的事实摘要；partial/unavailable 绝不等价于空闲或可删除。 */
export const runtimeEnvironmentResourceSummarySchema = z
  .object({
    status: z.enum(["complete", "partial", "unavailable"]),
    scannedAt: text.optional(),
    scanBudget: z
      .object({
        maxEntries: z.number().int().positive(),
        maxDurationMs: z.number().int().positive(),
      })
      .strict()
      .optional(),
    bytes: z.number().int().nonnegative().optional(),
    fileCount: z.number().int().nonnegative().optional(),
    protectedReferences: z.number().int().nonnegative().optional(),
    reason: z.string().max(2048).optional(),
  })
  .strict();
export type RuntimeEnvironmentResourceSummary = z.infer<
  typeof runtimeEnvironmentResourceSummarySchema
>;

export const runtimeEnvironmentOperationKindSchema = z.enum([
  "prepare",
  "upgrade",
  "release",
  "restore",
  "scan",
  "gc",
  "service",
]);
export type RuntimeEnvironmentOperationKind = z.infer<typeof runtimeEnvironmentOperationKindSchema>;

/** 长操作的公共对账载体；不携带内部 lease、PID 授权或凭据。 */
export const runtimeEnvironmentOperationSchema = z
  .object({
    operationId: text,
    kind: runtimeEnvironmentOperationKindSchema,
    status: z.enum(["running", "succeeded", "failed", "blocked", "unknown"]),
    stateRevision: revision.optional(),
    updatedAt: text,
    error: runtimeEnvironmentErrorSchema.optional(),
  })
  .strict();
export type RuntimeEnvironmentOperation = z.infer<typeof runtimeEnvironmentOperationSchema>;

/** 环境持久记录的协议投影（token/lease 与本机路径细节不进协议，spec §9.2）。 */
export const runtimeEnvironmentProjectionSchema = z
  .object({
    environmentId,
    purpose: runtimeEnvironmentPurposeSchema,
    status: runtimeEnvironmentStatusSchema,
    currentRevision: revision,
    /** 环境 owner 的事实事件版本；服务状态/资源变化必须单调推进。 */
    stateRevision: revision.optional(),
    tools: z.array(frozenToolSchema),
    manifestDigest: text.optional(),
    installStrategy: frozenManifestSchema.shape.installStrategy.optional(),
    toolSource: z
      .enum(["project-declaration", "app-default", "user-override", "partial-host"])
      .optional(),
    /** declaration/lock/manifest 对账摘要；秘密和展开配置不出投影。 */
    declarationDigest: text.optional(),
    resourceSummary: runtimeEnvironmentResourceSummarySchema.optional(),
    availableServices: z
      .array(
        z.object({ serviceId: text, portIsolation: z.enum(["managed", "unmanaged"]) }).strict(),
      )
      .max(32)
      .optional(),
    /** 托管服务地址事实（spec §12.3，M3 P3-06）：只读投影，手机预览经平台通路消费。 */
    services: z
      .array(
        z
          .object({
            serviceId: text,
            state: z.enum(["starting", "running", "stopping", "stopped", "failed", "unknown"]),
            generation: z.number().int().positive().optional(),
            stateRevision: revision.optional(),
            operationId: text.optional(),
            urls: z.array(text),
          })
          .strict(),
      )
      .optional(),
    error: runtimeEnvironmentErrorSchema.optional(),
    updatedAt: text,
    operation: runtimeEnvironmentOperationSchema.optional(),
  })
  .strict();
export type RuntimeEnvironmentProjection = z.infer<typeof runtimeEnvironmentProjectionSchema>;

export const runtimeEnvironmentResourceScanResultSchema = z
  .object({
    environmentId,
    stateRevision: revision,
    summary: runtimeEnvironmentResourceSummarySchema,
  })
  .strict();
export type RuntimeEnvironmentResourceScanResult = z.infer<
  typeof runtimeEnvironmentResourceScanResultSchema
>;

export const runtimeEnvironmentGarbageCollectionResultSchema = z
  .object({
    operationId: text,
    status: z.enum(["succeeded", "partial", "blocked", "failed"]),
    stateRevision: revision.optional(),
    deletedEntries: z.number().int().nonnegative(),
    protectedEntries: z.number().int().nonnegative(),
    summary: runtimeEnvironmentResourceSummarySchema,
    error: runtimeEnvironmentErrorSchema.optional(),
  })
  .strict();
export type RuntimeEnvironmentGarbageCollectionResult = z.infer<
  typeof runtimeEnvironmentGarbageCollectionResultSchema
>;

/** 环境 owner 产生的最新态/事件载体；两种 delivery 只改变传输，不改变事实。 */
export const runtimeEnvironmentSnapshotSchema = z
  .object({
    protocolVersion: z.literal(1),
    scope: runtimeEnvironmentScopeSchema,
    stateRevision: revision,
    environment: runtimeEnvironmentProjectionSchema.optional(),
  })
  .strict();
export type RuntimeEnvironmentSnapshot = z.infer<typeof runtimeEnvironmentSnapshotSchema>;
export const runtimeEnvironmentSnapshotParamsSchema = z
  .object({ ...scope, environmentId })
  .strict();
export type RuntimeEnvironmentSnapshotParams = z.infer<
  typeof runtimeEnvironmentSnapshotParamsSchema
>;
export const runtimeEnvironmentReconcileParamsSchema = z
  .object({ ...scope, requestId: text })
  .strict();
export type RuntimeEnvironmentReconcileParams = z.infer<
  typeof runtimeEnvironmentReconcileParamsSchema
>;
export const runtimeEnvironmentReconcileResultSchema = z
  .object({
    operation: runtimePreparationOperationSchema.nullable(),
    environment: runtimeEnvironmentProjectionSchema.nullable(),
  })
  .strict();
export type RuntimeEnvironmentReconcileResult = z.infer<
  typeof runtimeEnvironmentReconcileResultSchema
>;

/** 事件按 stateRevision 对账；旧事件或乱序事件不得覆盖更新事实。 */
export const runtimeEnvironmentEventSchema = z
  .object({
    environmentId,
    stateRevision: revision,
    kind: z.enum([
      "projection.updated",
      "operation.updated",
      "service.updated",
      "resource.updated",
    ]),
    operationId: text.optional(),
    projection: runtimeEnvironmentProjectionSchema.optional(),
  })
  .strict();
export type RuntimeEnvironmentEvent = z.infer<typeof runtimeEnvironmentEventSchema>;

export const runtimeEnvironmentActionSchema = z.enum([
  "prepare",
  "resolveContext",
  "retainSession",
  "releaseConsumer",
  "startService",
  "stopService",
  "reconcile",
  "resourceSummary",
  "garbageCollect",
]);
export type RuntimeEnvironmentAction = z.infer<typeof runtimeEnvironmentActionSchema>;

/** 协议/Host 能力投影。缺字段代表旧 Host，不代表支持。 */
export const runtimeEnvironmentProtocolCapabilitySchema = z
  .object({
    protocolVersion: z.number().int().positive().optional(),
    managedEnvironments: z.boolean(),
    actions: z.array(runtimeEnvironmentActionSchema).max(16).optional(),
    platform: z.enum(["windows", "macos", "linux"]).optional(),
    missingReason: z.string().trim().min(1).max(2048).optional(),
  })
  .strict()
  .refine(
    (value) => value.managedEnvironments || Boolean(value.missingReason),
    "managedEnvironments=false requires missingReason",
  )
  .refine(
    (value) =>
      !value.managedEnvironments ||
      value.protocolVersion === undefined ||
      value.actions !== undefined,
    "managedEnvironments with protocolVersion requires explicit actions",
  );
export type RuntimeEnvironmentProtocolCapability = z.infer<
  typeof runtimeEnvironmentProtocolCapabilitySchema
>;

/** 能力上报（spec §9.1 capabilities）：缺能力必须给原因，不伪造托管成功。 */
export const runtimeEnvironmentCapabilitiesSchema = z
  .object({
    managedEnvironments: z.boolean(),
    protocolVersion: z.number().int().positive().optional(),
    actions: z.array(runtimeEnvironmentActionSchema).max(16).optional(),
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

export const runtimeEnvironmentPrepareParamsSchema = z
  .object({
    ...scope,
    requestId: text,
    bindingId: text.optional(),
    environmentId: environmentId.optional(),
    purpose: runtimeEnvironmentPurposeSchema,
    /** 新请求的目的；upgrade/restore 必须创建新的可对账操作，不复用旧 PID 或旧 manifest。 */
    operation: z.enum(["prepare", "upgrade", "restore"]).optional(),
    /** 期望的冻结计划代际；stale 检测依据（spec §8.1 revision）。 */
    expectedRevision: revision.optional(),
    expectedManifestDigest: text.optional(),
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
    expectedManifestDigest: text.optional(),
    /** Worktree 删除/恢复编排的生命周期意图；普通 release 缺省。 */
    reason: z.enum(["worktree-delete", "worktree-archive", "consumer-release"]).optional(),
  })
  .strict();
export type RuntimeEnvironmentReleaseParams = z.infer<typeof runtimeEnvironmentReleaseParamsSchema>;

export const runtimeEnvironmentReleaseResultSchema = z
  .object({
    status: z.enum(["released", "releaseBlocked"]),
    operationId: text.optional(),
    stateRevision: revision.optional(),
    reason: z.string().max(2048).optional(),
    diagnostic: runtimeEnvironmentDiagnosticSchema.optional(),
  })
  .strict();
export type RuntimeEnvironmentReleaseResult = z.infer<typeof runtimeEnvironmentReleaseResultSchema>;

export const runtimeEnvironmentCapabilitiesResultSchema = z
  .object({ capabilities: runtimeEnvironmentCapabilitiesSchema })
  .strict();
export type RuntimeEnvironmentCapabilitiesResult = z.infer<
  typeof runtimeEnvironmentCapabilitiesResultSchema
>;

export const runtimeEnvironmentGarbageCollectionParamsSchema = z
  .object({
    ...scope,
    requestId: text,
    budget: z
      .object({
        maxEntries: z.number().int().positive(),
        maxDurationMs: z.number().int().positive(),
      })
      .strict(),
    dryRun: z.boolean().optional(),
  })
  .strict();
export type RuntimeEnvironmentGarbageCollectionParams = z.infer<
  typeof runtimeEnvironmentGarbageCollectionParamsSchema
>;

export const runtimeEnvironmentResourceScanParamsSchema = z
  .object({
    ...scope,
    requestId: text,
    environmentId: environmentId.optional(),
    budget: z
      .object({
        maxEntries: z.number().int().positive(),
        maxDurationMs: z.number().int().positive(),
      })
      .strict(),
  })
  .strict();
export type RuntimeEnvironmentResourceScanParams = z.infer<
  typeof runtimeEnvironmentResourceScanParamsSchema
>;

export const runtimeEnvironmentServiceActionParamsSchema = z
  .object({
    ...scope,
    requestId: text,
    environmentId,
    serviceId: text,
    expectedRevision: revision,
    expectedGeneration: z.number().int().positive().optional(),
  })
  .strict();
export type RuntimeEnvironmentServiceActionParams = z.infer<
  typeof runtimeEnvironmentServiceActionParamsSchema
>;

export const runtimeEnvironmentServiceActionResultSchema = z
  .object({
    status: z.enum([
      "started",
      "reused",
      "stopped",
      "notRunning",
      "needsRestart",
      "blocked",
      "failed",
    ]),
    receipt: z.lazy(() => managedServiceReceiptSchema).optional(),
    operation: runtimeEnvironmentOperationSchema.optional(),
    reason: z.string().max(2048).optional(),
  })
  .strict();
export type RuntimeEnvironmentServiceActionResult = z.infer<
  typeof runtimeEnvironmentServiceActionResultSchema
>;

/** 公开服务动作合同的最小收据；PID/lease 不是停止授权。 */
export const runtimeEnvironmentServiceActionSchema = z.enum(["start", "stop"]);
export type RuntimeEnvironmentServiceAction = z.infer<typeof runtimeEnvironmentServiceActionSchema>;

// ---- 执行前上下文解析（P2-03：CLI 每次真实 spawn 前按 cwd 解析所属环境）----

/** 显式绑定托管环境的反向请求；旧会话不发送此请求。 */
export const runtimeEnvironmentResolveContextParamsSchema = z
  .object({
    cwd: text,
    consumer: text,
    sessionId: text,
    executionBindingId: text,
    workspaceIdentity: text.optional(),
    remoteSessionId: text.optional(),
    environmentRef: runtimeEnvironmentReferenceSchema,
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
    workspaceIdentity: text.optional(),
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
  .object({ context: resolvedProjectContextWireSchema })
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
    managerVersion: text.optional(),
    manifestDigest: text.optional(),
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
    state: z.enum(["starting", "running", "stopping", "stopped", "failed", "unknown"]),
    /** 真实监听地址；running 时必须存在（真实 bind 证据，非探测候选）。 */
    urls: z.array(text),
    pid: z.number().int().positive().optional(),
    startedAt: text,
    /** running 的健康证据：探测到实际监听的时间。 */
    healthCheckedAt: text.optional(),
    /** stopped 的停止证据：进程 owner 确认退出的时间。 */
    stoppedAt: text.optional(),
    exitCode: z.number().int().optional(),
    /** running/stopped 对账使用的服务事实代际；PID 仍仅诊断。 */
    stateRevision: revision.optional(),
    operationId: text.optional(),
    error: z.string().max(8192).optional(),
  })
  .strict();
export type ManagedServiceReceipt = z.infer<typeof managedServiceReceiptSchema>;
