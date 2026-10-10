import { z } from "zod";

export const TASK_SUMMARY_MAX_CHARS = 24;
export const TASK_SUMMARY_SOURCE_MAX_CHARS = 1200;
/** 命名只接受完整短题；Git 后缀、任务正文和手动名称均不使用此自动摘要限制。 */
export const taskSummaryTitleSchema = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      Array.from(value).length <= TASK_SUMMARY_MAX_CHARS &&
      /[\p{L}\p{N}]/u.test(value) &&
      !/[\p{Cc}\p{Cf}]/u.test(value) &&
      !/(?:\.{3}|…)$/u.test(value),
  );
export const taskSummaryResultSchema = z.object({ title: taskSummaryTitleSchema }).strict();
