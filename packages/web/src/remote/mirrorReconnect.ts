import type { PairingFailureKey } from "./pairingFrames.js";

/**
 * 镜像连接的重连策略(契约 §3.3 / specs/mobile-remote-control-cf-workers.md:87):
 * - 接管后(settled)数据套接字网络类断链 → 自动刷新页面重连:刷新后深链 + 会话凭据
 *   走既有 resume 路径(bridge.open resumed),重连过程由配对页 bridging 界面提示。
 *   凭据/房间类死亡(吊销/停止/过期/失效)不重连:重连必然失败且白耗 §3.1 失败计数。
 * - 建连阶段对 busy(4008) 与网络类失败做有界重试:旧套接字无 FIN 死亡时,Worker
 *   需等约 75s 心跳超时才释放桥槽(cfworker-remote/src/room.ts:795-811),期间同凭据
 *   重连被 4008 拒绝;Worker 对 busy 不计失败(room.ts:289-295「凭据校验已通过,
 *   不计失败」),重试安全,不会把房间推向 invalidated。
 */

/** 接管后值得自动刷新重连的失败类别;4007 stopped/吊销等终态必须除外。 */
export const MIRROR_RECONNECT_KEYS: ReadonlySet<PairingFailureKey> = new Set([
  "network",
  "heartbeat",
  "busy",
]);

/** 建连阶段可自动重试的失败类别;auth/room-missing/expired/invalidated/stopped 重试无意义。 */
export const DATA_SOCKET_RETRY_KEYS: ReadonlySet<PairingFailureKey> = new Set([
  "busy",
  "network",
  "heartbeat",
]);

export const DATA_SOCKET_RETRY_DELAY_MS = 3_000;
// 重试截止需覆盖旧桥最长约 75s 的心跳回收(§3.4),并留出 60s resumed 宽限的交叠余量。
export const DATA_SOCKET_RETRY_DEADLINE_MS = 90_000;

// 自动刷新重连的防循环预算:短时间反复断链时停止自动刷新,避免连接风暴;
// 用户仍可手动刷新(手动路径不设限)。
export const MIRROR_RELOAD_BUDGET = 5;
export const MIRROR_RELOAD_WINDOW_MS = 5 * 60_000;
export const MIRROR_RELOAD_BUDGET_KEY = "lcode:remote-pairing:reconnect-reloads";

/** 纯函数:给定历史刷新时间戳,决定本次是否允许自动刷新,并返回应写回的时间戳序列。 */
export function planMirrorReconnectReload(
  stamps: unknown,
  now: number,
): { reload: boolean; next: number[] } {
  const recent = (Array.isArray(stamps) ? stamps : []).filter(
    (stamp): stamp is number => typeof stamp === "number" && now - stamp < MIRROR_RELOAD_WINDOW_MS,
  );
  if (recent.length >= MIRROR_RELOAD_BUDGET) {
    return { reload: false, next: recent };
  }
  return { reload: true, next: [...recent, now] };
}

/** 接管后断链的自动刷新入口;凭据/房间类死亡直接忽略。 */
export function scheduleMirrorReconnectReload(closeKey: PairingFailureKey): void {
  if (!MIRROR_RECONNECT_KEYS.has(closeKey)) {
    return;
  }
  try {
    // 旧键兼容读：老会话预算存于 zcode:remote-pairing:reconnect-reloads。
    const raw =
      window.sessionStorage.getItem(MIRROR_RELOAD_BUDGET_KEY) ||
      window.sessionStorage.getItem("zcode:remote-pairing:reconnect-reloads");
    const plan = planMirrorReconnectReload(raw ? JSON.parse(raw) : [], Date.now());
    if (!plan.reload) {
      return;
    }
    window.sessionStorage.setItem(MIRROR_RELOAD_BUDGET_KEY, JSON.stringify(plan.next));
  } catch {
    // 存储不可用(JSON 损坏/隐私模式):跳过预算检查,仍执行一次重连刷新
  }
  window.location.reload();
}
