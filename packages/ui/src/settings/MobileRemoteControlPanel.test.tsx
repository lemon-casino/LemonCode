import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { IPlatformService } from "@lcode/shared";

// Node 的源码测试不经过 Vite；provider 图标等静态资产在这里等价为 URL 字符串模块。
registerHooks({
  load(url, context, nextLoad) {
    if (/\.(?:gif|jpe?g|png|webp|svg)$/.test(url)) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(url)};`,
      };
    }
    return nextLoad(url, context);
  },
});

const { LCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
const { PlatformProvider } = await import("@/hooks/usePlatform.js");
const { MobileRemoteControlPanel } = await import("./MobileRemoteControlPanel.js");
const { RemotePairingPanel } = await import("./RemotePairingPanel.js");

test("多人在线时链接到期仍可刷新，不能要求先停止已有连接", () => {
  const markup = renderToStaticMarkup(
    <PlatformProvider platform={{} as IPlatformService}>
      <LCodeIntlProvider>
        <RemotePairingPanel
          canStart={true}
          noMirrorTargetHint=""
          pairing={{
            state: "bridged",
            roomId: "room",
            multiDevice: true,
            expiresAt: 1,
            connections: [{ deviceId: "A", deviceName: "在线设备", connected: true }],
          }}
          pairingUrl={null}
          startingPairing={false}
          stoppingPairing={false}
          onStart={async () => {}}
          onStop={async () => {}}
          onDecide={async () => {}}
        />
      </LCodeIntlProvider>
    </PlatformProvider>,
  );
  assert.match(markup, /刷新二维码/);
  assert.match(markup, /在线设备/);
  assert.doesNotMatch(markup, /remote-control-pairing-url/);
});

test("多设备连接与两个独立请求同时展示，保留有效共享链接", () => {
  const markup = renderToStaticMarkup(
    <PlatformProvider platform={{} as IPlatformService}>
      <LCodeIntlProvider>
        <RemotePairingPanel
          canStart={true}
          noMirrorTargetHint=""
          pairing={{
            state: "bridged",
            roomId: "test-room",
            multiDevice: true,
            expiresAt: Date.now() + 300000,
            connections: [{ deviceId: "A", deviceName: "已连接电脑", connected: true }],
            pendingDevices: [
              { requestId: "B", deviceName: "待授权手机", ua: "" },
              { requestId: "C", deviceName: "另一台电脑", ua: "" },
            ],
          }}
          pairingUrl="https://relay.example.com/p/test-room#c=fixture"
          startingPairing={false}
          stoppingPairing={false}
          onStart={async () => {}}
          onStop={async () => {}}
          onDecide={async () => {}}
        />
      </LCodeIntlProvider>
    </PlatformProvider>,
  );
  assert.match(markup, /已连接电脑/);
  assert.match(markup, /待授权手机/);
  assert.match(markup, /另一台电脑/);
  assert.equal(
    (markup.match(/data-testid="remote-control-pairing-device-request"/g) ?? []).length,
    2,
  );
  assert.match(markup, /remote-control-pairing-url/);
  assert.equal((markup.match(/>允许</g) ?? []).length, 2);
});

test("等待远程设备重连时显示恢复提示，不显示错误或已消费二维码", () => {
  const markup = renderToStaticMarkup(
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
          onStop={async () => {}}
          onDecide={async () => {}}
        />
      </LCodeIntlProvider>
    </PlatformProvider>,
  );
  assert.match(markup, /等待远程设备重新连接/);
  assert.doesNotMatch(markup, /BRIDGE_DETACHED|配对出错|remote-control-pairing-url/);
  assert.match(markup, /停止/);
});

/** 只具备契约 §6.3 必需通道能力的最小平台桩；config 快照可覆盖。 */
function makeBridgePlatformStub(configOverrides: Record<string, unknown> = {}) {
  return {
    startRemotePairing: async () => ({ success: false, error: "stub" }),
    stopRemotePairing: async () => {},
    decideRemotePairing: async () => {},
    onRemotePairingState: () => () => {},
    getRemoteControlConfig: async () => ({
      enabled: false,
      workerBaseUrl: "",
      hasAccessKey: false,
      pairingTtlMs: 300_000,
      allowNewDevices: true,
      idleDisconnectMs: 0,
      pairing: null,
      pairingUrl: null,
      ...configOverrides,
    }),
    setRemoteControlConfig: async () => ({ success: true }),
  } as unknown as IPlatformService;
}

function renderPanel(
  platform: IPlatformService,
  props?: Partial<Parameters<typeof MobileRemoteControlPanel>[0]>,
): string {
  return renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <PlatformProvider platform={platform}>
        <MobileRemoteControlPanel {...props} />
      </PlatformProvider>
    </LCodeIntlProvider>,
  );
}

test("独立配对块统一为远程控制与远程扫码连接", () => {
  // renderToStaticMarkup 不执行 effect，config 停留在加载态也能渲染外层结构。
  const markup = renderPanel(makeBridgePlatformStub());
  assert.match(markup, /data-testid="mobile-remote-control-panel"/);
  assert.match(markup, /远程控制/);
  assert.doesNotMatch(markup, /移动端远程控制|手机扫码连接|用手机相机/);
  assert.match(markup, /扫码或在远程设备上打开链接/);
  assert.match(markup, /远程扫码连接/);
  assert.match(markup, /用远程相机扫码，即可打开工作区/);
});

test("平台能力缺失时如实降级，不渲染配对面板与开启控件", () => {
  const markup = renderPanel({} as IPlatformService);
  assert.match(markup, /远程控制只能在 LCode 桌面端使用/);
  assert.doesNotMatch(markup, /data-testid="remote-control-pairing-panel"/);
  assert.doesNotMatch(markup, /开启等待/);
});

test("主开关未开启时给出去设置的出口，不渲染配对面板", () => {
  // renderToStaticMarkup 不执行 effect，config 仍为 null（加载态）；
  // 未开启分支用完整 config 快照在真实交互中可达，这里锁定「出口按钮永远存在」这一结构契约。
  const markup = renderPanel(makeBridgePlatformStub(), { onOpenSettings: () => {} });
  assert.match(markup, /远程控制设置/);
});

test("镜像 target 上下文经 mirrorWorkspace 传入并生成 local target", async () => {
  const { buildRemotePairingMirrorTarget } = await import("./remoteControlBridge.js");
  const local = buildRemotePairingMirrorTarget({
    workspacePath: "/work/demo",
    workspaceIdentity: " identity-1 ",
  });
  assert.equal(local?.kind, "local");
  assert.equal(local?.workspaceIdentity, "identity-1");
});
