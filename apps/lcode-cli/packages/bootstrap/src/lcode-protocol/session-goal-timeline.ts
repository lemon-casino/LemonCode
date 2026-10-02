import {
  getLCodeGoalActiveIterationCount,
  type LCodeSessionGoal,
  type LCodeSessionGoalVerification,
  type LCodeSessionGoalVerificationTimeline,
} from "@lcode/shared";

import {
  EventReducer,
  SessionEventType,
  type GoalCompletionVerificationOutput,
  type MessageWithParts,
  type SessionEvent,
  type SessionGoal,
  type SessionInfo,
  type SessionProjection,
} from "@lcode/contracts";

import {
  asRecord,
  stringValue,
  normalizeTodoContent,
  compareMessagesByCreatedTime,
  normalizeText,
  readMessageText,
} from "./session-mapper-values.js";

export function mapGoalVerifications(
  verifications: SessionProjection["targetCompletionVerifications"] | undefined,
): LCodeSessionGoalVerification[] {
  return (verifications ?? []).map((verification) => ({
    nextAction: verification.nextAction ?? null,
    passed: verification.passed,
    reason: verification.reason,
  }));
}

export function mapGoalVerificationTimeline(
  timeline: SessionProjection["targetCompletionVerificationTimeline"] | undefined,
): LCodeSessionGoalVerificationTimeline[] {
  return (timeline ?? []).map((item) => ({
    version: 1,
    kind: "synthetic",
    type: "goal_verification",
    display: "separator",
    targetId: item.targetId,
    verificationId: item.verificationId,
    status: item.status,
    ...(item.goalIteration ? { goalIteration: item.goalIteration } : {}),
    ...(item.anchorAssistantMessageId
      ? { anchorAssistantMessageId: item.anchorAssistantMessageId }
      : {}),
    ...(item.anchorTurnId ? { anchorTurnId: item.anchorTurnId } : {}),
    ...(item.verification
      ? {
          verification: {
            nextAction: item.verification.nextAction ?? null,
            passed: item.verification.passed,
            reason: item.verification.reason,
          },
        }
      : {}),
    ...(item.startedAt ? { startedAt: item.startedAt.getTime() } : {}),
    updatedAt: item.updatedAt.getTime(),
  }));
}

export function mergePersistedGoalVerificationEvents(
  projection: SessionProjection,
  events: readonly SessionEvent[],
  target?: SessionGoal | null,
): SessionProjection {
  if (events.length === 0) {
    return projection;
  }

  const baseProjection = {
    ...projection,
    targetCompletionVerifications: projection.targetCompletionVerifications ?? [],
    targetCompletionVerificationTimeline: projection.targetCompletionVerificationTimeline ?? [],
  };
  const targetId = target?.targetID ?? projection.target?.targetID;
  const reducer = new EventReducer();
  const restored = [...events]
    .filter((event) => event.type === SessionEventType.TargetCompletionVerification)
    .filter((event) => {
      const payload = asRecord(event.payload);
      const eventTargetId = stringValue(payload.targetId);
      return !targetId || !eventTargetId || eventTargetId === targetId;
    })
    .sort(compareEventsByTimelineTime)
    .reduce((current, event) => reducer.apply(current, event), baseProjection);
  const timeline = getTargetGoalVerificationTimeline(restored, target).sort(
    compareGoalVerificationTimeline,
  );
  return {
    ...restored,
    targetCompletionVerificationTimeline: timeline,
    targetCompletionVerifications: mergeGoalVerificationSummaries(
      restored.targetCompletionVerifications,
      timeline,
    ),
  };
}

function compareEventsByTimelineTime(left: SessionEvent, right: SessionEvent): number {
  const byTime = left.timestamp.getTime() - right.timestamp.getTime();
  if (byTime !== 0) return byTime;
  return left.sequenceNumber - right.sequenceNumber;
}

function mergeGoalVerificationSummaries(
  verifications: readonly GoalCompletionVerificationOutput[],
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
): GoalCompletionVerificationOutput[] {
  const result: GoalCompletionVerificationOutput[] = [];
  const seen = new Set<string>();
  for (const verification of [
    ...verifications,
    ...timeline
      .map((item) => item.verification)
      .filter((item): item is GoalCompletionVerificationOutput => item !== undefined),
  ]) {
    const key = goalVerificationSummaryKey(verification);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(verification);
  }
  return result;
}

function goalVerificationSummaryKey(verification: GoalCompletionVerificationOutput): string {
  return [
    verification.passed ? "1" : "0",
    normalizeTodoContent(verification.reason),
    normalizeTodoContent(verification.nextAction ?? ""),
  ].join("\u0000");
}

