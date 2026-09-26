/* eslint-disable max-lines -- execution failover 的串行 policy、lineage 注册与单事件写入必须共享一个状态所有者。 */
import type { ModelRetryYieldDecision, ModelSelection, TraceContext } from "@zcode/contracts";
import {
  MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS,
  MAX_EXECUTION_FAILOVER_TARGETS,
  type ExecutionFailoverReasonCode,
  type ExecutionFailoverState,
  type ExecutionFailoverTargetState,
  type ExecutionFailoverTransition,
} from "@zcode/shared/zcode-protocol-v4";
import { SessionEventType } from "../deps.js";
import type { AgentRuntimeInternal } from "../internal.js";
import { cloneModelSelection } from "../model-selection.js";

export interface ExecutionFailoverScope {
  backgroundWorkId?: string;
  foregroundExecutionId?: string;
}

export type ExecutionFailoverScopeLifetime = "runtime" | "turn";

export interface ExecutionFailoverRegistration {
  currentSelection?: ModelSelection;
  lifetime: ExecutionFailoverScopeLifetime;
  scope: ExecutionFailoverScope;
}

export interface ExecutionFailoverLineageLease {
  foregroundExecutionId: string;
  leaseId: string;
}

export interface ExecutionFailoverDormantIntent {
  acceptedRevision: number;
  modelSelection: ModelSelection;
  sourceCommandId: string;
}

export interface ExecutionFailoverPolicyTarget {
  currentSelection?: ModelSelection;
  id: string;
  kind: "foregroundExecution" | "backgroundWork";
  modelSelection: ModelSelection;
  revision: number;
  sourceCommandId: string;
  status: ExecutionFailoverTargetState["status"];
}

export interface SetExecutionFailoverTargetInput {
  modelSelection: ModelSelection;
  observedTargets: {
    backgroundWorkIds: readonly string[];
    foregroundExecutionId?: string;
  };
  sourceCommandId: string;
  traceContext: TraceContext;
}

export interface ExecutionFailoverPolicyPort {
  acquireLineageLease(leaseId: string): Promise<ExecutionFailoverLineageLease | undefined>;
  activate(input: {
    attempt: number;
    beforeActivate?: () => Promise<void>;
    commit: () => void;
    from: ModelSelection;
    prepare: () => Promise<void>;
    rollbackPrepared?: () => Promise<void>;
    reasonCode: ExecutionFailoverReasonCode;
    scope: ExecutionFailoverScope;
    target: ExecutionFailoverPolicyTarget;
    traceContext: TraceContext;
  }): Promise<boolean>;
  block(input: {
    currentSelection: ModelSelection;
    reasonCode: string;
    scope: ExecutionFailoverScope;
    target: ExecutionFailoverPolicyTarget;
    traceContext: TraceContext;
  }): Promise<void>;
  /**
   * 在 mutation 队列内读取并评估最新目标，给 retry-yield 一个可引用的线性化点。
   * evaluator 必须保持同步、只读；模型切换仍由后续安全边界执行。
   */
  decideRetryYield(input: {
    evaluate: (target: ExecutionFailoverPolicyTarget) => boolean;
    scope: ExecutionFailoverScope;
  }): Promise<ModelRetryYieldDecision>;
  complete(scope: ExecutionFailoverScope, traceContext: TraceContext): Promise<void>;
  applyActive(input: {
    commit: () => void;
    prepare: () => Promise<void>;
    rollbackPrepared?: () => Promise<void>;
    scope: ExecutionFailoverScope;
    target: ExecutionFailoverPolicyTarget;
  }): Promise<boolean>;
  retain(input: {
    currentSelection?: ModelSelection;
    lifetime: ExecutionFailoverScopeLifetime;
    scope: ExecutionFailoverScope;
    traceContext: TraceContext;
  }): Promise<void>;
  release(scope: ExecutionFailoverScope, traceContext: TraceContext): Promise<void>;
  releaseLineageLease(leaseId: string): Promise<void>;
  reset(): Promise<void>;
  resolve(scope: ExecutionFailoverScope): ExecutionFailoverPolicyTarget | undefined;
  settle(): Promise<void>;
  setTarget(input: SetExecutionFailoverTargetInput): Promise<"applied" | "stale">;
}

interface PolicyMutationContext {
  hasQueuedSuccessor(): boolean;
}

export class ExecutionFailoverPreparedRollbackError extends Error {
  constructor(readonly rollbackCause: unknown) {
    super("Execution failover prepared state could not be rolled back", { cause: rollbackCause });
    this.name = "ExecutionFailoverPreparedRollbackError";
  }
}

