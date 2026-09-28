import { z } from "zod";

/** 来源和实际消费形态的单一标记；缺失的旧历史不追溯转换。 */
export const RuntimeInputPresentationSchema = z.enum([
  "user_steer",
  "coordinator_steer",
  "coordinator_input",
  "subagent_reply_steer",
  "subagent_reply",
  "task_notification_steer",
  "task_notification",
]);
export type RuntimeInputPresentation = z.infer<typeof RuntimeInputPresentationSchema>;

export function parseRuntimeInputPresentation(
  value: unknown,
): RuntimeInputPresentation | undefined {
  const result = RuntimeInputPresentationSchema.safeParse(value);
  return result.success ? result.data : undefined;
}
