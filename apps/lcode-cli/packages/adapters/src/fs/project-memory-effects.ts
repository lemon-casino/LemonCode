import { join } from "node:path";
import {
  MEMORY_EFFECT_BYTES_LIMIT,
  MEMORY_EFFECT_FEEDBACK_LIMIT,
  MEMORY_EFFECT_TURN_LIMIT,
  MEMORY_EFFECT_VERIFICATION_LIMIT,
  MemoryEffectFeedbackSchema,
  MemoryEffectTurnSchema,
  MemoryEffectVerificationSchema,
  type MemoryEffectFeedback,
  type MemoryEffectTurn,
  type MemoryEffectVerification,
  type ProjectMemoryChange,
  type ProjectMemoryEffectPort,
  type ProjectMemoryOperationOptions,
} from "@lcode/contracts";
import { hashBuffer, throwIfAborted } from "./file-system-common.js";
import { memoryError, readMemoryBytes, strictAtomicWrite } from "./project-memory-io.js";
import {
  assertMemoryRoot,
  memoryRelativePath,
  samePath,
  type MemoryRoot,
} from "./project-memory-paths.js";
import type { MemoryStore } from "./project-memory-store.js";

interface EffectLedger {
  schemaVersion: 1;
  rootDir: string;
  workspaceKey: string;
  turns: MemoryEffectTurn[];
  feedback: MemoryEffectFeedback[];
  verifications: MemoryEffectVerification[];
}
type WithRoot = <T>(
  rootDir: string,
  run: (state: { store: MemoryStore; changes: ProjectMemoryChange[] }) => Promise<T>,
  options?: ProjectMemoryOperationOptions,
) => Promise<T>;

/** Shares the managed writer lock, but never mutates content or the content journal. */
export class MemoryEffects implements ProjectMemoryEffectPort {
  constructor(private readonly withRoot: WithRoot) {}