export function createExecutionFailoverPolicyPort(
  owner: AgentRuntimeInternal,
): ExecutionFailoverPolicyPort {
  return {
    acquireLineageLease: (leaseId) =>
      mutatePolicy(owner, () => acquireLineageLease(owner, leaseId)),
    activate: (input) => mutatePolicy(owner, (context) => activateTarget(owner, input, context)),
    applyActive: (input) =>
      mutatePolicy(owner, (context) => applyActiveTarget(owner, input, context)),
    block: (input) => mutatePolicy(owner, () => blockTarget(owner, input)),
    decideRetryYield: (input) => mutatePolicy(owner, () => decideRetryYield(owner, input)),
    complete: (scope, traceContext) =>
      mutatePolicy(owner, () => completeTarget(owner, scope, traceContext)),
    retain: (input) => mutatePolicy(owner, () => registerInheritedTarget(owner, input)),
    release: (scope, traceContext) =>
      mutatePolicy(owner, () => releaseInheritedTarget(owner, scope, traceContext)),
    releaseLineageLease: (leaseId) =>
      mutatePolicy(owner, () => releaseLineageLease(owner, leaseId)),
    reset: () => mutatePolicy(owner, () => resetPolicy(owner)),
    resolve: (scope) => resolveTarget(owner.executionFailoverState, scope),
    settle: () => settlePolicyMutations(owner),
    setTarget: (input) => mutatePolicy(owner, () => replacePolicy(owner, input)),
  };
}

async function decideRetryYield(
  owner: AgentRuntimeInternal,
  input: {
    evaluate: (target: ExecutionFailoverPolicyTarget) => boolean;
    scope: ExecutionFailoverScope;
  },
): Promise<ModelRetryYieldDecision> {
  const target = resolveTarget(owner.executionFailoverState, input.scope);
  if (!target) return { shouldYield: false };
  return {
    policyRevision: target.revision,
    shouldYield: input.evaluate(target),
    sourceCommandId: target.sourceCommandId,
  };
}

async function applyActiveTarget(
  owner: AgentRuntimeInternal,
  input: {
    commit: () => void;
    prepare: () => Promise<void>;
    rollbackPrepared?: () => Promise<void>;
    scope: ExecutionFailoverScope;
    target: ExecutionFailoverPolicyTarget;
  },
  mutation: PolicyMutationContext,
): Promise<boolean> {
  const state = owner.executionFailoverState;
  if (!state || state.sourceCommandId !== input.target.sourceCommandId) return false;
  const resolved = resolveTarget(state, input.scope);
  if (
    !resolved ||
    resolved.status !== "active" ||
    !sameExecutionModelSelection(resolved.modelSelection, input.target.modelSelection)
  ) {
    return false;
  }
  if (mutation.hasQueuedSuccessor()) return false;
  await input.prepare();
  // prepare 期间到达的新命令属于同一个尚未提交的安全边界。持久 actor 的 prepare
  // 可能已写 journal，必须先补偿回边界起点，再让最新目标继续，避免 journal B / runtime A。
  if (mutation.hasQueuedSuccessor()) {
    await rollbackSupersededPreparation(input.rollbackPrepared);
    return false;
  }
  input.commit();
  updateInheritedRegistrationSelection(owner, input.scope, resolved.modelSelection);
  return true;
}

export function setExecutionFailoverTarget(
  this: AgentRuntimeInternal,
  input: SetExecutionFailoverTargetInput,
): Promise<"applied" | "stale"> {
  return this.executionFailoverPolicyPort.setTarget(input);
}

export function getExecutionFailoverPolicyPort(
  this: AgentRuntimeInternal,
): ExecutionFailoverPolicyPort {
  return this.executionFailoverPolicyPort;
}

export function getExecutionFailoverLineageId(this: AgentRuntimeInternal): string | undefined {
  return resolveExecutionFailoverLineageId(this);
}

export function resolveRuntimeExecutionFailoverScope(
  runtime: AgentRuntimeInternal,
): ExecutionFailoverScope {
  return (
    runtime.executionFailoverScope ?? {
      foregroundExecutionId: runtime.activeForegroundExecution?.foregroundExecutionId,
    }
  );
}

export function sameExecutionModelSelection(
  left: ModelSelection | undefined,
  right: ModelSelection,
): boolean {
  return (
    left?.providerId === right.providerId &&
    left.modelId === right.modelId &&
    left.options?.reasoningLevel === right.options?.reasoningLevel &&
    left.options?.speed === right.options?.speed
  );
}

