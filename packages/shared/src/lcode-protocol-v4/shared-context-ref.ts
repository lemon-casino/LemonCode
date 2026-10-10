import { z } from "zod";

export const sharedContextRefSchema = z
  .object({
    kind: z.literal("shared_context_import"),
    context_id: z.string().trim().min(1),
  })
  .strict();

export type SharedContextRef = z.infer<typeof sharedContextRefSchema>;

export const contextCapsuleRefSchema = z
  .object({
    kind: z.literal("context_capsule"),
    capsule_id: z.string().regex(/^capsule_[a-f0-9]{32}$/),
  })
  .strict();
export type ContextCapsuleRef = z.infer<typeof contextCapsuleRefSchema>;
export const conversationContextRefsSchema = z
  .array(z.discriminatedUnion("kind", [sharedContextRefSchema, contextCapsuleRefSchema]))
  .max(5)
  .superRefine((refs, context) => {
    if (
      refs.filter((ref) => ref.kind === "shared_context_import").length > 1 ||
      refs.filter((ref) => ref.kind === "context_capsule").length > 4
    )
      context.addIssue({
        code: "custom",
        message: "At most one share and four capsules may be attached.",
      });
    if (
      new Set(refs.map((ref) => (ref.kind === "context_capsule" ? ref.capsule_id : ref.context_id)))
        .size !== refs.length
    )
      context.addIssue({ code: "custom", message: "Context references must be unique." });
  });
