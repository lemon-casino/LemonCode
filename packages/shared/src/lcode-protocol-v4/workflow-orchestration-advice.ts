import { z } from "zod";

/** Submission-time read model only; never runtime state or a scheduling command. */
export const WORKFLOW_ORCHESTRATION_ADVICE_CODES = [
  "await-before-later-asks",
  "join-before-per-item-work",
] as const;
export const WORKFLOW_ORCHESTRATION_ADVICE_LIMITS = {
  maxItems: 5,
  maxLocations: 8,
  maxMessageChars: 1_024,
} as const;

const locationSchema = z
  .object({
    line: z.number().int().positive(),
    column: z.number().int().positive(),
  })
  .strict();
const locationsSchema = z
  .array(locationSchema)
  .min(1)
  .max(WORKFLOW_ORCHESTRATION_ADVICE_LIMITS.maxLocations);

export const workflowOrchestrationAdviceSchema = locationSchema
  .extend({
    code: z.enum(WORKFLOW_ORCHESTRATION_ADVICE_CODES),
    waitingOn: locationsSchema,
    delayed: locationsSchema,
    message: z.string().min(1).max(WORKFLOW_ORCHESTRATION_ADVICE_LIMITS.maxMessageChars),
  })
  .strict();
export type WorkflowOrchestrationAdvice = z.infer<typeof workflowOrchestrationAdviceSchema>;

export const workflowOrchestrationAdviceBundleSchema = z
  .object({
    scriptHash: z.string().regex(/^fnv1a32:[0-9a-f]{8}$/u),
    items: z
      .array(workflowOrchestrationAdviceSchema)
      .min(1)
      .max(WORKFLOW_ORCHESTRATION_ADVICE_LIMITS.maxItems),
  })
  .strict();
export type WorkflowOrchestrationAdviceBundle = z.infer<
  typeof workflowOrchestrationAdviceBundleSchema
>;

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;
const HEX_WIDTH = 8;

/** Non-cryptographic stale-preview fingerprint, not an authorization or integrity credential. */
export function workflowScriptFingerprint(script: string): string {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < script.length; index += 1) {
    hash ^= script.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return `fnv1a32:${(hash >>> 0).toString(16).padStart(HEX_WIDTH, "0")}`;
}

/** Shared by confirmation consumers: malformed, absent or stale advice is simply not shown. */
export function readWorkflowOrchestrationAdvice(raw: unknown): WorkflowOrchestrationAdvice[] {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return [];
  const input = raw as Record<string, unknown>;
  if (typeof input.script !== "string") return [];
  const parsed = workflowOrchestrationAdviceBundleSchema.safeParse(input.orchestration_advice);
  // Hook/审批编辑可能改变脚本；不能让旧位置提示继续描述另一份将要执行的代码。
  if (!parsed.success || parsed.data.scriptHash !== workflowScriptFingerprint(input.script))
    return [];
  return parsed.data.items;
}