async function replacePolicy(
  owner: AgentRuntimeInternal,
  input: SetExecutionFailoverTargetInput,
): Promise<"applied" | "stale"> {
  if (owner.executionFailoverState?.sourceCommandId === input.sourceCommandId) return "applied";

  const accepted: ExecutionFailoverTargetState[] = [];
  const observedLiveLineages = new Set<string>();
  let observedLiveTarget = false;
  const foregroundId = input.observedTargets.foregroundExecutionId;
  const observedBackgroundWorkIds = new Set(input.observedTargets.backgroundWorkIds);
  const observedRetainedLineages = new Set(
    [...observedBackgroundWorkIds]
      .map(
        (backgroundWorkId) =>
          owner.executionFailoverRegistrations.get(backgroundWorkId)?.scope.foregroundExecutionId,
      )
      .filter((lineage): lineage is string => Boolean(lineage)),
  );
  const lineageRoot =
    foregroundId ??
    (observedRetainedLineages.size === 1
      ? observedRetainedLineages.values().next().value
      : undefined);
  const foregroundIsLive =
    foregroundId !== undefined &&
    owner.activeForegroundExecution?.foregroundExecutionId === foregroundId;
  let retainedLineageIsLive = false;
  if (foregroundId && foregroundIsLive) {
    observedLiveTarget = true;
    observedLiveLineages.add(foregroundId);
    const currentSelection = currentSelectionForTarget(owner, "foregroundExecution", foregroundId);
    if (!sameExecutionModelSelection(currentSelection, input.modelSelection)) {
      pushAcceptedTarget(accepted, {
        kind: "foregroundExecution",
        id: foregroundId,
        status: "waitingSafeBoundary",
        ...(currentSelection ? { currentSelection: cloneModelSelection(currentSelection) } : {}),
      });
    }
  }

  for (const backgroundWorkId of observedBackgroundWorkIds) {
    const task = owner.runtimeTaskRegistry.get(backgroundWorkId);
    const registration = owner.executionFailoverRegistrations.get(backgroundWorkId);
    if ((!task || task.type !== "local_agent" || task.status !== "running") && !registration) {
      continue;
    }
    observedLiveTarget = true;
    if (registration?.scope.foregroundExecutionId) {
      retainedLineageIsLive = true;
      observedLiveLineages.add(registration.scope.foregroundExecutionId);
    }
    const currentSelection = currentSelectionForTarget(owner, "backgroundWork", backgroundWorkId);
    if (sameExecutionModelSelection(currentSelection, input.modelSelection)) continue;
    pushAcceptedTarget(accepted, {
      kind: "backgroundWork",
      id: backgroundWorkId,
      status: "waitingSafeBoundary",
      ...(currentSelection ? { currentSelection: cloneModelSelection(currentSelection) } : {}),
    });
  }

  if (lineageRoot) {
    for (const registration of owner.executionFailoverRegistrations.values()) {
      if (
        registration.scope.foregroundExecutionId !== lineageRoot ||
        !registration.scope.backgroundWorkId ||
        accepted.some(
          (target) =>
            target.kind === "backgroundWork" && target.id === registration.scope.backgroundWorkId,
        )
      ) {
        continue;
      }
      observedLiveTarget = true;
      retainedLineageIsLive = true;
      observedLiveLineages.add(lineageRoot);
      if (sameExecutionModelSelection(registration.currentSelection, input.modelSelection))
        continue;
      pushAcceptedTarget(accepted, {
        kind: "backgroundWork",
        id: registration.scope.backgroundWorkId,
        status: "waitingSafeBoundary",
        ...(registration.currentSelection
          ? { currentSelection: cloneModelSelection(registration.currentSelection) }
          : {}),
      });
    }
  }

  if (!observedLiveTarget) return "stale";

  const revision = owner.executionFailoverRevision + 1;
  const state: ExecutionFailoverState | null =
    accepted.length === 0
      ? null
      : {
          revision,
          sourceCommandId: input.sourceCommandId,
          modelSelection: cloneModelSelection(input.modelSelection),
          ...(lineageRoot && (foregroundIsLive || retainedLineageIsLive)
            ? { foregroundExecutionId: lineageRoot }
            : {}),
          targets: accepted,
          updatedAt: owner.now().getTime(),
        };
  await appendPolicyEvent(owner, {
    cause: state ? "userRequested" : "targetsCompleted",
    revision,
    sourceCommandId: input.sourceCommandId,
    state,
    traceContext: input.traceContext,
  });
  for (const lineageId of observedLiveLineages) {
    retainDormantIntentForLeasedLineage(owner, lineageId, {
      acceptedRevision: revision,
      modelSelection: input.modelSelection,
      sourceCommandId: input.sourceCommandId,
    });
  }
  owner.executionFailoverRevision = revision;
  owner.executionFailoverState = state ?? undefined;
  return "applied";
}

