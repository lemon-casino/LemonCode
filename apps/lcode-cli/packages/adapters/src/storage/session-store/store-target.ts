import type {
  GoalStatus,
  SessionGoal,
  SessionId,
  TodoItem,
  GoalAcceptance,
} from "@lcode/contracts";
import type { SqliteStoreAccess } from "./store-access.js";
import {
  accountSessionTargetUsage,
  clearSessionTarget,
  cloneSessionTargetForFork,
  createSessionTarget,
  finishSessionTargetRun,
  heartbeatSessionTargetRun,
  readSessionTarget,
  recoverInterruptedSessionTargetRun,
  setSessionTarget,
  startSessionTargetRun,
  updateSessionTargetSummaryTitle,
  updateSessionTargetStatus,
} from "../session-target.js";
import * as todoRepository from "./repositories/todos.js";

export const sessionTargetMethods = {
  async readTodos(this: SqliteStoreAccess, input: { sessionID: SessionId }): Promise<TodoItem[]> {
    return todoRepository.readTodos(this.db, input);
  },

  async updateTodos(
    this: SqliteStoreAccess,
    input: { sessionID: SessionId; todos: TodoItem[] },
  ): Promise<void> {
    this.throwBeforeWrite();
    return todoRepository.updateTodos(this.db, input);
  },

  async readTarget(
    this: SqliteStoreAccess,
    input: { sessionID: SessionId },
  ): Promise<SessionGoal | null> {
    return readSessionTarget(this.db, input);
  },

  async setTarget(
    this: SqliteStoreAccess,
    input: {
      objective: string;
      sessionID: SessionId;
      status?: GoalStatus;
      tokenBudget?: number | null;
      acceptance?: GoalAcceptance;
    },
  ): Promise<SessionGoal> {
    return setSessionTarget(this.db, {
      objective: input.objective,
      sessionID: input.sessionID,
      status: input.status ?? "active",
      tokenBudget: input.tokenBudget,
      acceptance: input.acceptance,
    });
  },

  async cloneTargetForFork(
    this: SqliteStoreAccess,
    input: {
      source: SessionGoal;
      sessionID: SessionId;
      status?: GoalStatus;
    },
  ): Promise<SessionGoal> {
    this.throwBeforeWrite();
    return cloneSessionTargetForFork(this.db, {
      source: input.source,
      sessionID: input.sessionID,
      status: input.status ?? input.source.status,
    });
  },

  async createTarget(
    this: SqliteStoreAccess,
    input: {
      objective: string;
      sessionID: SessionId;
      tokenBudget?: number | null;
      acceptance?: GoalAcceptance;
    },
  ): Promise<SessionGoal | null> {
    return createSessionTarget(this.db, input);
  },

  async updateTargetStatus(
    this: SqliteStoreAccess,
    input: {
      sessionID: SessionId;
      status: GoalStatus;
      expected?: {
        targetID: string;
        updatedAt: number;
        stateRevision?: number;
        acceptanceHash?: string;
        evidenceHeads?: import("@lcode/contracts").GoalEvidenceHeadToken[];
      };
    },
  ): Promise<SessionGoal | null> {
    return updateSessionTargetStatus(this.db, input);
  },

  async startTargetRun(
    this: SqliteStoreAccess,
    input: {
      sessionID: SessionId;
      targetID: string;
      inputID: string;
      startedAtMs: number;
    },
  ): Promise<SessionGoal | null> {
    return startSessionTargetRun(this.db, input);
  },

  async heartbeatTargetRun(
    this: SqliteStoreAccess,
    input: {
      sessionID: SessionId;
      targetID: string;
      inputID: string;
      seenAtMs: number;
    },
  ): Promise<SessionGoal | null> {
    return heartbeatSessionTargetRun(this.db, input);
  },

  async finishTargetRun(
    this: SqliteStoreAccess,
    input: {
      sessionID: SessionId;
      targetID: string;
      inputID: string;
      endedAtMs: number;
      status?: GoalStatus;
      tokensUsedDelta?: number;
    },
  ): Promise<SessionGoal | null> {
    return finishSessionTargetRun(this.db, input);
  },

  async recoverInterruptedTargetRun(
    this: SqliteStoreAccess,
    input: { sessionID: SessionId },
  ): Promise<SessionGoal | null> {
    return recoverInterruptedSessionTargetRun(this.db, input);
  },

  async accountTargetUsage(
    this: SqliteStoreAccess,
    input: {
      sessionID: SessionId;
      targetID: string;
      tokensUsedDelta?: number;
      timeUsedSecondsDelta?: number;
    },
  ): Promise<SessionGoal | null> {
    return accountSessionTargetUsage(this.db, input);
  },

  async updateTargetSummaryTitle(
    this: SqliteStoreAccess,
    input: {
      sessionID: SessionId;
      targetID: string;
      summaryTitle: string;
    },
  ): Promise<SessionGoal | null> {
    return updateSessionTargetSummaryTitle(this.db, input);
  },

  async clearTarget(this: SqliteStoreAccess, input: { sessionID: SessionId }): Promise<boolean> {
    return clearSessionTarget(this.db, input);
  },
};
