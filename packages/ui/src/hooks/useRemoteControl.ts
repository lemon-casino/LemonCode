// 远程控制设置/配对面板的 Renderer 侧状态装配。
//
// 状态所有权（cfworker-remote/PROTOCOL.md §6.3）：配对状态、配置与已授权设备的唯一
// 所有者是 Desktop Main；本 hook 只是挂载期缓存 —— 通过 remoteControlBridge 的平台
// 能力读取与订阅，Renderer 不自行推断任何状态迁移（例如 stop 成功后面板回到什么状态，
// 一律等 Main 的 lcode:remote-pairing-state 推送）。
//
// 快照语义：Main 仅在状态变化时推送；config-get 响应附带最近一次推送的 pairing 快照与
// waiting 态的 pairingUrl（§6.3），挂载/重挂载时据此恢复面板初始状态。取快照期间若收到
// 新推送（序号守卫），以推送为准、丢弃过期快照，避免旧二维码复现。
//
// 凭据红线：接入 Key 只经 saveConfig({ accessKey }) 单向进入 Main 的凭据集中存储，
// 本 hook 不持有、不缓存、不写日志；读回永远只有 hasAccessKey。
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { IPlatformService } from "@lcode/shared";
import { logger } from "@/logger.js";
import {
  resolveRemoteControlBridge,
  type RemoteControlConfig,
  type RemoteControlConfigPatch,
  type RemoteControlDevice,
  type RemoteControlTestResult,
  type RemotePairingPhase,
  type RemotePairingStartRequest,
  type RemotePairingStartResult,
  type RemotePairingStateEvent,
} from "@/settings/remoteControlBridge.js";

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function useRemoteControl(platform: IPlatformService) {
  const bridge = useMemo(() => resolveRemoteControlBridge(platform), [platform]);
  const [config, setConfig] = useState<RemoteControlConfig | null>(null);
  const [configLoading, setConfigLoading] = useState(bridge !== null);
  const [configSaving, setConfigSaving] = useState(false);
  const [pairing, setPairing] = useState<RemotePairingStateEvent | null>(null);
  /** 最近一次 startRemotePairing 返回的链接；capability 只在内存中供二维码/复制使用。 */
  const [pairingUrl, setPairingUrl] = useState<string | null>(null);
  const [startingPairing, setStartingPairing] = useState(false);
  const [stoppingPairing, setStoppingPairing] = useState(false);
  const [devices, setDevices] = useState<RemoteControlDevice[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(bridge !== null);
  const [deviceActionPendingId, setDeviceActionPendingId] = useState<string | null>(null);
  const [testingConnection, setTestingConnection] = useState(false);
  /** 推送事件序号:快照取回期间若有新推送落地,说明快照已过期,不回写状态(§6.3 竞态守卫)。 */
  const pairingEventSeqRef = useRef(0);

  const loadConfig = useCallback(async () => {
    if (!bridge) return;
    const seqAtRequest = pairingEventSeqRef.current;
    try {
      const snapshot = await bridge.getRemoteControlConfig();
      setConfig(snapshot);
      // 推送通道只在状态变化时广播(§6.3);重挂载后面板的初始状态以 Main 快照为准,
      // 否则会把 waiting/pairing/bridged 误显示成"未在等待",诱导用户误触 stopPairing。
      if (pairingEventSeqRef.current === seqAtRequest) {
        setPairing(snapshot.pairing);
        setPairingUrl(snapshot.pairingUrl);
      }
    } catch (error) {
      logger.warn("[remote-control] 读取远程控制配置失败", {
        error: describeError(error),
      });
    } finally {
      setConfigLoading(false);
    }
  }, [bridge]);

  const refreshDevices = useCallback(async () => {
    if (!bridge) return;
    try {
      const result = await bridge.listRemoteDevices();
      setDevices(result.devices);
    } catch (error) {
      logger.warn("[remote-control] 读取已授权设备列表失败", {
        error: describeError(error),
      });
    } finally {
      setDevicesLoading(false);
    }
  }, [bridge]);

  useEffect(() => {
    if (!bridge) return;
    let disposed = false;
    // PROTOCOL.md §2.2：capability consume-once —— 配对阶段一旦进入（pairing），
    // 无论 accept/reject/超时，当前二维码里的 capability 都已作废，必须由
    // startRemotePairing 重新生成。这里只按契约回收链接，不推断状态迁移本身。
    let previousState: RemotePairingPhase | null = null;
    const dispose = bridge.onRemotePairingState((event) => {
      if (disposed) return;
      pairingEventSeqRef.current += 1;
      if (!event.multiDevice && previousState === "pairing") {
        setPairingUrl(null);
      }
      previousState = event.state;
      setPairing(event);
      // 另一窗口刷新同一房间时 capability 也会变化；链接从 Main 回读，不能沿用旧 URL。
      if (event.multiDevice) void loadConfig();
      if (
        event.state === "stopped" ||
        event.state === "error" ||
        (!event.multiDevice && event.state === "reconnecting")
      ) {
        // 房间终态或已配对设备等待重连时，旧 capability 已消费，不能恢复旧二维码。
        // 二维码与复制链接不再可用，立即回收内存中的明文链接。
        setPairingUrl(null);
      }
      if (event.state === "bridged") {
        // 新设备完成双方授权后马上回读列表，保证「已授权设备」看到刚授权的设备。
        void refreshDevices();
      }
      if (event.multiDevice && event.expiresAt && event.expiresAt <= Date.now())
        setPairingUrl(null);
    });
    return () => {
      disposed = true;
      dispose();
    };
  }, [bridge, refreshDevices, loadConfig]);

  useEffect(() => {
    if (!pairing?.multiDevice || !pairing.expiresAt || !pairingUrl) return;
    // 截止时间只用于回收过期二维码；房间和设备状态仍由 Main 推送决定。
    const timer = setTimeout(
      () => setPairingUrl(null),
      Math.max(0, pairing.expiresAt - Date.now()),
    );
    return () => clearTimeout(timer);
  }, [pairing?.multiDevice, pairing?.expiresAt, pairingUrl]);

  useEffect(() => {
    if (!bridge) return;
    void loadConfig();
    void refreshDevices();
  }, [bridge, loadConfig, refreshDevices]);

  const saveConfig = useCallback(
    async (patch: RemoteControlConfigPatch): Promise<{ success: boolean; error?: string }> => {
      if (!bridge) return { success: false, error: "capability_missing" };
      setConfigSaving(true);
      try {
        const result = await bridge.setRemoteControlConfig(patch);
        // 配置唯一事实源在 Main：写入后回读一次，enabled/hasAccessKey 等以回读为准，
        // 避免 Renderer 乐观覆盖出与 Main 不一致的本地副本。
        await loadConfig();
        return result.success
          ? { success: true }
          : { success: false, error: result.error ?? "rejected" };
      } catch (error) {
        // 只记录涉及的字段名，绝不记录 patch 值（可能含接入 Key 明文）。
        const message = describeError(error);
        logger.warn("[remote-control] 保存远程控制配置失败", {
          fields: Object.keys(patch),
          error: message,
        });
        return { success: false, error: message };
      } finally {
        setConfigSaving(false);
      }
    },
    [bridge, loadConfig],
  );

  const startPairing = useCallback(
    async (request?: RemotePairingStartRequest): Promise<RemotePairingStartResult | null> => {
      if (!bridge) return null;
      setStartingPairing(true);
      try {
        // 镜像 target 由设置页按“激活的远程 workspace”组装后传入（Renderer 是该业务状态
        // 的所有者，cfworker-remote/PROTOCOL.md §6.3）；target.windowId 只是占位，
        // Main 的 RemotePairingStart handler 会按可信 IPC sender 的宿主窗口权威覆盖。
        const result = await bridge.startRemotePairing(request);
        if (result.success) {
          // pairingUrl 含一次性 capability fragment：只留在内存供二维码/复制链接，
          // 不落日志、不进任何持久化（PROTOCOL.md §5）。
          // start 回复可能晚于授权、停止或另一窗口刷新；从 Main 最新快照取链接，
          // 不让旧回复重新展示已失效 capability。
          await loadConfig();
        }
        return result;
      } catch (error) {
        return { success: false, error: describeError(error) };
      } finally {
        setStartingPairing(false);
      }
    },
    [bridge, loadConfig],
  );

  const stopPairing = useCallback(async (): Promise<void> => {
    if (!bridge) return;
    setStoppingPairing(true);
    try {
      await bridge.stopRemotePairing();
      // 停止后的面板状态由 Main 推送（stopped），这里不做本地推断。
    } finally {
      setStoppingPairing(false);
    }
  }, [bridge]);

  const decidePairing = useCallback(
    async (requestId: string, accept: boolean): Promise<void> => {
      if (!bridge) return;
      await bridge.decideRemotePairing({ requestId, accept });
      // 裁决结果（accepted/rejected → bridged/waiting）同样以 Main 推送为准。
    },
    [bridge],
  );

  const revokeDevice = useCallback(
    async (deviceId: string): Promise<void> => {
      if (!bridge) return;
      setDeviceActionPendingId(deviceId);
      try {
        await bridge.revokeRemoteDevice(deviceId);
        await refreshDevices();
      } finally {
        setDeviceActionPendingId(null);
      }
    },
    [bridge, refreshDevices],
  );

  const testConnection = useCallback(async (): Promise<RemoteControlTestResult | null> => {
    if (!bridge?.testRemoteControlConnection) return null;
    setTestingConnection(true);
    try {
      return await bridge.testRemoteControlConnection();
    } catch (error) {
      return { success: false, error: describeError(error) };
    } finally {
      setTestingConnection(false);
    }
  }, [bridge]);

  return {
    bridge,
    config,
    configLoading,
    configSaving,
    pairing,
    pairingUrl,
    startingPairing,
    stoppingPairing,
    devices,
    devicesLoading,
    deviceActionPendingId,
    testingConnection,
    loadConfig,
    refreshDevices,
    saveConfig,
    startPairing,
    stopPairing,
    decidePairing,
    revokeDevice,
    testConnection,
  };
}