async function activateTarget(
  owner: AgentRuntimeInternal,
  input: {
    attempt: number;
    beforeActivate?: () => Promise<void>;
    commit: () => void;
    from: ModelSelection;
    prepare: () => Promise<void>;
    rollbackPrepared?: () => Promise<void>;
    reasonCode: ExecutionFailoverReasonCode;
    scope: ExecutionFailoverScope;
    target: ExecutionFailoverPolicyTarget;
    traceContext: TraceContext;
  },
  mutation: PolicyMutationContext,
): Promise<boolean> {
  const state = owner.executionFailoverState;
  if (!state || state.sourceCommandId !== input.target.sourceCommandId) return false;
  const resolved = resolveTarget(state, input.scope);
  if (!resolved || resolved.status === "blocked") return false;
  if (mutation.hasQueuedSuccessor()) return false;
  await input.beforeActivate?.();
  if (mutation.hasQueuedSuccessor()) return false;
  // journal / durable selection 必须先成功；失败时 policy 仍保持 waiting，下一安全边界可重试。
  await input.prepare();
  // 不能因 actor journal 已写入就把中间 B 提交为 active；最新命令仍是本边界唯一权威。
  if (mutation.hasQueuedSuccessor()) {
    await rollbackSupersededPreparation(input.rollbackPrepared);
    return false;
  }

  const at = owner.now().getTime();
  const transition: ExecutionFailoverTransition = {
    targetKind: resolved.kind,
    targetId: resolved.id,
    from: cloneModelSelection(input.from),
    to: cloneModelSelection(state.modelSelection),
    reasonCode: input.reasonCode,
    attempt: input.attempt,
    at,
  };
  const nextTargets = upsertTarget(state.targets, {
    kind: resolved.kind,
    id: resolved.id,
    status: "active",
    currentSelection: cloneModelSelection(state.modelSelection),
  });
  const revision = owner.executionFailoverRevision + 1;
  const next: ExecutionFailoverState = {
    ...state,
    revision,
    targets: nextTargets,
    lastTransition: transition,
    updatedAt: at,
  };
  try {
    await appendPolicyEvent(owner, {
      cause: input.reasonCode === "userRequested" ? "safeBoundaryActivated" : "eligibleFailure",
      revision,
      sourceCommandId: state.sourceCommandId,
      state: next,
      traceContext: input.traceContext,
      transition,
    });
  } catch (error) {
    // active 事件未落盘时必须把已 prepare 的 journal 恢复到边界起点，避免持久化 B、运行态 A 的半提交。
    await rollbackSupersededPreparation(input.rollbackPrepared);
    throw error;
  }
  owner.executionFailoverRevision = revision;
  owner.executionFailoverState = next;
  // event append 是最后一个异步提交窗；期间进入的新目标仍必须阻止旧模型落到 loop/session。
  // 已追加事件需要先成为 owner 的 revision 基线，后继命令才能用更高 revision 覆盖它。
  if (mutation.hasQueuedSuccessor()) {
    await rollbackSupersededPreparation(input.rollbackPrepared);
    return false;
  }
  input.commit();
  // runtime-lifetime actor 的实际模型与 registration 必须在同一个串行 mutation 内提交。
  // 否则 policy 清除后紧接着的切换会读到首次 retain 的旧选择，误判为无需切换。
  updateInheritedRegistrationSelection(owner, input.scope, state.modelSelection);
  return true;
}

async function rollbackSupersededPreparation(
  rollbackPrepared: (() => Promise<void>) | undefined,
): Promise<void> {
  if (!rollbackPrepared) return;
  try {
    await rollbackPrepared();
  } catch (error) {
    // 补偿失败后 durable selection 未知，必须把错误标成不可被 latest-wins 吞掉的 fail-closed。
    throw new ExecutionFailoverPreparedRollbackError(error);
  }
}

async function blockTarget(
  owner: AgentRuntimeInternal,
  input: {
    currentSelection: ModelSelection;
    reasonCode: string;
    scope: ExecutionFailoverScope;
    target: ExecutionFailoverPolicyTarget;
    traceContext: TraceContext;
  },
): Promise<void> {
  const state = owner.executionFailoverState;
  if (!state || state.sourceCommandId !== input.target.sourceCommandId) return;
  const resolved = resolveTarget(state, input.scope);
  if (!resolved || resolved.status === "blocked") return;
  const revision = owner.executionFailoverRevision + 1;
  const next: ExecutionFailoverState = {
    ...state,
    revision,
    targets: upsertTarget(state.targets, {
      kind: resolved.kind,
      id: resolved.id,
      status: "blocked",
      currentSelection: cloneModelSelection(input.currentSelection),
      reasonCode: input.reasonCode,
    }),
    updatedAt: owner.now().getTime(),
  };
  await appendPolicyEvent(owner, {
    cause: "targetBlocked",
    revision,
    sourceCommandId: state.sourceCommandId,
    state: next,
    traceContext: input.traceContext,
  });
  owner.executionFailoverRevision = revision;
  owner.executionFailoverState = next;
}

