import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { IPlatformService } from "@lcode/shared";
import { PlatformProvider } from "../hooks/usePlatform.js";
import { LCodeIntlProvider } from "../i18n/IntlProvider.js";
import enUS from "../i18n/locales/en-US.js";
import zhCN from "../i18n/locales/zh-CN.js";
import { resolveSettingsSection } from "../lib/settingsNavigation.js";
import { RemoteControlSettingsSection } from "./RemoteControlSettingsSection.js";
import { RemotePairingPanel } from "./RemotePairingPanel.js";
import {
  buildRemotePairingMirrorTarget,
  REMOTE_PAIRING_PLACEHOLDER_WINDOW_ID,
  resolveRemoteControlBridge,
} from "./remoteControlBridge.js";
import { SETTINGS_SECTIONS, createSettingsPageConfig } from "./settingsPageConfig.js";

/** 只具备契约 §6.3 中 8 个必需通道能力的最小平台桩。 */
const bridgePlatformStub = {
  startRemotePairing: async () => ({ success: false, error: "stub" }),
  stopRemotePairing: async () => {},
  decideRemotePairing: async () => {},
  onRemotePairingState: () => () => {},
  listRemoteDevices: async () => ({ devices: [] }),
  revokeRemoteDevice: async (_deviceId: string) => {},
  getRemoteControlConfig: async () => ({
    enabled: false,
    workerBaseUrl: "",
    hasAccessKey: false,
    pairingTtlMs: 300_000,
    allowNewDevices: true,
    idleDisconnectMs: 0,
  }),
  setRemoteControlConfig: async () => ({ success: true }),
} as unknown as IPlatformService;

function renderSection(platform: IPlatformService): string {
  return renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <PlatformProvider platform={platform}>
        <RemoteControlSettingsSection />
      </PlatformProvider>
    </LCodeIntlProvider>,
  );
}

function renderPairingPanel(props: Partial<Parameters<typeof RemotePairingPanel>[0]>): string {
  return renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <RemotePairingPanel
        canStart
        noMirrorTargetHint="镜像目标缺失提示"
        pairing={null}
        pairingUrl={null}
        startingPairing={false}
        stoppingPairing={false}
        onStart={async () => {}}
        onStop={async () => {}}
        onDecide={async () => {}}
        {...props}
      />
    </LCodeIntlProvider>,
  );
}

test("resolveRemoteControlBridge 缺任一必需能力即整体 fail-closed", () => {
  assert.equal(resolveRemoteControlBridge({} as IPlatformService), null);
  assert.equal(resolveRemoteControlBridge(null), null);

  const bridge = resolveRemoteControlBridge(bridgePlatformStub);
  assert.ok(bridge);
  // 「测试连接」是契约外可选能力（Main 调 /api/health），缺失时仍应放行其余能力。
  assert.equal(typeof bridge.testRemoteControlConnection, "undefined");

  const { onRemotePairingState: _omitted, ...incomplete } = bridgePlatformStub as unknown as Record<
    string,
    unknown
  >;
  assert.equal(resolveRemoteControlBridge(incomplete as unknown as IPlatformService), null);
});

test("remoteControl 分区仅桌面注册，入口在 footer 而非设置侧栏导航", () => {
  // Web 默认配置（无桌面平台能力）不出现远程控制。
  assert.equal(
    SETTINGS_SECTIONS.some((section) => section.id === "remoteControl"),
    false,
  );

  const desktopConfig = createSettingsPageConfig({ isDesktop: true });
  // 分区保留注册：直达意图（footer 快捷入口）、面包屑与上次停留分区解析仍可落回本分区。
  assert.ok(desktopConfig.settingsSections.some((section) => section.id === "remoteControl"));
  // 侧栏导航分组不再列出（入口已迁到侧栏 footer，specs/mobile-remote-control-cf-workers.md）。
  for (const group of desktopConfig.settingsSectionGroups) {
    assert.equal(
      group.sections.some((section) => section.id === "remoteControl"),
      false,
      `导航分组 ${group.id} 不应再列出 remoteControl`,
    );
  }

  // 上次停留分区记忆的往返解析必须落回本分区，而不是被当成未知 id 回退 general。
  assert.equal(resolveSettingsSection("remoteControl"), "remoteControl");
});