  private async load(root: MemoryRoot, workspaceKey: string): Promise<EffectLedger> {
    MemoryEffectFeedbackSchema.shape.workspaceKey.parse(workspaceKey);
    const bytes = await readMemoryBytes(
      join(root.stateDir, "effects.json"),
      MEMORY_EFFECT_BYTES_LIMIT,
      true,
    );
    if (bytes === null)
      return {
        schemaVersion: 1,
        rootDir: root.rootDir,
        workspaceKey,
        turns: [],
        feedback: [],
        verifications: [],
      };
    let parsed: unknown;
    try {
      parsed = JSON.parse(bytes.toString("utf8"));
    } catch {
      throw memoryError("io_error", root.rootDir, "Invalid memory effects JSON");
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      throw memoryError("io_error", root.rootDir, "Invalid memory effects ledger");
    const value = parsed as EffectLedger;
    if (
      Object.keys(value).sort().join(",") !==
        "feedback,rootDir,schemaVersion,turns,verifications,workspaceKey" ||
      value.schemaVersion !== 1 ||
      typeof value.rootDir !== "string" ||
      !samePath(value.rootDir, root.rootDir) ||
      value.workspaceKey !== workspaceKey ||
      !Array.isArray(value.turns) ||
      !Array.isArray(value.feedback) ||
      !Array.isArray(value.verifications) ||
      value.verifications.length > MEMORY_EFFECT_VERIFICATION_LIMIT ||
      value.turns.length > MEMORY_EFFECT_TURN_LIMIT ||
      value.feedback.length > MEMORY_EFFECT_FEEDBACK_LIMIT
    )
      throw memoryError("invalid_path", root.rootDir, "Memory effects owner or schema mismatch");
    const turnKeys = new Set<string>();
    const feedbackKeys = new Set<string>();
    value.turns = value.turns.map((turn) => {
      const validated = MemoryEffectTurnSchema.parse(turn);
      const key = turnKey(validated);
      if (validated.workspaceKey !== workspaceKey || turnKeys.has(key))
        throw memoryError("io_error", root.rootDir, "Duplicate or cross-scope memory observation");
      turnKeys.add(key);
      for (const entry of validated.entries)
        memoryRelativePath(root, join(root.rootDir, entry.fileName));
      return validated;
    });
    value.feedback = value.feedback.map((feedback) => {
      const validated = MemoryEffectFeedbackSchema.parse(feedback);
      if (
        validated.workspaceKey !== workspaceKey ||
        feedbackKeys.has(validated.commandId) ||
        !hasObservedEntry(value, validated)
      )
        throw memoryError("io_error", root.rootDir, "Unbound or duplicate memory feedback");
      feedbackKeys.add(validated.commandId);
      return validated;
    });
    const verificationKeys = new Set<string>();
    value.verifications = value.verifications.map((item) => {
      const verified = MemoryEffectVerificationSchema.parse(item);
      if (
        verified.workspaceKey !== workspaceKey ||
        verificationKeys.has(verified.evidenceId) ||
        !value.turns.some((turn) => turnKey(turn) === turnKey(verified))
      )
        throw memoryError("io_error", root.rootDir, "Unbound or duplicate memory verification");
      verificationKeys.add(verified.evidenceId);
      return verified;
    });
    return value;
  }

  private async save(
    root: MemoryRoot,
    ledger: EffectLedger,
    options?: ProjectMemoryOperationOptions,
  ): Promise<boolean> {
    const bytes = Buffer.from(JSON.stringify(ledger));
    if (bytes.length > MEMORY_EFFECT_BYTES_LIMIT) return false;
    await strictAtomicWrite(join(root.stateDir, "effects.json"), bytes, {
      mode: 0o600,
      signal: options?.signal,
      validate: () => assertMemoryRoot(root),
    });
    return true;
  }

  recordTurn(
    input: Parameters<ProjectMemoryEffectPort["recordTurn"]>[0],
    options?: ProjectMemoryOperationOptions,
  ): ReturnType<ProjectMemoryEffectPort["recordTurn"]> {
    return this.withRoot(
      input.rootDir,
      async ({ store }) => {
        const turn = MemoryEffectTurnSchema.parse(input.turn);
        const ledger = await this.load(store.root, turn.workspaceKey);
        for (const entry of turn.entries)
          memoryRelativePath(store.root, join(store.root.rootDir, entry.fileName));
        const prior = ledger.turns.find((record) => turnKey(record) === turnKey(turn));
        if (prior) {
          // 冷恢复重试保留首次时间；同轮不同事实不能悄悄覆盖已观察的 revision。
          if (stableTurn(prior) !== stableTurn(turn))
            throw memoryError(
              "stale_write",
              input.rootDir,
              "Memory observation changed after settlement",
            );
          return "duplicate";
        }
        throwIfAborted(options?.signal);
        if (ledger.turns.length >= MEMORY_EFFECT_TURN_LIMIT) return "full";
        ledger.turns.push(turn);
        return (await this.save(store.root, ledger, options)) ? "recorded" : "full";
      },
      options,
    );
  }

  read(
    input: Parameters<ProjectMemoryEffectPort["read"]>[0],
    options?: ProjectMemoryOperationOptions,
  ): ReturnType<ProjectMemoryEffectPort["read"]> {
    return this.withRoot(
      input.rootDir,
      async ({ store }) => {
        const ledger = await this.load(store.root, input.workspaceKey);
        const limit = Math.max(1, Math.min(20, Math.floor(input.limit ?? 20)));
        const bytes = Buffer.byteLength(JSON.stringify(ledger));
        return {
          turnCount: ledger.turns.length,
          injectedEntries: ledger.turns.reduce((count, turn) => count + turn.entries.length, 0),
          versionedEntries: ledger.turns.reduce(
            (count, turn) =>
              count + turn.entries.filter((entry) => entry.sourceHash !== null).length,
            0,
          ),
          feedbackCount: ledger.feedback.length,
          verificationCount: ledger.verifications.length,
          bytes,
          full:
            ledger.turns.length >= MEMORY_EFFECT_TURN_LIMIT ||
            ledger.feedback.length >= MEMORY_EFFECT_FEEDBACK_LIMIT ||
            ledger.verifications.length >= MEMORY_EFFECT_VERIFICATION_LIMIT ||
            bytes >= MEMORY_EFFECT_BYTES_LIMIT,
          turns: ledger.turns.slice(-limit).map((turn) => {
            const verdict = ledger.verifications
              .filter((item) => turnKey(item) === turnKey(turn))
              .at(-1);
            return verdict
              ? {
                  ...turn,
                  verification: verdict.verification,
                  verificationEvidenceId: verdict.evidenceId,
                  verificationBasis: verdict.basis,
                }
              : turn;
          }),
          feedback: ledger.feedback.slice(-limit),
          verifications: ledger.verifications.slice(-limit),
        };
      },
      options,
    );
  }

  recordFeedback(
    input: Parameters<ProjectMemoryEffectPort["recordFeedback"]>[0],
    options?: ProjectMemoryOperationOptions,
  ): ReturnType<ProjectMemoryEffectPort["recordFeedback"]> {
    return this.withRoot(
      input.rootDir,
      async ({ store }) => {
        const feedback = MemoryEffectFeedbackSchema.parse(input.feedback);
        const ledger = await this.load(store.root, feedback.workspaceKey);
        const prior = ledger.feedback.find((record) => record.commandId === feedback.commandId);
        if (prior) {
          if (stableFeedback(prior) !== stableFeedback(feedback))
            throw memoryError("stale_write", input.rootDir, "Memory feedback command changed");
          return "duplicate";
        }
        if (!hasObservedEntry(ledger, feedback))
          throw memoryError(
            "invalid_path",
            input.rootDir,
            "Feedback must identify a fully versioned injected memory",
          );
        throwIfAborted(options?.signal);
        if (ledger.feedback.length >= MEMORY_EFFECT_FEEDBACK_LIMIT) return "full";
        ledger.feedback.push(feedback);
        return (await this.save(store.root, ledger, options)) ? "recorded" : "full";
      },
      options,
    );
  }

  recordVerification(
    input: Parameters<ProjectMemoryEffectPort["recordVerification"]>[0],
    options?: ProjectMemoryOperationOptions,
  ): ReturnType<ProjectMemoryEffectPort["recordVerification"]> {
    return this.withRoot(
      input.rootDir,
      async ({ store }) => {
        const verification = MemoryEffectVerificationSchema.parse(input.verification);
        const ledger = await this.load(store.root, verification.workspaceKey);
        const prior = ledger.verifications.find(
          (record) => record.evidenceId === verification.evidenceId,
        );
        if (prior) {
          const { recordedAt: _priorTime, ...previous } = prior;
          const { recordedAt: _nextTime, ...next } = verification;
          if (JSON.stringify(previous) !== JSON.stringify(next))
            throw memoryError("stale_write", input.rootDir, "Memory verification event changed");
          return "duplicate";
        }
        if (!ledger.turns.some((turn) => turnKey(turn) === turnKey(verification)))
          return "unobserved";
        if (ledger.verifications.length >= MEMORY_EFFECT_VERIFICATION_LIMIT) return "full";
        ledger.verifications.push(verification);
        return (await this.save(store.root, ledger, options)) ? "recorded" : "full";
      },
      options,
    );
  }

  rankingSignals(
    input: Parameters<ProjectMemoryEffectPort["rankingSignals"]>[0],
    options?: ProjectMemoryOperationOptions,
  ): ReturnType<ProjectMemoryEffectPort["rankingSignals"]> {
    if (input.entries.length > 200)
      return Promise.reject(
        memoryError(
          "too_large",
          input.rootDir,
          "Memory ranking request exceeds the candidate budget",
        ),
      );
    return this.withRoot(
      input.rootDir,
      async ({ store, changes }) => {
        const ledger = await this.load(store.root, input.workspaceKey);
        const reviews = new Map<string, Awaited<ReturnType<MemoryStore["readReview"]>>>();
        const signals = [];
        for (const entry of input.entries) {
          throwIfAborted(options?.signal);
          memoryRelativePath(store.root, join(store.root.rootDir, entry.fileName));
          MemoryEffectFeedbackSchema.shape.sourceHash.parse(entry.sourceHash);
          const latest = changes.find(
            (change) => change.fileName === entry.fileName && change.status === "committed",
          );
          let eligible = false;
          if (
            latest?.afterHash === entry.sourceHash &&
            latest.proposalId &&
            latest.proposalItemId &&
            !latest.undoOf
          ) {
            let review = reviews.get(latest.proposalId);
            if (!review) {
              review = await store.readReview(latest.proposalId);
              reviews.set(latest.proposalId, review);
            }
            const item = review.draft.items.find(
              (candidate) => candidate.id === latest.proposalItemId,
            );
            eligible = Boolean(
              item &&
              hashBuffer(Buffer.from(item.content)) === entry.sourceHash &&
              review.verification?.acceptedItemIds.includes(item.id) &&
              review.verification.rankingEligibleItemIds?.includes(item.id),
            );
          }
          const feedback = ledger.feedback.filter(
            (record) =>
              record.fileName === entry.fileName && record.sourceHash === entry.sourceHash,
          );
          signals.push({
            ...entry,
            eligible,
            relevant: feedback.filter((record) => record.feedback === "relevant").length,
            negative: feedback.filter((record) => record.feedback !== "relevant").length,
          });
        }
        return signals;
      },
      options,
    );
  }
}

function turnKey(turn: Pick<MemoryEffectTurn, "sessionId" | "turnId">): string {
  return JSON.stringify([turn.sessionId, turn.turnId]);
}
function stableTurn({ observedAt: _time, ...turn }: MemoryEffectTurn): string {
  return JSON.stringify(turn);
}
function stableFeedback({ recordedAt: _time, ...feedback }: MemoryEffectFeedback): string {
  return JSON.stringify(feedback);
}
function hasObservedEntry(ledger: EffectLedger, feedback: MemoryEffectFeedback): boolean {
  return ledger.turns.some(
    (turn) =>
      turn.sessionId === feedback.sessionId &&
      turn.turnId === feedback.turnId &&
      turn.entries.some(
        (entry) => entry.fileName === feedback.fileName && entry.sourceHash === feedback.sourceHash,
      ),
  );
}