async function completeTarget(
  owner: AgentRuntimeInternal,
  scope: ExecutionFailoverScope,
  traceContext: TraceContext,
): Promise<void> {
  const state = owner.executionFailoverState;
  if (!state) return;
  const matching = resolveExactTarget(state, scope);
  if (!matching) return;
  const remaining = state.targets.filter(
    (target) => target.kind !== matching.kind || target.id !== matching.id,
  );
  const revision = owner.executionFailoverRevision + 1;
  const next: ExecutionFailoverState | null =
    remaining.length === 0
      ? null
      : {
          ...state,
          revision,
          // lineage root 不是 foreground target 的生命周期镜像。只要 inherited child
          // 仍在，保留它，后续同一 workflow 新建 actor 才能继续 retain/继承。
          ...(state.foregroundExecutionId
            ? { foregroundExecutionId: state.foregroundExecutionId }
            : {}),
          targets: remaining,
          updatedAt: owner.now().getTime(),
        };
  await appendPolicyEvent(owner, {
    cause: "targetsCompleted",
    revision,
    sourceCommandId: state.sourceCommandId,
    state: next,
    traceContext,
  });
  owner.executionFailoverRevision = revision;
  owner.executionFailoverState = next ?? undefined;
}

async function registerInheritedTarget(
  owner: AgentRuntimeInternal,
  input: {
    currentSelection?: ModelSelection;
    lifetime: ExecutionFailoverScopeLifetime;
    scope: ExecutionFailoverScope;
    traceContext: TraceContext;
  },
): Promise<void> {
  const backgroundWorkId = input.scope.backgroundWorkId;
  if (!backgroundWorkId) return;
  const previous = owner.executionFailoverRegistrations.get(backgroundWorkId);
  const registration: ExecutionFailoverRegistration = {
    ...(input.currentSelection
      ? { currentSelection: cloneModelSelection(input.currentSelection) }
      : previous?.currentSelection
        ? { currentSelection: cloneModelSelection(previous.currentSelection) }
        : {}),
    // 同一 work 可能先随首个 turn 注册，随后被宿主提升为可复用 actor runtime。
    // lifetime 只能单向升级，避免后续 turn retain 把已公开的 runtime 资格降级掉。
    lifetime: previous?.lifetime === "runtime" || input.lifetime === "runtime" ? "runtime" : "turn",
    scope: { ...input.scope },
  };

  const state = owner.executionFailoverState;
  const lineageId = input.scope.foregroundExecutionId;
  const dormantIntent = lineageId
    ? owner.executionFailoverDormantIntents.get(lineageId)
    : undefined;
  const firstRegistration = previous === undefined;
  const eligibilityChanged =
    previous?.lifetime !== "runtime" && registration.lifetime === "runtime";
  const addPolicyTarget = Boolean(
    firstRegistration &&
    state &&
    input.scope.foregroundExecutionId &&
    state.foregroundExecutionId === input.scope.foregroundExecutionId &&
    !state.targets.some(
      (target) => target.kind === "backgroundWork" && target.id === backgroundWorkId,
    ) &&
    !sameExecutionModelSelection(input.currentSelection, state.modelSelection),
  );
  const materializeDormantTarget = Boolean(
    firstRegistration &&
    registration.lifetime === "runtime" &&
    !state &&
    lineageId &&
    dormantIntent &&
    !sameExecutionModelSelection(input.currentSelection, dormantIntent.modelSelection),
  );

  // 第二次 retain 只把工厂实际解析出的 selection 刷回 registration；membership 与 policy
  // 都没有变化时不制造事件，避免一次 actor ask 产生两条 eligibility delta。
  if (!eligibilityChanged && !addPolicyTarget && !materializeDormantTarget) {
    owner.executionFailoverRegistrations.set(backgroundWorkId, registration);
    return;
  }

  const revision = owner.executionFailoverRevision + 1;
  const next: ExecutionFailoverState | null = state
    ? {
        ...state,
        revision,
        ...(addPolicyTarget
          ? {
              targets: [
                ...state.targets,
                {
                  kind: "backgroundWork" as const,
                  id: backgroundWorkId,
                  status: "waitingSafeBoundary" as const,
                  ...(input.currentSelection
                    ? { currentSelection: cloneModelSelection(input.currentSelection) }
                    : {}),
                },
              ],
            }
          : {}),
        updatedAt: owner.now().getTime(),
      }
    : materializeDormantTarget && lineageId && dormantIntent
      ? {
          revision,
          sourceCommandId: dormantIntent.sourceCommandId,
          modelSelection: cloneModelSelection(dormantIntent.modelSelection),
          foregroundExecutionId: lineageId,
          targets: [
            {
              kind: "backgroundWork",
              id: backgroundWorkId,
              status: "waitingSafeBoundary",
              ...(input.currentSelection
                ? { currentSelection: cloneModelSelection(input.currentSelection) }
                : {}),
            },
          ],
          updatedAt: owner.now().getTime(),
        }
      : null;
  await appendPolicyEvent(owner, {
    cause: eligibilityChanged ? "eligibleTargetsChanged" : "userRequested",
    eligibleBackgroundWorkIds: projectEligibleBackgroundWorkIds(owner, {
      upsert: { id: backgroundWorkId, registration },
    }),
    revision,
    ...(next ? { sourceCommandId: next.sourceCommandId } : {}),
    state: next,
    traceContext: input.traceContext,
  });
  owner.executionFailoverRegistrations.set(backgroundWorkId, registration);
  owner.executionFailoverRevision = revision;
  owner.executionFailoverState = next ?? undefined;
}