test("平台能力缺失时渲染 desktopOnly 提示，不渲染任何控件", () => {
  const markup = renderSection({} as IPlatformService);
  assert.match(markup, /远程控制只能在 LCode 桌面端使用/);
  assert.doesNotMatch(markup, /remote-control-enabled-switch/);
});

test("能力齐备时渲染启用开关、域名/Key 输入、测试连接与安全隐私，不再承载手机配对", () => {
  const markup = renderSection(bridgePlatformStub);
  // 启用开关 + Worker 域名 + 接入 Key + 测试连接。
  assert.match(markup, /data-testid="remote-control-enabled-switch"/);
  assert.match(markup, /data-testid="remote-control-worker-base-url"/);
  assert.match(markup, /data-testid="remote-control-access-key"/);
  assert.match(markup, /data-testid="remote-control-access-key-state"/);
  assert.match(markup, /data-testid="remote-control-test-connection"/);
  // 已授权设备区处于加载态；隐私说明如实标注无端到端加密。
  // （renderToStaticMarkup 不执行 effect，devicesLoading 保持初始 true，空态在交互后才可达。）
  assert.match(markup, /data-testid="remote-control-allow-new-devices"/);
  assert.match(markup, /正在读取已授权设备/);
  assert.match(markup, /未做端到端加密/);
  // 尚未从 Main 拿到配置前接入 Key 显示未配置，且开关禁用（配置只回读 hasAccessKey）。
  assert.match(markup, /尚未配置接入 Key/);
  assert.match(markup, /disabled=""/);
  // 手机配对已独立为 MobileRemoteControlPanel（侧栏 footer 弹框），设置段不再渲染配对 UI。
  assert.doesNotMatch(markup, /data-testid="remote-control-pairing-panel"/);
  assert.doesNotMatch(markup, /在这里生成二维码/);
});

test("配对面板按 Main 推送的状态投影：等待/裁决/已就绪", () => {
  // pairing=null 是「状态未知」(Main 仅在状态变化时推送,重挂载后无法确认是否在镜像),
  // 不得显示「未在等待」误导用户;「开启等待」在该状态下有二次确认拦截。
  const unknown = renderPairingPanel({});
  assert.match(unknown, /data-testid="remote-control-pairing-panel"/);
  assert.match(unknown, /状态未知/);
  assert.match(unknown, /无法确认当前是否正在镜像/);
  assert.match(unknown, /开启等待/);
  assert.doesNotMatch(unknown, /未在等待/);

  const idle = renderPairingPanel({ pairing: { state: "stopped" } });
  assert.match(idle, /未在等待/);
  assert.match(idle, /开启等待/);

  const waiting = renderPairingPanel({
    pairing: { state: "waiting", roomId: "room", expiresAt: 1_700_000_000_000 },
    pairingUrl: "https://worker.example/p/room#c=cap",
  });
  assert.match(waiting, /等待手机连接/);
  assert.match(waiting, /data-testid="remote-control-pairing-url"/);
  assert.match(waiting, /复制链接/);
  assert.match(waiting, /刷新二维码/);
  assert.match(waiting, /停止/);

  const pairing = renderPairingPanel({
    pairing: {
      state: "pairing",
      roomId: "room",
      pendingDevice: { requestId: "req-1", deviceName: "iPhone", ua: "Mozilla/5.0" },
    },
  });
  assert.match(pairing, /设备请求接入/);
  assert.match(pairing, /iPhone/);
  assert.match(pairing, /该设备请求获得与桌面完全一致的控制权限/);
  assert.match(pairing, /允许/);
  assert.match(pairing, /拒绝/);

  const bridged = renderPairingPanel({
    pairing: { state: "bridged", roomId: "room" },
  });
  assert.match(bridged, /已就绪/);
  assert.match(bridged, /完全一致的操作能力/);
  assert.match(bridged, /停止/);
});

