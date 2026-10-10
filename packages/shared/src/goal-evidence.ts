import { z } from "zod";

const relativeFile = z
  .string()
  .trim()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      !/^(?:[a-z]:|[\\/])/iu.test(path) &&
      !path.split(/[\\/]/u).some((part) => part === ".." || part === ".git"),
    "Acceptance files must stay inside the workspace and outside .git",
  );
export const goalRequirementSchema = z
  .object({
    id: z.string().trim().min(1).max(128),
    description: z.string().trim().min(1).max(2000),
    source: z.enum(["Bash", "world.run"]),
    command: z.string().trim().min(1).max(8192),
    args: z.array(z.string().max(8192)).max(128).optional(),
    inputPaths: z.array(relativeFile).min(1).max(64),
    artifactPaths: z.array(relativeFile).max(64).default([]),
  })
  .strict()
  .superRefine((value, context) => {
    if (value.source === "Bash" && value.args !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["args"],
        message: "Bash uses its exact shell command, not argv",
      });
    }
  });
export const goalAcceptanceSchema = z
  .object({
    policy: z.literal("strict"),
    requirements: z.array(goalRequirementSchema).min(1).max(16),
  })
  .strict()
  .superRefine((value, context) => {
    if (new Set(value.requirements.map((item) => item.id)).size !== value.requirements.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["requirements"],
        message: "Requirement ids must be unique",
      });
    }
  });
export type GoalAcceptance = z.infer<typeof goalAcceptanceSchema>;
export type GoalRequirement = z.infer<typeof goalRequirementSchema>;
export const goalEvidenceStatusSchema = z.enum([
  "passed",
  "failed",
  "not-run",
  "cancelled",
  "stale",
  "unknown",
]);
export const goalEvidenceSummarySchema = z
  .object({
    policy: z.enum(["legacy", "strict"]),
    contractHash: z.string().regex(/^[a-f0-9]{64}$/u),
    outcome: z.enum(["pass", "notSatisfied", "incomplete"]),
    requirements: z
      .array(
        z
          .object({
            requirementId: z.string().min(1).max(128),
            status: goalEvidenceStatusSchema,
            evidenceId: z.string().min(1).max(512).optional(),
          })
          .strict(),
      )
      .max(16),
  })
  .strict();
export type GoalEvidenceSummary = z.infer<typeof goalEvidenceSummarySchema>;
export const goalEvidenceSchema = z
  .object({
    schemaVersion: z.literal(1),
    evidenceId: z.string().min(1).max(512),
    sessionId: z.string().min(1),
    goalId: z.string().min(1),
    requirementId: z.string().min(1).max(128),
    contractHash: z.string().regex(/^[a-f0-9]{64}$/u),
    workspaceKey: z.string().min(1),
    bindingHash: z.string().regex(/^[a-f0-9]{64}$/u),
    workspacePath: z.string().min(1),
    executionId: z.string().min(1),
    source: z.enum(["Bash", "world.run"]),
    status: goalEvidenceStatusSchema,
    reasonCode: z.string().min(1).max(128),
    inputDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    artifactDigest: z
      .string()
      .regex(/^[a-f0-9]{64}$/u)
      .nullable(),
    exitCode: z.number().int().nullable(),
    startedAt: z.number().int().nonnegative(),
    completedAt: z.number().int().nonnegative(),
    output: z
      .object({
        sha256: z.string().regex(/^[a-f0-9]{64}$/u),
        bytes: z.number().int().nonnegative(),
        truncated: z.boolean(),
        artifactRefs: z.array(z.string().max(2048)).max(4),
      })
      .strict(),
  })
  .strict();
export type GoalEvidence = z.infer<typeof goalEvidenceSchema>;