async function releaseInheritedTarget(
  owner: AgentRuntimeInternal,
  scope: ExecutionFailoverScope,
  traceContext: TraceContext,
): Promise<void> {
  const backgroundWorkId = scope.backgroundWorkId;
  const registration = backgroundWorkId
    ? owner.executionFailoverRegistrations.get(backgroundWorkId)
    : undefined;
  const eligibilityChanged = registration?.lifetime === "runtime";
  const state = owner.executionFailoverState;
  const matching = state ? resolveExactTarget(state, scope) : undefined;

  if (!eligibilityChanged && !matching) {
    if (backgroundWorkId) {
      owner.executionFailoverRegistrations.delete(backgroundWorkId);
      cleanupDormantIntentIfUnretained(owner, registration?.scope.foregroundExecutionId);
    }
    return;
  }

  const revision = owner.executionFailoverRevision + 1;
  const remaining = matching
    ? state?.targets.filter((target) => target.kind !== matching.kind || target.id !== matching.id)
    : state?.targets;
  const next: ExecutionFailoverState | null =
    !state || remaining?.length === 0
      ? null
      : {
          ...state,
          revision,
          targets: remaining ?? state.targets,
          updatedAt: owner.now().getTime(),
        };
  await appendPolicyEvent(owner, {
    cause: matching ? "targetsCompleted" : "eligibleTargetsChanged",
    eligibleBackgroundWorkIds: projectEligibleBackgroundWorkIds(
      owner,
      backgroundWorkId ? { removeId: backgroundWorkId } : {},
    ),
    revision,
    ...(state ? { sourceCommandId: state.sourceCommandId } : {}),
    state: next,
    traceContext,
  });
  if (backgroundWorkId) {
    owner.executionFailoverRegistrations.delete(backgroundWorkId);
    cleanupDormantIntentIfUnretained(owner, registration?.scope.foregroundExecutionId);
  }
  owner.executionFailoverRevision = revision;
  owner.executionFailoverState = next ?? undefined;
}

function updateInheritedRegistrationSelection(
  owner: AgentRuntimeInternal,
  scope: ExecutionFailoverScope,
  selection: ModelSelection,
): void {
  const backgroundWorkId = scope.backgroundWorkId;
  if (!backgroundWorkId) return;
  const registration = owner.executionFailoverRegistrations.get(backgroundWorkId);
  if (!registration) return;
  owner.executionFailoverRegistrations.set(backgroundWorkId, {
    currentSelection: cloneModelSelection(selection),
    lifetime: registration.lifetime,
    scope: { ...registration.scope },
  });
}

async function acquireLineageLease(
  owner: AgentRuntimeInternal,
  leaseId: string,
): Promise<ExecutionFailoverLineageLease | undefined> {
  const normalizedLeaseId = leaseId.trim();
  if (!normalizedLeaseId) throw new Error("Execution failover lineage lease id must not be empty");
  const existing = owner.executionFailoverLineageLeases.get(normalizedLeaseId);
  if (existing) return { ...existing };
  const foregroundExecutionId = resolveExecutionFailoverLineageId(owner);
  if (!foregroundExecutionId) return undefined;
  const lease = { foregroundExecutionId, leaseId: normalizedLeaseId };
  owner.executionFailoverLineageLeases.set(normalizedLeaseId, lease);
  const state = owner.executionFailoverState;
  if (state?.foregroundExecutionId === foregroundExecutionId) {
    retainDormantIntentForLeasedLineage(owner, foregroundExecutionId, {
      acceptedRevision: state.revision,
      modelSelection: state.modelSelection,
      sourceCommandId: state.sourceCommandId,
    });
  }
  return { ...lease };
}

async function releaseLineageLease(owner: AgentRuntimeInternal, leaseId: string): Promise<void> {
  const lease = owner.executionFailoverLineageLeases.get(leaseId);
  if (!lease) return;
  owner.executionFailoverLineageLeases.delete(leaseId);
  cleanupDormantIntentIfUnretained(owner, lease.foregroundExecutionId);
}

async function resetPolicy(owner: AgentRuntimeInternal): Promise<void> {
  owner.executionFailoverState = undefined;
  owner.executionFailoverRevision = 0;
  owner.executionFailoverRegistrations.clear();
  owner.executionFailoverLineageLeases.clear();
  owner.executionFailoverDormantIntents.clear();
}

