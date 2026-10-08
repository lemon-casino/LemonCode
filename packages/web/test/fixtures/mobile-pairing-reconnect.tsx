import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IPlatformService } from "@lcode/shared";
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

createRoot(document.getElementById("root")!).render(
  query.has("panel") ? <DesktopPanel /> : <App />,
);
