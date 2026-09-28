// TUI 常驻会话事件中继。
//
// 单独成模块是为了让「换 app 时重挂」这条性质可被直接单测：若埋在 tui-prompt-handler
// 的闭包里，只能靠一整套 app 工厂假件才能验，而漏挂的后果很安静——换 session 后 TUI 再也
// 收不到出回合事件（dwf 进度、通知驱动回合），界面看起来完全正常。
import type { SessionEvent } from "@lcode/contracts";

/** 从 runtime 上读出订阅函数；读不到就返回 undefined（能力不在静态类型面上）。 */
type SessionEventSubscriberReader = (
  runtime: unknown,
) => ((sink: { onSessionEvent: (event: SessionEvent) => void }) => () => void) | undefined;

interface TuiSessionEventRelay {
  /** 注册一个 sink；返回退订。首个 sink 会触发实挂。 */
  addSink: (sink: (event: SessionEvent) => void) => () => void;
  /** 换 app 后重挂：先断旧的，再挂到当前 runtime 上。无 sink 时不挂。 */
  reattach: () => void;
  /** 拆掉当前订阅（不清空 sink 注册表）。 */
  detach: () => void;
  /** 当前是否挂着（测试与诊断用）。 */
  isAttached: () => boolean;
}

export function createTuiSessionEventRelay(input: {
  /** 每次重挂时读当前 app 的 runtime——闭包读取而不是传值，才能跟上 replaceApp。 */
  currentRuntime: () => unknown;
  readSubscriber: SessionEventSubscriberReader;
}): TuiSessionEventRelay {
  const sinks = new Set<(event: SessionEvent) => void>();
  let detachCurrent: (() => void) | undefined;

  const detach = (): void => {
    detachCurrent?.();
    detachCurrent = undefined;
  };

  const reattach = (): void => {
    detach();
    if (sinks.size === 0) return;
    const subscribe = input.readSubscriber(input.currentRuntime());
    detachCurrent = subscribe?.({
      onSessionEvent: (event) => {
        // 直接遍历 Set：JS 的 Set 迭代对「遍历中删除」是安全的（已删未访问的条目会被跳过），
        // 所以 sink 在回调里退订不会破坏本次扇出，也不该再收到这一条。
        for (const sink of sinks) sink(event);
      },
    });
  };

  return {
    addSink: (sink) => {
      sinks.add(sink);
      if (sinks.size === 1) reattach();
      return () => {
        sinks.delete(sink);
        if (sinks.size === 0) detach();
      };
    },
    reattach,
    detach,
    isAttached: () => detachCurrent !== undefined,
  };
}
