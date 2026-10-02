// 会话控制、派生 availability/routing、配置模式与 runtime epoch 边界。
// host 是 ProductProjection 原实例的窄借用视图；函数不持有副本或另建 owner。
import type { ProductProjectionState } from "./product-projection-state.js";
import {
  type ConversationSnapshot,
  type ConversationDelta,
  type HookExecutionProjection,
  executionFailoverStateSchema,
  executionFailoverEligibleBackgroundWorkIdsSchema,
  type SessionControl,
  type GoalState,
  type StatePatch,
} from "@lcode/shared/lcode-protocol-v4";
import type { SessionEvent, ExecutionFailoverChangedPayload } from "@lcode/contracts";
import { ms } from "./product-projection-rows.js";
import { computeAvailability, computeInputRouting } from "./projection-state.js";

type SeedSharedContextImportHost = Pick<ProductProjectionState, "snapshot">;

type SessionResumedHost = Pick<
  ProductProjectionState,
  | "snapshot"
  | "pendingSessionHookInvocations"
  | "executionFailoverRevision"
  | "executionFailoverEpochStartSequence"
>;

type SessionCreatedHost = Pick<ProductProjectionState, "contextWindowState">;

type SessionModeChangedHost = Pick<ProductProjectionState, "snapshot" | "configModeTouchedByEvent">;

type ExecutionFailoverChangedHost = Pick<
  ProductProjectionState,
  "executionFailoverRevision" | "executionFailoverEpochStartSequence"
>;

/**
 * 导入分享上下文的来源只读种子。
 *
 * shared_context 是 provider-only message，不应物化为用户气泡；来源标记通过
 * snapshot additive 字段下发，供 Desktop 在打开新会话后显示持久提示。该字段
 * 不属于 conversation rows，也不递增 revision/seq，避免伪造一轮对话。
 */
export function seedSharedContextImport(
  host: SeedSharedContextImportHost,
  source: ConversationSnapshot["sharedContextImport"] | null | undefined,
): void {
  const title = source?.title.trim();
  if (!title) return;
  if (
    host.snapshot.sharedContextImport?.title === title &&
    (source as { contextId?: string }).contextId ===
      (host.snapshot.sharedContextImport as { contextId?: string }).contextId &&
    (source as { status?: string }).status ===
      (host.snapshot.sharedContextImport as { status?: string }).status
  ) {
    return;
  }
  host.snapshot = {
    ...host.snapshot,
    sharedContextImport: {
      ...source,
      title,
    },
  };
}

/** A persisted started-only Hook cannot still be running after a real runtime resume. */
export function onSessionResumed(
  host: SessionResumedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const endedAt = ms(event);
  const deltas: ConversationDelta[] = [];
  // failover revision 只在单个 Runtime epoch 内单调；新 Runtime 会从 1 重新发号。
  // 先重置水位，后续新 epoch 的 revision=1 才不会被旧 epoch 墓碑误判为迟到事件。
  host.executionFailoverRevision = 0;
  host.executionFailoverEpochStartSequence = event.sequenceNumber;
  // Runtime epoch 切换前尚未归位的 session Hook 不得附着到新 epoch 的下一轮；
  // 新 Runtime 会重新产生自己的 resume SessionStart lifecycle。
  host.pendingSessionHookInvocations.clear();
  for (const row of host.snapshot.rows.window) {
    if (row.kind !== "hookInvocation" || row.state !== "running") continue;
    const executions = row.executions.map(
      (execution): HookExecutionProjection =>
        execution.state === "running"
          ? {
              ...execution,
              state: "failed",
              outcome: "cancelled",
              endedAt,
              durationMs: Math.max(0, endedAt - execution.startedAt),
            }
          : execution,
    );
    deltas.push({
      op: "row.upserted",
      row: {
        ...row,
        state: "failed",
        executions,
        endedAt,
        durationMs: Math.max(0, endedAt - row.startedAt),
      },
    });
  }
  const pendingInteractions = host.snapshot.pendingInteractions.filter(
    (interaction) => interaction.payload.kind !== "workspaceHookReview",
  );
  if (pendingInteractions.length !== host.snapshot.pendingInteractions.length) {
    // reviewFlowId/generation 只在单个 Runtime controller 内单调。
    // Runtime 重启后旧 Requested 会先被 replay，而新 flow 又从 generation=1 开始；
    // SessionResumed 是明确的新 Runtime epoch 边界，必须先淘汰旧 Runtime 无法再解析的审核。
    deltas.push({ op: "state.updated", patch: { pendingInteractions } });
  }
  // 软门禁:resume 后 activate 会重新上报 admission 状态。
  // epoch 清理时置 null,避免旧 Runtime 的提示条残留到新 Runtime 接管前。
  if (host.snapshot.workspaceHookAdmission !== null) {
    deltas.push({ op: "state.updated", patch: { workspaceHookAdmission: null } });
  }
  if (
    host.snapshot.executionFailover !== null ||
    host.snapshot.executionFailoverEligibleBackgroundWorkIds === undefined ||
    host.snapshot.executionFailoverEligibleBackgroundWorkIds.length > 0
  ) {
    // Runtime epoch 已变化，旧 policy 与 registration ID 必须在同一个 patch 原子失效。
    deltas.push({
      op: "state.updated",
      patch: {
        executionFailover: null,
        executionFailoverEligibleBackgroundWorkIds: [],
      },
    });
  }
  return deltas;
}

