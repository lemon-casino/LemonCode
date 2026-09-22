import { z } from "zod";

// contracts 仍使用 Zod 3，而 shared 已是 Zod 4；在包边界升级前保留本地 wire schema，
// 避免把两套不兼容的 Zod 实例混进同一个 object schema。
const workflowModelSelectionSchema = z
  .object({
    providerId: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
    options: z
      .object({
        reasoningLevel: z.string().trim().min(1).optional(),
        speed: z.string().trim().min(1).optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

/** Runtime-only approval payload. It is deliberately absent from the model-facing tool schema. */
export const WorkflowActorModelOverrideSchema = z
  .object({
    siteId: z.string().trim().min(1).optional(),
    name: z.string().trim().min(1).optional(),
    ordinal: z.number().int().positive().optional(),
    selection: workflowModelSelectionSchema,
  })
  .strict()
  .refine((value) => value.siteId !== undefined || value.name !== undefined, {
    message: "An actor model override must identify an actor site or name",
  });

export const WorkflowActorModelOverridesSchema = z
  .array(WorkflowActorModelOverrideSchema)
  .max(128);

export type WorkflowActorModelOverrideInput = z.infer<typeof WorkflowActorModelOverrideSchema>;