test("waiting 但 capability 已消费（无链接）时提示刷新二维码，不再渲染旧码", () => {
  // PROTOCOL.md §2.2：capability consume-once，accept/reject/超时后都必须重新生成。
  const stale = renderPairingPanel({
    pairing: { state: "waiting", roomId: "room", expiresAt: 1_700_000_000_000 },
    pairingUrl: null,
  });
  assert.match(stale, /请刷新生成新的二维码/);
  assert.match(stale, /刷新二维码/);
  assert.doesNotMatch(stale, /data-testid="remote-control-pairing-url"/);
});

test("组装不出镜像 target 时禁用开启等待并提示，错误码按本地化映射渲染", () => {
  // target 缺省会在 bridge.open 后才 fail-closed(MIRROR_TARGET_MISSING 关房),手机白扫一次;
  // UI 在开启前 fail-closed(评审 high 项修复)。
  const noTarget = renderPairingPanel({ canStart: false });
  assert.match(noTarget, /镜像目标缺失提示/);
  assert.match(noTarget, /disabled=""/);

  // Main 推送的 error 机器码必须有中文文案;未知码走 unknown 包裹,不裸奔上屏。
  const localized = renderPairingPanel({
    pairing: { state: "error", error: "REMOTE_SESSION_MISSING" },
  });
  assert.match(localized, /要镜像的远程会话已不存在/);
  const unknown = renderPairingPanel({
    pairing: { state: "error", error: "SOME_FUTURE_CODE" },
  });
  assert.match(unknown, /配对出错：SOME_FUTURE_CODE/);
});

test("buildRemotePairingMirrorTarget:远程三元组产出 remote target,本地工作区产出 local target", () => {
  assert.equal(buildRemotePairingMirrorTarget({}), null);
  assert.equal(buildRemotePairingMirrorTarget({ remoteSessionId: "s", workspacePath: "  " }), null);
  const remote = buildRemotePairingMirrorTarget({
    remoteSessionId: " session-1 ",
    workspacePath: "/work/demo",
  });
  assert.deepEqual(remote, {
    // windowId 是 Main 权威字段的占位值(handler 按可信 sender 覆盖),见 remoteControlBridge.ts。
    kind: "remote",
    windowId: REMOTE_PAIRING_PLACEHOLDER_WINDOW_ID,
    remoteSessionId: "session-1",
    workspacePath: "/work/demo",
    // 身份 key 统一规则:workspaceIdentity?.trim() || workspacePath。
    workspaceIdentity: "/work/demo",
  });
  // 本地工作区(无 remoteSessionId)不再禁用「开启等待」:产出 local target,
  // 由 Main 以 scope:{kind:"local"} 第二 attachment 挂到窗口 Host(与 Renderer 共存)。
  const local = buildRemotePairingMirrorTarget({ workspacePath: "/work/local-demo" });
  assert.deepEqual(local, {
    kind: "local",
    windowId: REMOTE_PAIRING_PLACEHOLDER_WINDOW_ID,
    workspacePath: "/work/local-demo",
    workspaceIdentity: "/work/local-demo",
  });
  const localWithIdentity = buildRemotePairingMirrorTarget({
    workspacePath: "/work/local-demo",
    workspaceIdentity: " identity-1 ",
  });
  assert.equal(localWithIdentity?.kind, "local");
  assert.equal(localWithIdentity?.workspaceIdentity, "identity-1");
});

test("zh-CN 与 en-US 的远程控制文案键（设置段 + 独立配对块）一一对应", () => {
  const isRemoteControlKey = (key: string) =>
    key.startsWith("settings.remoteControl.") || key.startsWith("remoteControl.quick.");
  const zhKeys = Object.keys(zhCN).filter(isRemoteControlKey);
  const enKeys = Object.keys(enUS).filter(isRemoteControlKey);
  assert.ok(zhKeys.length >= 50, `远程控制文案过少: ${zhKeys.length}`);
  assert.deepEqual(
    enKeys.filter((key) => !(key in zhCN)),
    [],
    "en-US 多出的键",
  );
  assert.deepEqual(
    zhKeys.filter((key) => !(key in enUS)),
    [],
    "en-US 缺失的键",
  );
  for (const key of [...zhKeys, ...enKeys]) {
    assert.ok(String(zhCN[key] ?? enUS[key]).length > 0, `空文案: ${key}`);
  }
});
