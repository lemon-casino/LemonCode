import { z } from "zod";

export const resolveWorktreeConflictsPayloadSchema = z
  .object({
    operationId: z.string().trim().min(1),
    waitForRequestId: z.string().trim().min(1).optional(),
  })
  .strict();
