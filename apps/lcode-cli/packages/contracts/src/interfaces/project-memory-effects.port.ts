import { z } from "zod";
import type { ProjectMemoryOperationOptions } from "./project-memory.port.js";

export const MEMORY_EFFECT_TURN_LIMIT = 500;
export const MEMORY_EFFECT_FEEDBACK_LIMIT = 500;
export const MEMORY_EFFECT_VERIFICATION_LIMIT = 500;
export const MEMORY_EFFECT_BYTES_LIMIT = 4 * 1024 * 1024;
const hash = z.string().regex(/^sha256:[a-f0-9]{64}$/u);
const identifier = z
  .string()
  .min(1)
  .max(256)
  .refine((value) =>
    [...value].every(
      (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
    ),
  );
const fileName = z
  .string()
  .min(1)
  .max(240)
  .refine(
    (value) =>
      value.endsWith(".md") &&
      !value.includes("\\") &&
      !value.includes(":") &&
      [...value].every(
        (character) => character.charCodeAt(0) >= 32 && character.charCodeAt(0) !== 127,
      ) &&
      value.split("/").every((part) => part.length > 0 && part !== "." && part !== ".."),
  );
export const MemoryEffectEntrySchema = z
  .object({
    fileName,
    sourceHash: hash.nullable(),
    injectedCharacters: z.number().int().min(0).max(4000),
    matchedTermCount: z.number().int().min(0).max(4000),
    metadataMatchCount: z.number().int().min(0).max(4000),
  })
  .strict();
export const MemoryEffectTurnSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceKey: hash,
    sessionId: identifier,
    turnId: identifier,
    sourceMessageId: identifier.optional(),
    observedAt: z.number().int().nonnegative(),
    status: z.enum(["completed", "error", "cancelled"]),
    verification: z.enum(["passed", "failed", "unknown"]),
    verificationEvidenceId: identifier.optional(),
    verificationBasis: z.enum(["model", "strict-evidence"]).optional(),
    entries: z.array(MemoryEffectEntrySchema).min(1).max(4),
  })
  .strict()
  .superRefine((turn, context) => {
    if (new Set(turn.entries.map((entry) => entry.fileName)).size !== turn.entries.length)
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Memory injection contains duplicate files",
      });
  });
export const MemoryEffectFeedbackSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceKey: hash,
    commandId: identifier,
    sessionId: identifier,
    turnId: identifier,
    fileName,
    sourceHash: hash,
    feedback: z.enum(["relevant", "irrelevant", "correction"]),
    recordedAt: z.number().int().nonnegative(),
  })
  .strict();
export type MemoryEffectTurn = z.infer<typeof MemoryEffectTurnSchema>;
export type MemoryEffectFeedback = z.infer<typeof MemoryEffectFeedbackSchema>;
export const MemoryEffectVerificationSchema = z
  .object({
    schemaVersion: z.literal(1),
    workspaceKey: hash,
    sessionId: identifier,
    turnId: identifier,
    evidenceId: identifier,
    recordedAt: z.number().int().nonnegative(),
    verification: z.enum(["passed", "failed", "unknown"]),
    basis: z.enum(["model", "strict-evidence"]),
  })
  .strict();
export type MemoryEffectVerification = z.infer<typeof MemoryEffectVerificationSchema>;
export interface MemoryEffectSnapshot {
  turnCount: number;
  injectedEntries: number;
  versionedEntries: number;
  feedbackCount: number;
  verificationCount: number;
  bytes: number;
  full: boolean;
  turns: MemoryEffectTurn[];
  feedback: MemoryEffectFeedback[];
  verifications: MemoryEffectVerification[];
}
export interface MemoryRankingSignal {
  fileName: string;
  sourceHash: string;
  eligible: boolean;
  relevant: number;
  negative: number;
}
/** Runtime supplies scope; adapters cannot infer feedback or success from text. */
export interface ProjectMemoryEffectPort {
  recordTurn(
    input: { rootDir: string; turn: MemoryEffectTurn },
    options?: ProjectMemoryOperationOptions,
  ): Promise<"recorded" | "duplicate" | "full">;
  read(
    input: { rootDir: string; workspaceKey: string; limit?: number },
    options?: ProjectMemoryOperationOptions,
  ): Promise<MemoryEffectSnapshot>;
  recordFeedback(
    input: { rootDir: string; feedback: MemoryEffectFeedback },
    options?: ProjectMemoryOperationOptions,
  ): Promise<"recorded" | "duplicate" | "full">;
  recordVerification(
    input: { rootDir: string; verification: MemoryEffectVerification },
    options?: ProjectMemoryOperationOptions,
  ): Promise<"recorded" | "duplicate" | "full" | "unobserved">;
  rankingSignals(
    input: {
      rootDir: string;
      workspaceKey: string;
      entries: readonly { fileName: string; sourceHash: string }[];
    },
    options?: ProjectMemoryOperationOptions,
  ): Promise<MemoryRankingSignal[]>;
}