function resolveExecutionFailoverLineageId(owner: AgentRuntimeInternal): string | undefined {
  const activeOrArmed =
    owner.activeForegroundExecution?.foregroundExecutionId ??
    owner.executionFailoverState?.foregroundExecutionId;
  if (activeOrArmed) return activeOrArmed;
  const retainedLineages = new Set<string>();
  for (const registration of owner.executionFailoverRegistrations.values()) {
    const lineageId = registration.scope.foregroundExecutionId;
    if (lineageId) retainedLineages.add(lineageId);
  }
  for (const lease of owner.executionFailoverLineageLeases.values()) {
    retainedLineages.add(lease.foregroundExecutionId);
  }
  // 一个 session 极端情况下可同时保留多个旧 workflow lineage；无唯一答案时不跨 lineage 猜测。
  return retainedLineages.size === 1 ? retainedLineages.values().next().value : undefined;
}

function retainDormantIntentForLeasedLineage(
  owner: AgentRuntimeInternal,
  lineageId: string,
  intent: ExecutionFailoverDormantIntent,
): void {
  const retained = [...owner.executionFailoverLineageLeases.values()].some(
    (lease) => lease.foregroundExecutionId === lineageId,
  );
  if (!retained) return;
  owner.executionFailoverDormantIntents.set(lineageId, {
    acceptedRevision: intent.acceptedRevision,
    modelSelection: cloneModelSelection(intent.modelSelection),
    sourceCommandId: intent.sourceCommandId,
  });
}

function cleanupDormantIntentIfUnretained(
  owner: AgentRuntimeInternal,
  lineageId: string | undefined,
): void {
  if (!lineageId) return;
  const hasLease = [...owner.executionFailoverLineageLeases.values()].some(
    (lease) => lease.foregroundExecutionId === lineageId,
  );
  const hasRegistration = [...owner.executionFailoverRegistrations.values()].some(
    (registration) => registration.scope.foregroundExecutionId === lineageId,
  );
  if (!hasLease && !hasRegistration) owner.executionFailoverDormantIntents.delete(lineageId);
}

function resolveTarget(
  state: ExecutionFailoverState | undefined,
  scope: ExecutionFailoverScope,
): ExecutionFailoverPolicyTarget | undefined {
  if (!state) return undefined;
  const exact = resolveExactTarget(state, scope);
  if (exact) return policyTarget(state, exact);

  // 用户发出命令后才由同一前台 lineage 创建的 child 继承目标；首次激活时才把 child
  // 追加到权威 target 列表，避免把尚未创建的 work 猜进策略。
  if (
    scope.backgroundWorkId &&
    scope.foregroundExecutionId &&
    state.foregroundExecutionId === scope.foregroundExecutionId
  ) {
    return {
      id: scope.backgroundWorkId,
      kind: "backgroundWork",
      modelSelection: cloneModelSelection(state.modelSelection),
      revision: state.revision,
      sourceCommandId: state.sourceCommandId,
      status: "waitingSafeBoundary",
    };
  }
  return undefined;
}

function resolveExactTarget(
  state: ExecutionFailoverState,
  scope: ExecutionFailoverScope,
): ExecutionFailoverTargetState | undefined {
  if (scope.backgroundWorkId) {
    // background scope 同时携带 lineage，但精确清理不能降级匹配 foreground；
    // 否则尚未成为 policy target 的 actor release 会误删主任务 target。
    return state.targets.find(
      (target) => target.kind === "backgroundWork" && target.id === scope.backgroundWorkId,
    );
  }
  if (scope.foregroundExecutionId) {
    return state.targets.find(
      (target) =>
        target.kind === "foregroundExecution" && target.id === scope.foregroundExecutionId,
    );
  }
  return undefined;
}

function policyTarget(
  state: ExecutionFailoverState,
  target: ExecutionFailoverTargetState,
): ExecutionFailoverPolicyTarget {
  return {
    ...(target.currentSelection
      ? { currentSelection: cloneModelSelection(target.currentSelection) }
      : {}),
    id: target.id,
    kind: target.kind,
    modelSelection: cloneModelSelection(state.modelSelection),
    revision: state.revision,
    sourceCommandId: state.sourceCommandId,
    status: target.status,
  };
}

function currentSelectionForTarget(
  owner: AgentRuntimeInternal,
  kind: ExecutionFailoverTargetState["kind"],
  id: string,
): ModelSelection | undefined {
  const existing = owner.executionFailoverState?.targets.find(
    (target) => target.kind === kind && target.id === id,
  )?.currentSelection;
  if (existing) return existing;
  if (kind === "foregroundExecution") {
    return owner.activeForegroundExecution?.foregroundExecutionId === id
      ? owner.activeForegroundExecution.currentModelSelection
      : undefined;
  }
  return (
    owner.runtimeTaskRegistry.get(id)?.modelSelection ??
    owner.executionFailoverRegistrations.get(id)?.currentSelection
  );
}

