import {
  createSessionId,
  SessionEventType,
  selectActiveConversationBranch,
  type MessageWithParts,
  type SessionEvent,
  type SessionInfo,
  type ToolPart,
} from "@lcode/contracts";

const SUBAGENT_TOOL_NAMES = new Set(["Agent", "Task", "subagent"]);

export interface SubagentCandidate {
  agentId?: string;
  childSessionId: string;
  runInBackground: boolean;
  output: Record<string, unknown> | null;
  part: ToolPart;
  subagentType: string;
  summary?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: "success" | "failed" | "cancelled";
  title: string;
}

interface SubagentEventRelation {
  agentId?: string;
  childSessionId?: string;
  description?: string;
  startedAt?: number;
  stoppedAt?: number;
  stoppedStatus?: "success" | "failed" | "cancelled";
  subagentType?: string;
  summary?: string;
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

export function stringField(
  source: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = nonEmptyString(source[key]);
    if (value) return value;
  }
  return undefined;
}

function parseJsonObject(value: string | undefined): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return asRecord(JSON.parse(value) as unknown);
  } catch {
    return null;
  }
}

function agentIdFromLaunchAcknowledgement(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return nonEmptyString(value.match(/(?:^|\n)agentId:\s*([^\s(]+)/)?.[1]);
}

function contentBlocksToText(value: unknown): string | undefined {
  if (!Array.isArray(value)) return undefined;
  const text = value
    .map((block) => nonEmptyString(asRecord(block).text))
    .filter((item): item is string => Boolean(item))
    .join("\n\n");
  return text || undefined;
}

function subagentEventRelations(
  events: readonly SessionEvent[] | undefined,
): ReadonlyMap<string, SubagentEventRelation> {
  const relations = new Map<string, SubagentEventRelation>();
  for (const event of events ?? []) {
    if (
      event.type !== SessionEventType.SubagentSpawned &&
      event.type !== SessionEventType.SubagentStopped
    ) {
      continue;
    }
    const payload = asRecord(event.payload);
    const parentToolCallId = stringField(payload, "parentToolCallId");
    if (!parentToolCallId) continue;
    const current = relations.get(parentToolCallId) ?? {};
    if (event.type === SessionEventType.SubagentSpawned) {
      relations.set(parentToolCallId, {
        ...current,
        agentId: stringField(payload, "agentId") ?? current.agentId,
        childSessionId: stringField(payload, "childSessionId") ?? current.childSessionId,
        description: stringField(payload, "description", "prompt") ?? current.description,
        startedAt: event.timestamp.getTime(),
        subagentType: stringField(payload, "agentType") ?? current.subagentType,
      });
      continue;
    }
    const status = stringField(payload, "status");
    relations.set(parentToolCallId, {
      ...current,
      agentId: stringField(payload, "agentId") ?? current.agentId,
      childSessionId: stringField(payload, "childSessionId") ?? current.childSessionId,
      stoppedAt: event.timestamp.getTime(),
      stoppedStatus:
        status === "cancelled" || status === "stopped"
          ? "cancelled"
          : status === "failed" || status === "error"
            ? "failed"
            : "success",
      summary:
        stringField(payload, "summaryText", "result", "error", "description") ?? current.summary,
    });
  }
  return relations;
}

function activeBranchMessages(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
): MessageWithParts[] {
  return selectActiveConversationBranch(messages, {
    branchCutAfterMessageId: session.revert?.branchCutAfterMessageID,
    rewindCreatedMessageId: session.revert?.createdMessageID,
    rewindKeptMessageIds: session.revert?.keptMessageIDs,
    rewindTargetMessageId: session.revert?.targetMessageID,
  });
}

function candidateFromToolPart(
  part: ToolPart,
  relation?: SubagentEventRelation,
): SubagentCandidate | null {
  if (!SUBAGENT_TOOL_NAMES.has(part.tool)) return null;
  const completedOutput =
    part.state.status === "completed" ? nonEmptyString(part.state.output) : undefined;
  const output = parseJsonObject(completedOutput);
  const input = asRecord(part.state.input);
  const stateMetadata = "metadata" in part.state ? asRecord(part.state.metadata) : {};
  const metadata = { ...asRecord(part.metadata), ...stateMetadata };
  const agentId =
    stringField(output ?? {}, "agentId") ??
    // 后台 Agent 的持久化 launch ACK 是纯文本，cold query 未携带
    // 临时 spawn event 时无法恢复 childSessionId，导致真实 running Agent 被整条跳过。
    // 标准 ACK 自带 agentId，按该稳定字段恢复，与 runtime 的 session id 规则对齐。
    agentIdFromLaunchAcknowledgement(completedOutput) ??
    stringField(metadata, "agentId") ??
    relation?.agentId;
  const childSessionId =
    stringField(output ?? {}, "childSessionId") ??
    stringField(metadata, "childSessionId") ??
    relation?.childSessionId ??
    (agentId ? createSessionId(`subagent_${agentId}`) : undefined);
  if (!childSessionId) return null;
  const title =
    stringField(output ?? {}, "description") ??
    stringField(input, "description") ??
    stringField(metadata, "description") ??
    relation?.description ??
    stringField(input, "prompt") ??
    "Subagent";
  return {
    childSessionId,
    runInBackground: input.run_in_background === true,
    part,
    output,
    agentId: agentId ?? part.callID,
    subagentType:
      stringField(output ?? {}, "agentType") ??
      stringField(metadata, "agentType") ??
      relation?.subagentType ??
      stringField(input, "subagent_type", "agent", "agentType") ??
      "subagent",
    title,
    summary:
      contentBlocksToText(output?.content) ??
      stringField(output ?? {}, "result", "summary") ??
      (part.state.status === "error" ? nonEmptyString(part.state.error) : undefined) ??
      relation?.summary,
    ...(relation?.startedAt !== undefined ? { startedAt: relation.startedAt } : {}),
    ...(relation?.stoppedAt !== undefined ? { stoppedAt: relation.stoppedAt } : {}),
    ...(relation?.stoppedStatus ? { stoppedStatus: relation.stoppedStatus } : {}),
  };
}

export function collectCandidates(
  session: SessionInfo,
  messages: readonly MessageWithParts[],
  parentEvents?: readonly SessionEvent[],
): SubagentCandidate[] {
  const candidates = new Map<string, SubagentCandidate>();
  const relations = subagentEventRelations(parentEvents);
  for (const message of activeBranchMessages(session, messages)) {
    for (const part of message.parts) {
      if (part.type !== "tool") continue;
      const candidate = candidateFromToolPart(part, relations.get(part.callID));
      if (candidate) candidates.set(candidate.childSessionId, candidate);
    }
  }
  return [...candidates.values()];
}
