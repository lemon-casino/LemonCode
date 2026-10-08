import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IPlatformService } from "@lcode/shared";
import type { RemotePairingStatePush } from "@lcode/shared";
import { useRemoteControl } from "@/hooks/useRemoteControl.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { RemotePairingPanel } from "@/settings/RemotePairingPanel.js";
import { MobilePairingPage } from "../../src/remote/MobilePairingPage.js";
import { parsePairingDeepLink } from "../../src/remote/pairingDeepLink.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const route = parsePairingDeepLink(`/p/${query.get("roomId")}`, location.hash)!;

function App() {
  const [connected, setConnected] = useState(false);
  // 真实配对页、浏览器存储、WebSocket 与客户端入口；仅 Worker 网络端由测试拦截。
  if (connected) return <div data-testid="mobile-pairing-connected">已连接工作区</div>;
  return <MobilePairingPage route={route} onConnected={() => setConnected(true)} />;
}

function DesktopPanel() {
  const [stopped, setStopped] = useState(false);
  if (stopped) return <div data-testid="pairing-stopped">已停止</div>;
  return (
    <PlatformProvider platform={{} as IPlatformService}>
      <LCodeIntlProvider>
        <RemotePairingPanel
          canStart={true}
          noMirrorTargetHint=""
          pairing={{ state: "reconnecting", roomId: "test-room" }}
          pairingUrl="https://relay.example.com/p/test-room#c=consumed"
          startingPairing={false}
          stoppingPairing={false}
          onStart={async () => {}}
          onStop={async () => setStopped(true)}
          onDecide={async () => {}}
        />
      </LCodeIntlProvider>
    </PlatformProvider>
  );
}

// Main IPC 边界桩；组件、hook、事件裁决和浏览器布局使用生产实现。
let multiPairing: RemotePairingStatePush = {
  state: "bridged",
  roomId: "multi-room",
  multiDevice: true,
  expiresAt: Date.now() + 300000,
  connections: [{ deviceId: "computer", deviceName: "已连接电脑", connected: true }],
  pendingDevices: [
    { requestId: "phone", deviceName: "待授权手机", ua: "" },
    { requestId: "second", deviceName: "另一台电脑", ua: "" },
  ],
};
let multiUrl: string | null = "https://relay.example.com/p/multi-room#c=fixture";
const listeners = new Set<(event: RemotePairingStatePush) => void>();
function publish() {
  for (const listener of listeners) listener(multiPairing);
}
const multiPlatform = {
  getRemoteControlConfig: async () => ({
    enabled: true,
    workerBaseUrl: "",
    hasAccessKey: false,
    pairingTtlMs: 300000,
    allowNewDevices: true,
    idleDisconnectMs: 0,
    pairing: structuredClone(multiPairing),
    pairingUrl: multiUrl,
  }),
  onRemotePairingState: (listener: (event: RemotePairingStatePush) => void) => {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  listRemoteDevices: async () => ({ devices: [] }),
  revokeRemoteDevice: async () => {},
  setRemoteControlConfig: async () => ({ success: true }),
  decideRemotePairing: async ({ requestId, accept }: { requestId: string; accept: boolean }) => {
    const device = multiPairing.pendingDevices?.find((device) => device.requestId === requestId);
    multiPairing = {
      ...multiPairing,
      pendingDevices: multiPairing.pendingDevices?.filter(
        (device) => device.requestId !== requestId,
      ),
      connections: [
        ...(multiPairing.connections ?? []),
        ...(accept && device
          ? [{ deviceId: requestId, deviceName: device.deviceName, connected: true }]
          : []),
      ],
    };
    publish();
  },
  startRemotePairing: async () => {
    multiUrl = "https://relay.example.com/p/multi-room#c=refreshed-fixture";
    multiPairing = { ...multiPairing, expiresAt: Date.now() + 300000 };
    publish();
    return {
      success: true,
      roomId: "multi-room",
      pairingUrl: multiUrl,
      expiresAt: multiPairing.expiresAt,
    };
  },
  stopRemotePairing: async () => {
    multiPairing = { state: "stopped" };
    multiUrl = null;
    publish();
  },
} as unknown as IPlatformService;
function DesktopMultiPanel() {
  const control = useRemoteControl(multiPlatform);
  return (
    <PlatformProvider platform={multiPlatform}>
      <LCodeIntlProvider>
        <RemotePairingPanel
          canStart={true}
          noMirrorTargetHint=""
          pairing={control.pairing}
          pairingUrl={control.pairingUrl}
          startingPairing={control.startingPairing}
          stoppingPairing={control.stoppingPairing}
          onStart={async () => {
            await control.startPairing();
          }}
          onStop={control.stopPairing}
          onDecide={control.decidePairing}
        />
      </LCodeIntlProvider>
    </PlatformProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  query.has("multi") ? <DesktopMultiPanel /> : query.has("panel") ? <DesktopPanel /> : <App />,
);
