import { z } from "zod";
import { modelSelectionSchema } from "../model-selection.js";

/** 请求覆盖字段保留缺省，不能复用会将 mode 默认成 build 的快照 schema。 */
export const createSessionRequestedConfigSchema = z.object({
  modelSelection: modelSelectionSchema.optional(),
  provider: z.string().optional(),
  model: z.string().optional(),
  thought: z.string().optional(),
  followupMode: z.enum(["queue", "guide"]).optional(),
  mode: z.string().optional(),
  planEnabled: z.boolean().optional(),
});
