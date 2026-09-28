// runtime 上「跨回合会话事件订阅」的能力读取。
//
// 单独成模块是因为消费者有两个且不同venue：headless（`prompt-command.ts`）与 TUI
// （`tui-prompt-handler.ts` → `tui-session-event-relay.ts`）。能力读取器需要独立于任何
// venue：若放在 headless 专属模块里，TUI 侧就得从一个名为 headless 的模块 import 一个
// 名为 Headless 的读取器——名字对行为撒谎。它只回答「这个 runtime 能不能跨回合订阅」。
import type { SessionEvent } from "@lcode/contracts";

/**
 * 从 `unknown` 上动态读一个函数成员。
 *
 * 收 `unknown` 并动态探属性，**不是**为了防御真实的 `AgentRuntime`（那上面这些成员都是
 * 必选的），而是因为 `RunDependencies.createLCodeApp` 是公开注入点（cli-types.ts 的注释
 * 写着"tests, embedders"），替身的 runtime 可以是任意形状。对着必选成员写 `?.` 会被 TS
 * 判成恒真条件——所以边界在这里，用一次显式的动态读取表达。
 */
export const readRuntimeFunction = (
  source: unknown,
  key: string,
): ((...args: never[]) => unknown) | undefined => {
  if (!source || typeof source !== "object") return undefined;
  const value = (source as Record<string, unknown>)[key];
  return typeof value === "function" ? (value as (...args: never[]) => unknown) : undefined;
};

type RuntimeEventSubscriber = (sink: {
  onSessionEvent: (event: SessionEvent) => void;
}) => () => void;

/**
 * 读出 runtime 的跨回合事件订阅。
 *
 * **不静默降级**：拿不到订阅就返回 `undefined`，调用方退回 per-turn `onEvent`（单回合可见，
 * 与改动前一致）。这是"这个宿主没有这个能力"的诚实答复，而不是假装订阅上了。
 */
export const readRuntimeEventSubscriber = (
  runtime: unknown,
): RuntimeEventSubscriber | undefined => {
  const subscribe = readRuntimeFunction(runtime, "subscribeEvents");
  if (!subscribe) return undefined;
  return (sink) => {
    const detach = (subscribe as (s: unknown) => unknown).call(runtime, sink);
    return typeof detach === "function" ? (detach as () => void) : () => undefined;
  };
};
