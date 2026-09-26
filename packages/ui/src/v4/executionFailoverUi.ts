import {
  MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS,
  type ActiveWorkSummary,
  type BackgroundWorkSummary,
} from "@zcode/shared/zcode-protocol-v4";
import type { ModelSelection } from "@zcode/shared";

export interface ExecutionFailoverObservedTargets {
  foregroundExecutionId?: string;
  backgroundWorkIds: string[];
}

interface ExecutionFailoverActivitySnapshot {
  control: {
    activeWorks: readonly ActiveWorkSummary[];
  };
  backgroundWorks: readonly BackgroundWorkSummary[];
  executionFailoverEligibleBackgroundWorkIds?: readonly string[];
}

export type ExecutionFailoverCommandPayload = {
  modelSelection: ModelSelection;
  observedTargets: ExecutionFailoverObservedTargets;
};

type ExecutionSwitchTargetStatus = "waitingSafeBoundary" | "switching" | "active" | "blocked";

interface ExecutionSwitchProjection {
  modelSelection: ModelSelection;
  targets: ReadonlyArray<{
    kind: "foregroundExecution" | "backgroundWork";
    id: string;
    status: ExecutionSwitchTargetStatus;
    currentSelection?: ModelSelection;
  }>;
  lastTransition?: {
    targetKind: "foregroundExecution" | "backgroundWork";
    targetId: string;
    from: ModelSelection;
    to: ModelSelection;
  };
}

export type ExecutionSwitchDisplay =
  | {
      kind: "waitingSafeBoundary" | "switching" | "blocked";
      currentSelection: ModelSelection | null;
      targetSelection: ModelSelection;
    }
  | {
      kind: "active";
      from: ModelSelection | null;
      to: ModelSelection;
    };

const EXECUTION_SWITCH_STATUS_PRIORITY: readonly ExecutionSwitchTargetStatus[] = [
  "switching",
  "waitingSafeBoundary",
  "active",
  "blocked",
];
const LEGACY_MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS = 32;

/**
 * 冻结用户选择安全切换目标模型这一刻看到的执行目标。ID 本身是 Runtime 的 stale guard；
 * Renderer 不保存权威 policy，也不使用会误伤并发投影的 snapshot revision。
 */
export function captureExecutionFailoverTargets(
  snapshot: ExecutionFailoverActivitySnapshot | null | undefined,
): ExecutionFailoverObservedTargets | null {
  if (!snapshot) return null;

  const foregroundExecutionId = snapshot.control.activeWorks
    .map((work) => work.foregroundExecutionId?.trim())
    .find((executionId): executionId is string => Boolean(executionId));
  const eligibleBackgroundWorkIds = snapshot.executionFailoverEligibleBackgroundWorkIds;
  const backgroundWorkLimit =
    eligibleBackgroundWorkIds === undefined
      ? LEGACY_MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS
      : MAX_EXECUTION_FAILOVER_BACKGROUND_WORK_IDS;
  const backgroundWorkIds: string[] = [];
  const seenBackgroundWorkIds = new Set<string>();

  const appendTargetId = (value: string | undefined): void => {
    if (backgroundWorkIds.length >= backgroundWorkLimit) return;
    const targetId = value?.trim();
    if (!targetId || seenBackgroundWorkIds.has(targetId)) return;
    seenBackgroundWorkIds.add(targetId);
    backgroundWorkIds.push(targetId);
  };

  const appendEligibleTargets = (): void => {
    for (const backgroundWorkId of eligibleBackgroundWorkIds ?? []) {
      appendTargetId(backgroundWorkId);
      if (backgroundWorkIds.length === backgroundWorkLimit) return;
    }
  };

  const appendRunningSubagentWorks = (): void => {
    for (const work of snapshot.backgroundWorks) {
      if (work.kind !== "subagent" || work.status !== "running") continue;
      appendTargetId(work.workId);
      if (backgroundWorkIds.length === backgroundWorkLimit) return;
    }
  };

  // Bug 原因：foreground 结束后只有 Runtime 发布的 eligible registration 能恢复 lineage；
  // 因此新协议先保留它们。foreground 仍在时则先保留普通 work，再由 Runtime 按 lineage 扩展。
  if (!foregroundExecutionId) {
    appendEligibleTargets();
  }
  appendRunningSubagentWorks();
  if (foregroundExecutionId) {
    appendEligibleTargets();
  }

  if (!foregroundExecutionId && backgroundWorkIds.length === 0) return null;
  return {
    ...(foregroundExecutionId ? { foregroundExecutionId } : {}),
    backgroundWorkIds,
  };
}

/** 只有选择瞬间仍有精确活动目标时才构造命令；空闲会话只保留 Composer draft。 */
export function buildExecutionFailoverCommandPayload(
  snapshot: ExecutionFailoverActivitySnapshot | null | undefined,
  modelSelection: ModelSelection,
): ExecutionFailoverCommandPayload | null {
  const observedTargets = captureExecutionFailoverTargets(snapshot);
  return observedTargets ? { modelSelection, observedTargets } : null;
}

/**
 * 多目标 policy 只压成一行弱提示；优先展示正在切换和等待中的前台目标，
 * 完整目标状态仍由 snapshot 保留并由状态面板按需扩展。
 */
export function resolveExecutionSwitchDisplay(
  projection: ExecutionSwitchProjection | null | undefined,
  sessionSelection: ModelSelection | null | undefined,
): ExecutionSwitchDisplay | null {
  if (!projection || projection.targets.length === 0) return null;

  let representative = projection.targets[0]!;
  for (const status of EXECUTION_SWITCH_STATUS_PRIORITY) {
    const foreground = projection.targets.find(
      (target) => target.status === status && target.kind === "foregroundExecution",
    );
    const matching = foreground ?? projection.targets.find((target) => target.status === status);
    if (matching) {
      representative = matching;
      break;
    }
  }

  const matchingTransition =
    projection.lastTransition?.targetKind === representative.kind &&
    projection.lastTransition.targetId === representative.id
      ? projection.lastTransition
      : undefined;
  if (representative.status === "active") {
    return {
      kind: "active",
      from: matchingTransition?.from ?? representative.currentSelection ?? sessionSelection ?? null,
      to: matchingTransition?.to ?? projection.modelSelection,
    };
  }

  return {
    kind: representative.status,
    currentSelection: representative.currentSelection ?? sessionSelection ?? null,
    targetSelection: projection.modelSelection,
  };
}