// ── 生命周期 ──

export function onSessionCreated(
  host: SessionCreatedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { contextWindow?: number };
  host.contextWindowState.maxTokens = payload.contextWindow ?? null;
  // draft 语义：会话实体已存在、无 row；phase 保持 draft，无可见 delta。
  return [];
}

// renameSession / 自动标题：SessionTitleUpdated(title, source) → 更新 meta。
// custom（用户重命名）优先级最高，已 custom 后不再被 generated 覆盖（与 core titleSource 一致）。
export function onSessionTitleUpdated(
  host: SeedSharedContextImportHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    title?: string;
    source?: string;
  };
  const title = payload.title ?? "";
  // core 的 titleSource 有 4 值（default/first_input/generated/custom）；投影 meta 归一为
  // default/generated/custom（first_input 归入 generated：都属"非用户显式"）。
  const source: "default" | "generated" | "custom" =
    payload.source === "custom" ? "custom" : payload.source === "default" ? "default" : "generated";
  const prev = host.snapshot.meta;
  if (prev.titleSource === "custom" && source === "generated") return [];
  if (prev.title === title && prev.titleSource === source) return [];
  return [
    {
      op: "state.updated",
      patch: { meta: { title, titleSource: source } },
    },
  ];
}

// setFollowupMode：config.followupMode 翻转。followupMode 是 running 时
// enqueue vs guide 的路由授权位（computeInputRouting）→ 改 config 后同步重算 A 区。
export function onFollowupModeChanged(
  host: SeedSharedContextImportHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as { mode?: "queue" | "guide" };
  const mode: "queue" | "guide" = payload.mode === "guide" ? "guide" : "queue";
  if (host.snapshot.config.followupMode === mode) return [];
  const nextConfig: ConversationSnapshot["config"] = {
    ...host.snapshot.config,
    followupMode: mode,
  };
  const context = deriveContext(host, {});
  return [
    {
      op: "state.updated",
      patch: {
        config: nextConfig,
        availability: computeAvailability(context),
        inputRouting: computeInputRouting(context, mode),
      },
    },
  ];
}

/**
 * switchCollaborationMode：SessionModeChanged → config.mode。
 * 事件来源覆盖命令面（source=command）与 plan 工具路径（enterPlanMode/exitPlanMode，
 * source=tool）——两条路径共用这条投影，UI 的模式选择器因此也能跟随工具驱动的模式切换。
 */
export function onSessionModeChanged(
  host: SessionModeChangedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as {
    mode?: string;
    planEnabled?: boolean;
    source?: string;
    toolCallId?: string;
    permissionGrant?: { interactionId: string; queueItemIds: string[] };
  };
  const mode = typeof payload.mode === "string" ? payload.mode : "";
  // 日志事件触碰过 mode 后，种子不再覆盖（同值 return 也算触碰——日志有权威值）。
  if (mode) host.configModeTouchedByEvent = true;
  if (!mode) return [];
  const planEnabled = payload.planEnabled ?? mode === "plan";
  const planTransition =
    payload.source === "tool" && payload.toolCallId
      ? { toolCallId: payload.toolCallId, planEnabled }
      : host.snapshot.config.planTransition;
  if (
    host.snapshot.config.mode === mode &&
    host.snapshot.config.planEnabled === planEnabled &&
    planTransition === host.snapshot.config.planTransition &&
    !payload.permissionGrant
  )
    return [];
  return [
    {
      op: "state.updated",
      patch: {
        ...(payload.permissionGrant
          ? queuePatch(host, {
              ...host.snapshot.queue,
              items: host.snapshot.queue.items.map((item) =>
                payload.permissionGrant!.queueItemIds.includes(item.queueItemId)
                  ? { ...item, mode: "yolo" as const }
                  : item,
              ),
            })
          : {}),
        config: {
          ...host.snapshot.config,
          mode,
          planEnabled,
          planTransition,
          ...(payload.permissionGrant
            ? { permissionGrant: { interactionId: payload.permissionGrant.interactionId } }
            : {}),
        },
      },
    },
  ];
}

