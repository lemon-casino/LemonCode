import { createHash } from "node:crypto";
import { taskSummaryTitleSchema } from "@lcode/shared";
import type { AgentRuntimeConfig } from "./types.js";

export type PreparedSessionTitle = NonNullable<
  NonNullable<AgentRuntimeConfig["titleGeneration"]>["preparedTitle"]
>;
const inputDigest = (input: string) => createHash("sha256").update(input.trim()).digest("hex");

/** 可信 bootstrap 只传名称与 digest；原首发正文不复制进 runtime 配置或日志。 */
export function createPreparedSessionTitle(
  title: string,
  input: string,
): PreparedSessionTitle | undefined {
  const parsed = taskSummaryTitleSchema.safeParse(title);
  return parsed.success ? { title: parsed.data, inputDigest: inputDigest(input) } : undefined;
}

export function resolvePreparedSessionTitle(
  config: AgentRuntimeConfig,
  input: string,
): string | undefined {
  if (
    config.parentSessionId ||
    (config.taskType && config.taskType !== "interactive") ||
    config.titleGeneration?.enabled === false
  )
    return undefined;
  const seed = config.titleGeneration?.preparedTitle;
  if (!seed || seed.inputDigest !== inputDigest(input)) return undefined;
  const parsed = taskSummaryTitleSchema.safeParse(seed.title);
  return parsed.success ? parsed.data : undefined;
}
