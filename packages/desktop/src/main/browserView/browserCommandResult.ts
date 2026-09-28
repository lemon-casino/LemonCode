import type { BrowserCommandResult } from "@lcode/shared";

export type BrowserCommandDone = (
  partial: Omit<BrowserCommandResult, "elapsedMs">,
) => BrowserCommandResult;

/** 构造 ref 未找到的结构化错误（提示先 snapshot）。 */
export function refNotFound(ref: string): Omit<BrowserCommandResult, "elapsedMs"> {
  return {
    ok: false,
    error: {
      code: "ref_not_found",
      message: `ref ${ref} not found (take a fresh snapshot() first)`,
    },
  };
}

/** 构造 execution_error 结构化结果的便捷函数。 */
export function executionError(message: string): Omit<BrowserCommandResult, "elapsedMs"> {
  return { ok: false, error: { code: "execution_error", message } };
}
