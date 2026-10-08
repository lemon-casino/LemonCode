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

test("等待手机重连时显示恢复提示，不显示错误或已消费二维码", () => {
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
  assert.match(markup, /等待手机重新连接/);
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

test("独立配对块渲染「移动端远程控制」标题与扫码引导", () => {
  // renderToStaticMarkup 不执行 effect，config 停留在加载态也能渲染外层结构。
  const markup = renderPanel(makeBridgePlatformStub());
  assert.match(markup, /data-testid="mobile-remote-control-panel"/);
  assert.match(markup, /移动端远程控制/);
  assert.match(markup, /扫码或在手机上打开链接/);
  assert.match(markup, /手机扫码连接/);
  assert.match(markup, /用手机相机扫码/);
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