function upsertTarget(
  targets: readonly ExecutionFailoverTargetState[],
  next: ExecutionFailoverTargetState,
): ExecutionFailoverTargetState[] {
  const index = targets.findIndex((target) => target.kind === next.kind && target.id === next.id);
  if (index < 0) {
    return [...targets, next];
  }
  return targets.map((target, targetIndex) => (targetIndex === index ? next : target));
}

function pushAcceptedTarget(
  targets: ExecutionFailoverTargetState[],
  target: ExecutionFailoverTargetState,
): void {
  targets.push(target);
}

async function appendPolicyEvent(
  owner: AgentRuntimeInternal,
  input: {
    cause:
      | "userRequested"
      | "eligibleFailure"
      | "eligibleTargetsChanged"
      | "safeBoundaryActivated"
      | "targetBlocked"
      | "targetsCompleted";
    eligibleBackgroundWorkIds?: string[];
    revision: number;
    sourceCommandId?: string;
    state: ExecutionFailoverState | null;
    traceContext: TraceContext;
    transition?: ExecutionFailoverTransition;
  },
): Promise<void> {
  await owner.appendEvent(
    owner.createEvent(
      SessionEventType.ExecutionFailoverChanged,
      {
        revision: input.revision,
        cause: input.cause,
        eligibleBackgroundWorkIds:
          input.eligibleBackgroundWorkIds ?? projectEligibleBackgroundWorkIds(owner),
        ...(input.sourceCommandId ? { sourceCommandId: input.sourceCommandId } : {}),
        state: input.state ? projectExecutionFailoverState(input.state) : null,
        ...(input.transition ? { transition: input.transition } : {}),
      },
      input.traceContext,
    ),
    input.traceContext,
  );
}

function projectExecutionFailoverState(state: ExecutionFailoverState): ExecutionFailoverState {
  if (state.targets.length <= MAX_EXECUTION_FAILOVER_TARGETS) return state;

  // Runtime 保留完整真实目标；协议投影先保留 foreground，再按目标接受顺序稳定填充。
  // UI/协议容量只能限制观察面，不能反向成为执行准入 gate；截断元数据明确披露真实数量。
  const foregroundTargets = state.targets.filter((target) => target.kind === "foregroundExecution");
  const backgroundTargets = state.targets.filter((target) => target.kind === "backgroundWork");
  return {
    ...state,
    targets: [...foregroundTargets, ...backgroundTargets].slice(0, MAX_EXECUTION_FAILOVER_TARGETS),
    targetCount: state.targets.length,
    targetsTruncated: true,
  };
}

function projectEligibleBackgroundWorkIds(
  owner: AgentRuntimeInternal,
  mutation: {
    removeId?: string;
    upsert?: { id: string; registration: ExecutionFailoverRegistration };
  } = {},
): string[] {
  const entries = [...owner.executionFailoverRegistrations.entries()].filter(
    ([id]) => id !== mutation.removeId,
  );
  const upsert = mutation.upsert;
  if (upsert) {
    const existingIndex = entries.findIndex(([id]) => id === upsert.id);
    const nextEntry: [string, ExecutionFailoverRegistration] = [upsert.id, upsert.registration];
    if (existingIndex >= 0) entries[existingIndex] = nextEntry;
    else entries.push(nextEntry);
  }

  const eligible = entries.filter(([, registration]) => registration.lifetime === "runtime");
  const result: string[] = [];
  const selected = new Set<string>();
  const representedLineages = new Set<string>();
  const append = (id: string): void => {
    if (result.length >= MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS || selected.has(id)) {
      return;
    }
    selected.add(id);
    result.push(id);
  };

  // 截断前先让每条 lineage 至少有一个可观察 ID，避免早创建的大 run 挤掉其他 lineage。
  for (const [id, registration] of eligible) {
    const lineage = registration.scope.foregroundExecutionId;
    if (!lineage || representedLineages.has(lineage)) continue;
    representedLineages.add(lineage);
    append(id);
  }
  for (const [id] of eligible) append(id);
  return result;
}

function mutatePolicy<T>(
  owner: AgentRuntimeInternal,
  mutation: (context: PolicyMutationContext) => Promise<T>,
): Promise<T> {
  let ownTail: Promise<void> | undefined;
  const context: PolicyMutationContext = {
    hasQueuedSuccessor: () => ownTail !== undefined && owner.executionFailoverMutation !== ownTail,
  };
  const run = () => mutation(context);
  const result = owner.executionFailoverMutation.then(run, run);
  ownTail = result.then(
    () => undefined,
    () => undefined,
  );
  owner.executionFailoverMutation = ownTail;
  return result;
}

async function settlePolicyMutations(owner: AgentRuntimeInternal): Promise<void> {
  while (true) {
    const tail = owner.executionFailoverMutation;
    await tail;
    if (tail === owner.executionFailoverMutation) return;
  }
}
