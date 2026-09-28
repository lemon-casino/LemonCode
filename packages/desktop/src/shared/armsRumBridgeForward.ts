import type { IpcRenderer } from "electron";

/** 与 @arms/rum-electron 内置 preload 一致 */
const ARMS_RUM_BRIDGE_CHANNEL = "arms:rum-bridge";

type PatchedIpcRenderer = IpcRenderer & { __lcodeArmsIpcPatched?: boolean };

/**
 * SDK browser-reporter 发送 JSON.stringify(events[])，主进程 IPC 拒绝 Array。
 * 在 preload 顶层拦截 ipcRenderer.send，不依赖 ArmsEventBridge 创建时机（autoInject 可能晚于 scheduleArmsBridgePatch）。
 */
function expandArmsRumBridgePayloads(payload: string): string[] {
  try {
    const parsed: unknown = JSON.parse(payload);
    if (Array.isArray(parsed)) {
      const expanded: string[] = [];
      for (const item of parsed) {
        if (item && typeof item === "object" && !Array.isArray(item)) {
          expanded.push(JSON.stringify(item));
        }
      }
      return expanded;
    }
  } catch {
    // 非 JSON 走原样
  }
  return [payload];
}

type ArmsEventBridgeLike = {
  send: (payload: string) => void;
  __lcodeArmsBridgeForwardPatched?: boolean;
};

/**
 * ARMS frame preload 先于本 preload 执行时，Bridge.send 闭包已绑定未 patch 的 ipc.send；
 * 必须包装 Bridge.send 本身，在调用内层 send 前把 events[] 拆条。
 */
function patchArmsEventBridgeSend(bridge: ArmsEventBridgeLike): void {
  if (bridge.__lcodeArmsBridgeForwardPatched) {
    return;
  }
  const innerSend = bridge.send.bind(bridge);
  bridge.send = (payload: string) => {
    const payloads = expandArmsRumBridgePayloads(payload);
    for (const item of payloads) {
      innerSend(item);
    }
  };
  bridge.__lcodeArmsBridgeForwardPatched = true;
}

function patchArmsEventBridgeIfPresent(): boolean {
  const bridge =
    (globalThis as { ArmsEventBridge?: ArmsEventBridgeLike }).ArmsEventBridge ??
    (typeof window !== "undefined"
      ? (window as { ArmsEventBridge?: ArmsEventBridgeLike }).ArmsEventBridge
      : undefined);
  if (!bridge || typeof bridge.send !== "function") {
    return false;
  }
  patchArmsEventBridgeSend(bridge);
  return true;
}

export function scheduleArmsEventBridgePatch(maxAttempts = 100): void {
  if (patchArmsEventBridgeIfPresent()) {
    return;
  }
  let attempts = 0;
  const tick = (): void => {
    if (patchArmsEventBridgeIfPresent()) {
      return;
    }
    attempts += 1;
    if (attempts < maxAttempts) {
      setTimeout(tick, 10);
    }
  };
  tick();
}

export function installArmsRumBridgeIpcForward(ipc: IpcRenderer): void {
  const patched = ipc as PatchedIpcRenderer;
  if (patched.__lcodeArmsIpcPatched) {
    return;
  }
  const originalSend = ipc.send.bind(ipc);
  patched.send = ((channel: string, ...args: unknown[]) => {
    if (channel === ARMS_RUM_BRIDGE_CHANNEL && args.length > 0 && typeof args[0] === "string") {
      const raw = args[0];
      const payloads = expandArmsRumBridgePayloads(raw);
      if (payloads.length === 0) {
        return;
      }
      if (payloads.length === 1 && payloads[0] === raw) {
        return originalSend(channel, raw);
      }
      for (const item of payloads) {
        originalSend(channel, item);
      }
      return;
    }
    return originalSend(channel, ...args);
  }) as IpcRenderer["send"];
  patched.__lcodeArmsIpcPatched = true;
}