// ── config / usage ──

export function onExecutionFailoverChanged(
  host: ExecutionFailoverChangedHost,
  event: SessionEvent,
): ConversationDelta[] {
  const payload = event.payload as ExecutionFailoverChangedPayload;
  if (
    event.sequenceNumber <= host.executionFailoverEpochStartSequence ||
    !Number.isInteger(payload.revision) ||
    payload.revision <= host.executionFailoverRevision
  ) {
    return [];
  }
  const parsed =
    payload.state === null
      ? { success: true as const, data: null }
      : executionFailoverStateSchema.safeParse(payload.state);
  const parsedEligibleBackgroundWorkIds =
    payload.eligibleBackgroundWorkIds === undefined
      ? { success: true as const, data: undefined }
      : executionFailoverEligibleBackgroundWorkIdsSchema.safeParse(
          payload.eligibleBackgroundWorkIds,
        );
  if (
    !parsed.success ||
    !parsedEligibleBackgroundWorkIds.success ||
    (parsed.data !== null &&
      (parsed.data.revision !== payload.revision ||
        !payload.sourceCommandId ||
        parsed.data.sourceCommandId !== payload.sourceCommandId))
  ) {
    return [];
  }
  host.executionFailoverRevision = payload.revision;
  return [
    {
      op: "state.updated",
      patch: {
        executionFailover: parsed.data,
        ...(parsedEligibleBackgroundWorkIds.data === undefined
          ? {}
          : {
              executionFailoverEligibleBackgroundWorkIds: parsedEligibleBackgroundWorkIds.data,
            }),
      },
    },
  ];
}

// ── 内部工具 ──

// goal 传 undefined = 不动 goal；传 null/对象 = 随本 patch 一并替换（availability 同源派生）。
// queue 传 undefined = 不动 queue；held 派生（heldQueueInputRequiresChoice）依赖
// queue.items.length + autoDrain，所以任何 control/goal/queue 变化都从同一处重算 A 区。
export function controlPatch(
  host: SeedSharedContextImportHost,
  control: Partial<SessionControl>,
  goal?: GoalState | null,
  queue?: ConversationSnapshot["queue"],
): StatePatch {
  const next: SessionControl = { ...host.snapshot.control, ...control };
  const nextGoal = goal === undefined ? host.snapshot.goal : goal;
  const nextQueue = queue ?? host.snapshot.queue;
  const context = {
    phase: next.phase,
    goalStatus: nextGoal?.status ?? null,
    // compacting 不是独立 phase（封闭枚举），从 activeWorks 派生。
    compacting: next.activeWorks.some((work) => work.kind === "compact"),
    goalVerifying: next.activeWorks.some((work) => work.kind === "goalVerifier"),
    queueLength: nextQueue.items.length,
    autoDrain: nextQueue.autoDrain,
  };
  return {
    control: next,
    ...(goal === undefined ? {} : { goal }),
    ...(queue === undefined ? {} : { queue }),
    availability: computeAvailability(context),
    inputRouting: computeInputRouting(context, host.snapshot.config.followupMode),
  };
}

// goal 单独变化时的 patch（availability 与 goal 同源，phase/activeWorks 不变）。
export function goalPatch(host: SeedSharedContextImportHost, goal: GoalState | null): StatePatch {
  return {
    goal,
    availability: computeAvailability(deriveContext(host, { goal })),
  };
}

// queue 单独变化时的 patch：queue 长度/autoDrain 影响 held 派生 → 同步重算 A 区。
export function queuePatch(
  host: SeedSharedContextImportHost,
  queue: ConversationSnapshot["queue"],
): StatePatch {
  const context = deriveContext(host, { queue });
  return {
    queue,
    availability: computeAvailability(context),
    inputRouting: computeInputRouting(context, host.snapshot.config.followupMode),
  };
}

function deriveContext(
  host: SeedSharedContextImportHost,
  overrides: {
    goal?: GoalState | null;
    queue?: ConversationSnapshot["queue"];
  },
) {
  const goal = overrides.goal === undefined ? host.snapshot.goal : overrides.goal;
  const queue = overrides.queue ?? host.snapshot.queue;
  return {
    phase: host.snapshot.control.phase,
    goalStatus: goal?.status ?? null,
    compacting: host.snapshot.control.activeWorks.some((work) => work.kind === "compact"),
    goalVerifying: host.snapshot.control.activeWorks.some((work) => work.kind === "goalVerifier"),
    queueLength: queue.items.length,
    autoDrain: queue.autoDrain,
  };
}

export function isRunning(host: SeedSharedContextImportHost): boolean {
  const phase = host.snapshot.control.phase;
  return phase === "running" || phase === "prewarming";
}
