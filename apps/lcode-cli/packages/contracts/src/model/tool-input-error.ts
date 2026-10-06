import { z } from "zod";

/** 参数解析失败只传递安全诊断，不能携带模型正文或 parser 的原始错误消息。 */
export const ModelToolInputErrorSchema = z
  .object({
    code: z.enum(["invalid_json", "null_input"]),
    inputLength: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).optional(),
  })
  .strict();

export type ModelToolInputError = z.infer<typeof ModelToolInputErrorSchema>;
