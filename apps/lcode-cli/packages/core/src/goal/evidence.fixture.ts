import { resolve } from "node:path";
import {
  goalAcceptanceSchema,
  goalAcceptanceHash,
  SESSION_ENTRY_GOAL_EVIDENCE_HEAD,
  SESSION_ENTRY_GOAL_EVIDENCE_ATTEMPT,
  type BeginGoalEvidenceExecutionInput,
  type FileSystemPort,
  type SessionStorePort,
  type SessionEntryInfo,
  type SessionGoal,
  type SessionId,
} from "@lcode/contracts";
import type { GoalEvidenceOwner } from "./evidence.js";
export function evidenceFixture() {
  const cwd = resolve("evidence-fixture");
  const files = new Map([
    [resolve(cwd, "source.ts"), "original"],
    [resolve(cwd, "out.txt"), "artifact"],
  ]);
  const entries = new Map<string, SessionEntryInfo>();
  let goal: SessionGoal = {
    sessionID: "session" as SessionId,
    targetID: "goal",
    objective: "implement",
    summaryTitle: null,
    status: "active",
    tokenBudget: null,
    tokensUsed: 0,
    timeUsedSeconds: 0,
    time: { created: 1, updated: 1 },
    acceptance: goalAcceptanceSchema.parse({
      policy: "strict",
      requirements: [
        {
          id: "tests",
          description: "tests cover source",
          source: "Bash",
          command: "pnpm test",
          inputPaths: ["source.ts"],
          artifactPaths: ["out.txt"],
        },
      ],
    }),
  };
  let symlink = false;
  const fs = {
    stat: async ({ path }: { path: string }) => ({
      path,
      kind: symlink ? "symlink" : files.has(path) ? "file" : "directory",
      sizeBytes: files.has(path) ? Buffer.byteLength(files.get(path)!) : 0,
      symlinkChecked: true,
    }),
    readBinaryFile: async ({ path, maxBytes }: { path: string; maxBytes: number }) => {
      if (!files.has(path)) throw new Error("missing");
      const content = Buffer.from(files.get(path)!);
      if (content.length > maxBytes) throw new Error("too large");
      return { path, content, bytesRead: content.length, sizeBytes: content.length };
    },
  } as unknown as FileSystemPort;
  const store = {
    readTarget: async () => goal,
    saveSessionEntry: async (entry: SessionEntryInfo) => {
      if (entry.type !== "goal/evidence/v1" || !entries.has(entry.id)) entries.set(entry.id, entry);
    },
    beginGoalEvidenceExecution: async ({ expected, attempt }: BeginGoalEvidenceExecutionInput) => {
      if (goal.targetID !== expected.targetID || goal.status !== "active" || (goal.stateRevision ?? 0) !== expected.stateRevision || !goal.acceptance || goalAcceptanceHash(goal.acceptance) !== expected.acceptanceHash)
        return { kind: "stale" };
      const duplicate = entries.get(attempt.attemptId);
      if (duplicate) return { kind: "duplicate", attempt: duplicate.data };
      const receiptIds = new Set([...entries.values()].filter((entry) => entry.type === "goal/evidence/v1").map((entry) => entry.id));
      for (const entry of entries.values())
        if (entry.type === SESSION_ENTRY_GOAL_EVIDENCE_ATTEMPT)
          for (const head of (entry.data as BeginGoalEvidenceExecutionInput["attempt"]).heads) receiptIds.add(head.receiptId);
      for (const head of attempt.heads) receiptIds.add(head.receiptId);
      if (receiptIds.size > 512) return { kind: "full" };
      entries.set(attempt.attemptId, { id: attempt.attemptId, sessionID: goal.sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE_ATTEMPT, time: { created: attempt.startedAt, updated: attempt.startedAt }, data: attempt });
      for (const head of attempt.heads)
        entries.set(head.headId, { id: head.headId, sessionID: goal.sessionID, type: SESSION_ENTRY_GOAL_EVIDENCE_HEAD, time: { created: head.startedAt, updated: head.startedAt }, data: head });
      return { kind: "admitted", attempt };
    },
    getSession: async () => ({ id: goal.sessionID, directory: cwd, workspaceID: "identity" }),
    sessionEntries: async ({ type, limit }: { type?: string; limit?: number }) => [...entries.values()].filter((entry) => !type || entry.type === type).slice(0, limit),
  } as unknown as SessionStorePort;
  const owner: GoalEvidenceOwner = {
    sessionId: goal.sessionID,
    workspacePath: cwd,
    workspaceKey: "identity",
    fileSystem: fs,
    store,
  };
  return {
    owner,
    entries,
    files,
    goal,
    setGoal: (value: SessionGoal) => {
      goal = value;
    },
    setSymlink: () => {
      symlink = true;
    },
  };
}
