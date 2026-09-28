import { Emitter, type Event } from "@lcode/rpc";

interface CloseEventController {
  event: Event<number>;
  fire(code: number): void;
}

export function createCloseEventController(): CloseEventController {
  const emitter = new Emitter<number>();
  let closed = false;
  let closeCode = 0;

  const event: Event<number> = (listener) => {
    // 远端命令可能在调用方订阅 onClose 之前就瞬间退出。
    // 如果事件只做“在线分发”不做补发，waitForClose 会永远等不到，表现为连接卡住。
    // 这里对晚订阅者补发最后一次 close code，避免竞态丢事件。
    if (closed) {
      queueMicrotask(() => {
        listener(closeCode);
      });
      return { dispose() {} };
    }

    return emitter.event(listener);
  };

  const fire = (code: number) => {
    if (closed) {
      return;
    }
    closed = true;
    closeCode = code;
    emitter.fire(code);
    emitter.dispose();
  };

  return { event, fire };
}
