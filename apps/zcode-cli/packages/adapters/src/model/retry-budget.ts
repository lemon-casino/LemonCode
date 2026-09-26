import { ModelRetryBudget } from "@zcode/contracts";

/**
 * 重试预算档位的判定。
 *
 * 「无上限」**只**放宽瞬态失败的放弃条件：runner 的 attempt 循环、失败后「还能不能再试」两处闸门；
 * 退避曲线（2s→60s、jitter、Retry-After 优先）、`isRetryableFailure` 的分类、
 * `emittedRetryBoundaryEvent` 之后不重试、空补全重试与 compact 路径一律不动。
 */

/** 状态事件里 `maxAttempts` 表示「无上限」的哨兵（Infinity 不可序列化，0 不占用合法计数）。 */
export const UNBOUNDED_RETRY_MAX_ATTEMPTS = 0;

/** Runtime-only continuation comes from an error context; invalid values must not expand retry budget. */
export function normalizeRetryAttemptOffset(value: number | undefined): number {
  return Number.isSafeInteger(value) && (value ?? -1) >= 0 ? value! : 0;
}

export function isUnboundedRetryBudget(budget: ModelRetryBudget | undefined): boolean {
  return budget === ModelRetryBudget.Unbounded;
}

/** 失败之后还允许再试一次吗（等价于既有的 `retryBudgetAttempt < maxAttempts`，unbounded 恒真）。 */
export function retryBudgetAllows(
  budget: ModelRetryBudget | undefined,
  retryBudgetAttempt: number,
  maxAttempts: number,
): boolean {
  return isUnboundedRetryBudget(budget) || retryBudgetAttempt < maxAttempts;
}

/** attempt 循环的继续条件（等价于既有的 `attempt <= loopMaxAttempts`，unbounded 恒真）。 */
export function retryAttemptLoopContinues(
  budget: ModelRetryBudget | undefined,
  attempt: number,
  loopMaxAttempts: number,
): boolean {
  return isUnboundedRetryBudget(budget) || attempt <= loopMaxAttempts;
}

/** 写进状态事件 / 日志的 maxAttempts：unbounded 下是哨兵 0。 */
export function retryBudgetMaxAttempts(
  budget: ModelRetryBudget | undefined,
  maxAttempts: number,
): number {
  return isUnboundedRetryBudget(budget) ? UNBOUNDED_RETRY_MAX_ATTEMPTS : maxAttempts;
}
