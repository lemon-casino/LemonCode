import { z } from "zod";
import { toToolJsonSchema } from "./json-schema.js";

export const RESPOND_TO_COORDINATOR_TOOL_NAME = "RespondToCoordinator";
export const RESPOND_TO_COORDINATOR_MAX_CONTENT_CHARS = 20_000;

export const RespondToCoordinatorInputSchema = z
  .object({
    summary: z.string().min(1).max(200).describe("Short summary of the response."),
    message: z
      .string()
      .min(1)
      .max(RESPOND_TO_COORDINATOR_MAX_CONTENT_CHARS)
      .describe("Response or progress update for the coordinator."),
  })
  .strict();

export type RespondToCoordinatorInput = z.infer<typeof RespondToCoordinatorInputSchema>;

export const RespondToCoordinatorInputJsonSchema = toToolJsonSchema(
  RespondToCoordinatorInputSchema,
);

export const RespondToCoordinatorOutputSchema = z
  .object({
    status: z.enum(["success", "failed"]),
    responseId: z.string(),
    message: z.string(),
    error: z.string().optional(),
  })
  .strict();

export type RespondToCoordinatorOutput = z.infer<typeof RespondToCoordinatorOutputSchema>;
