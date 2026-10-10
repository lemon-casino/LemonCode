import { createHash } from "node:crypto";
import {
  ContextCapsuleSchema,
  contextCapsuleSourcePayload,
  CoreErrorType,
  createCoreError,
  type ContextCapsule,
  type ReadSessionContextInput,
  type ReadSessionContextOutput,
  type SessionInfo,
  type SessionId,
} from "@lcode/contracts";
import type { ToolExecutionContext } from "../tool/types.js";
import {
  loadScopedSessionContextSnapshot,
  scopedContextSnapshotStillCurrent,
  type ScopedSessionContextSnapshot,
} from "./read-session-context-snapshot.js";
import { canReadSessionContextFromWorkspace } from "./workspace-session-scope.js";

const hash = (content: string) => createHash("sha256").update(content).digest("hex");
export function contextCapsuleScope(session: SessionInfo): ContextCapsule["sourceScope"] {
  return {
    workspaceIdentity: session.workspaceID?.trim() || undefined,
    directory: session.directory,
    path: session.path,
  };
}
export function unavailableContextOutput(
  parsed: Pick<ReadSessionContextInput, "sessionId" | "query" | "strategy">,
  reason: string,
): ReadSessionContextOutput {
  return {
    status: "failed",
    sessionId: parsed.sessionId,
    query: parsed.query,
    strategy: parsed.strategy,
    source: "none",
    content: reason,
    error: reason,
    messageCount: 0,
    selectedMessageCount: 0,
    truncated: false,
  };
}
function assertNotCancelled(context: ToolExecutionContext): void {
  if (context.abortSignal.aborted)
    throw createCoreError(
      CoreErrorType.ToolCancelled,
      "Session context was cancelled before it could be returned.",
      { recoverable: true },
    );
}

export async function finishScopedSessionContext(input: {
  context: ToolExecutionContext;
  parsed: ReadSessionContextInput;
  snapshot: ScopedSessionContextSnapshot;
  output: ReadSessionContextOutput;
}): Promise<ReadSessionContextOutput> {
  const { context, parsed, snapshot, output } = input;
  if (parsed.strategy !== "handoff") return output;
  assertNotCancelled(context);
  if (
    !(await scopedContextSnapshotStillCurrent({
      snapshot,
      sessionStore: context.sessionStore!,
      workspace: context,
    }))
  )
    return unavailableContextOutput(
      parsed,
      "Source session context changed during handoff; generate a new summary.",
    );
  assertNotCancelled(context);
  const versionedOutput = {
    ...output,
    sourceVersion: snapshot.sourceVersion,
    sourceBoundaryMessageId: snapshot.boundaryMessageId,
  };
  if (!parsed.persistCapsule) return versionedOutput;
  if (
    !context.sessionStore?.commitContextCapsule ||
    !context.turnId ||
    !snapshot.sourceVersion ||
    !snapshot.boundaryMessageId
  )
    return unavailableContextOutput(
      parsed,
      "A capsule requires a stable source and an accepted real-user target turn with transactional storage.",
    );
  const target = await context.sessionStore.getSession(context.sessionId);
  if (!target || !canReadSessionContextFromWorkspace(target, context))
    return unavailableContextOutput(parsed, "Target session context is unavailable.");
  const targetMessages = await context.sessionStore.messages({ sessionID: context.sessionId });
  const user = targetMessages.findLast(
    (message) =>
      message.info.role === "user" &&
      message.info.anchor?.origin === "realUser" &&
      message.info.anchor.turnId === context.turnId,
  );
  if (!user)
    return unavailableContextOutput(parsed, "No accepted real-user input can own this capsule.");
  const candidate = ContextCapsuleSchema.safeParse({
    schemaVersion: 1,
    id: `capsule_${hash(`${context.sessionId}\n${context.toolCallId}`).slice(0, 32)}`,
    sourceSessionId: snapshot.session.id,
    sourceScope: contextCapsuleScope(snapshot.session),
    sourceBoundaryMessageId: snapshot.boundaryMessageId,
    sourceMessageIds: snapshot.messages.map((message) => String(message.info.id)),
    sourceVersion: snapshot.sourceVersion,
    content: output.content,
    contentSha256: hash(output.content),
    strategy: "handoff",
    generatorVersion: "handoff-v1",
    truncated: output.truncated,
    createdAtMs: Date.now(),
    targetSessionId: context.sessionId,
    targetScope: contextCapsuleScope(target),
    targetMessageId: user.info.id,
    targetTurnId: context.turnId,
    operationId: context.toolCallId,
    references: output.references ?? [],
  });
  if (!candidate.success)
    return unavailableContextOutput(
      parsed,
      "The capsule exceeds its bounded content or source-reference limit.",
    );
  assertNotCancelled(context);
  const committed = await context.sessionStore.commitContextCapsule(candidate.data, {
    signal: context.abortSignal,
  });
  assertNotCancelled(context);
  if (committed.status !== "committed" && committed.status !== "reused")
    return unavailableContextOutput(parsed, `Context capsule was not saved (${committed.status}).`);
  return { ...versionedOutput, capsuleId: committed.capsule.id };
}

