import type { LCodeApp } from "../app/types.js";

const modelConfigMutationTails = new WeakMap<LCodeApp, Promise<void>>();

/**
 * 同一个 session App 的模型配置只有一个串行化临界区。
 *
 * provider registry fallback 与用户 `switchModelConfig` 过去分别直接调用
 * `setModel`，两条异步链可能交错成“后开始的目录兜底覆盖用户选择”，事件顺序也会与
 * runtime 最终值不一致。这里按 App 身份串行化所有模型/thought 变更；失败只结束本次
 * operation，不污染后续 tail。WeakMap 不延长 session 生命周期。
 */
export async function runSessionModelConfigMutation<T>(
  app: LCodeApp,
  operation: () => Promise<T>,
): Promise<T> {
  const previousTail = modelConfigMutationTails.get(app) ?? Promise.resolve();
  const currentOperation = previousTail.catch(() => undefined).then(operation);
  const currentTail = currentOperation.then(
    () => undefined,
    () => undefined,
  );
  modelConfigMutationTails.set(app, currentTail);
  try {
    return await currentOperation;
  } finally {
    if (modelConfigMutationTails.get(app) === currentTail) {
      modelConfigMutationTails.delete(app);
    }
  }
}