export function withGoalSummaryTitleFallback(
  projection: SessionProjection,
  session: SessionInfo | null | undefined,
  messages: readonly MessageWithParts[],
): SessionProjection {
  const target = projection.target;
  if (!target || target.summaryTitle || !session?.title) {
    return projection;
  }
  const firstUserMessage = messages
    .filter((message) => message.info.role === "user")
    .sort(compareMessagesByCreatedTime)[0];
  if (
    !firstUserMessage ||
    Math.abs(firstUserMessage.info.time.created - target.time.created) > 5_000
  ) {
    return projection;
  }
  if (normalizeText(readMessageText(firstUserMessage)) !== normalizeText(target.objective)) {
    return projection;
  }
  return {
    ...projection,
    target: {
      ...target,
      // 首条用户请求就是 goal 时，session 标题才是第一轮标题的持久来源；
      // 老数据可能没有写 target.summaryTitle，恢复后需要用 session.title 补齐首轮标题。
      summaryTitle: session.title,
    },
  };
}

export function mapSessionGoal(
  goal: SessionGoal | null | undefined,
): LCodeSessionGoal | null | undefined {
  if (goal === undefined) return undefined;
  if (goal === null) return null;
  return {
    createdAt: goal.time.created,
    objective: goal.objective,
    sessionId: String(goal.sessionID),
    status: goal.status,
    summaryTitle: goal.summaryTitle,
    targetId: goal.targetID,
    timeUsedSeconds: goal.timeUsedSeconds ?? 0,
    tokenBudget: goal.tokenBudget ?? null,
    tokensUsed: goal.tokensUsed ?? 0,
    activeInputId: goal.activeInputId ?? null,
    activeRunStartedAtMs: goal.activeRunStartedAtMs ?? null,
    activeRunLastSeenAtMs: goal.activeRunLastSeenAtMs ?? null,
    updatedAt: goal.time.updated,
  };
}

export function getGoalActiveIterationCount(
  projection: SessionProjection,
  target?: SessionGoal | null,
): number {
  const timeline = getTargetGoalVerificationTimeline(projection, target);
  return getLCodeGoalActiveIterationCount({
    targetStatus: target?.status ?? null,
    timeline,
  });
}

export function getTargetGoalVerificationTimeline(
  projection: SessionProjection,
  target?: SessionGoal | null,
): SessionProjection["targetCompletionVerificationTimeline"] {
  const targetId = target?.targetID;
  return (projection.targetCompletionVerificationTimeline ?? [])
    .filter((item) => !targetId || item.targetId === targetId)
    .sort(compareGoalVerificationTimeline);
}

function compareGoalVerificationTimeline(
  left: SessionProjection["targetCompletionVerificationTimeline"][number],
  right: SessionProjection["targetCompletionVerificationTimeline"][number],
): number {
  const leftIteration = left.goalIteration ?? 0;
  const rightIteration = right.goalIteration ?? 0;
  if (leftIteration !== rightIteration && leftIteration > 0 && rightIteration > 0) {
    return leftIteration - rightIteration;
  }
  const byTime = goalVerificationTimelineTime(left) - goalVerificationTimelineTime(right);
  if (byTime !== 0) return byTime;
  return left.verificationId.localeCompare(right.verificationId);
}

function goalVerificationTimelineTime(
  item: SessionProjection["targetCompletionVerificationTimeline"][number],
): number {
  return (item.startedAt ?? item.updatedAt).getTime();
}

export function getGoalIterationForMessageTime(
  messageCreatedAt: number,
  target: SessionGoal | null | undefined,
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
): number | undefined {
  if (!target || messageCreatedAt < target.time.created) {
    return undefined;
  }
  let activeIteration = 1;
  for (const item of timeline) {
    const itemIteration = item.goalIteration ?? activeIteration;
    const boundaryTime = item.updatedAt.getTime();
    if (messageCreatedAt <= boundaryTime) {
      return itemIteration;
    }
    if (item.status === "started") {
      activeIteration = itemIteration;
      continue;
    }
    if (isPassingGoalVerification(item)) {
      return undefined;
    }
    activeIteration = itemIteration + 1;
  }
  return activeIteration;
}

export function getGoalIterationStartedAt(
  goalIteration: number,
  target: SessionGoal | null | undefined,
  timeline: readonly SessionProjection["targetCompletionVerificationTimeline"][number][],
  fallbackStartedAt: number,
): number {
  if (!target || goalIteration <= 1) {
    return target?.time.created ?? fallbackStartedAt;
  }
  const previousBoundary = [...timeline]
    .filter((item) => (item.goalIteration ?? 0) === goalIteration - 1)
    .filter((item) => item.status !== "started")
    .sort(compareGoalVerificationTimeline)
    .at(-1);
  return previousBoundary?.updatedAt.getTime() ?? fallbackStartedAt;
}

function isPassingGoalVerification(
  item: SessionProjection["targetCompletionVerificationTimeline"][number],
): boolean {
  return item.status === "completed" && item.verification?.passed === true;
}