export async function readUsableContextCapsule(input: {
  context: Pick<
    ToolExecutionContext,
    "sessionId" | "sessionStore" | "workspaceIdentity" | "workspaceRoot" | "abortSignal"
  >;
  capsuleId: string;
}): Promise<ContextCapsule | undefined> {
  const { context } = input;
  if (!context.sessionStore?.readContextCapsule) return undefined;
  const capsule = await context.sessionStore.readContextCapsule({
    sessionId: context.sessionId,
    capsuleId: input.capsuleId,
  });
  if (
    !capsule ||
    capsule.targetSessionId !== context.sessionId ||
    hash(capsule.content) !== capsule.contentSha256
  )
    return undefined;
  const target = await context.sessionStore.getSession(context.sessionId);
  if (
    !target ||
    !canReadSessionContextFromWorkspace(target, context) ||
    JSON.stringify(contextCapsuleScope(target)) !== JSON.stringify(capsule.targetScope)
  )
    return undefined;
  const snapshot = await loadScopedSessionContextSnapshot({
    sessionId: capsule.sourceSessionId as SessionId,
    sessionStore: context.sessionStore,
    workspace: context,
    stableCompleted: true,
  });
  if (!snapshot || context.abortSignal.aborted) return undefined;
  const prefix = snapshot.messages.slice(0, capsule.sourceMessageIds.length);
  if (
    prefix.at(-1)?.info.id !== capsule.sourceBoundaryMessageId ||
    hash(contextCapsuleSourcePayload(snapshot.session, prefix)) !== capsule.sourceVersion
  )
    return undefined;
  return capsule;
}

export async function validateContextCapsuleReferences(
  context: Pick<
    ToolExecutionContext,
    "sessionId" | "sessionStore" | "workspaceIdentity" | "workspaceRoot" | "abortSignal"
  >,
  references: readonly { kind: "context_capsule"; capsule_id: string }[],
): Promise<boolean> {
  if (
    references.length > 4 ||
    new Set(references.map((reference) => reference.capsule_id)).size !== references.length
  )
    return false;
  for (const reference of references)
    if (
      reference.kind !== "context_capsule" ||
      !/^capsule_[a-f0-9]{32}$/u.test(reference.capsule_id) ||
      !(await readUsableContextCapsule({ context, capsuleId: reference.capsule_id }))
    )
      return false;
  return !context.abortSignal.aborted;
}

export async function readCapsuleToolOutput(
  context: ToolExecutionContext,
  parsed: ReadSessionContextInput,
): Promise<ReadSessionContextOutput> {
  const capsule = await readUsableContextCapsule({ context, capsuleId: parsed.capsuleId! });
  assertNotCancelled(context);
  if (!capsule || capsule.sourceSessionId !== parsed.sessionId)
    return unavailableContextOutput(
      parsed,
      "The capsule is unavailable, belongs to another target, or its source has changed.",
    );
  return {
    status: "success",
    sessionId: capsule.sourceSessionId,
    strategy: "handoff",
    query: parsed.query,
    source: "capsule",
    content: capsule.content,
    messageCount: capsule.sourceMessageIds.length,
    selectedMessageCount: capsule.references.length,
    references: capsule.references,
    truncated: capsule.truncated,
    sourceVersion: capsule.sourceVersion,
    sourceBoundaryMessageId: capsule.sourceBoundaryMessageId,
    capsuleId: capsule.id,
  };
}
