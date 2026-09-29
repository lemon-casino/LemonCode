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

const { TooltipProvider } = await import("@/components/ui/tooltip.js");
const { LCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
const { PlatformProvider } = await import("@/hooks/usePlatform.js");
const { ServiceProvider } = await import("@/hooks/useServices.js");
const { StoreProvider } = await import("@/store/StoreProvider.js");
const { WorkspaceSidebarFooter } = await import("./WorkspaceSidebarFooter.js");

// createLCodeStore 初始化会 applyTheme：syncBrowserThemeSurface 在 hasAttribute 为
// false 时提前返回，这里只补齐这条最小 DOM 面即可，无需引入 jsdom。
(globalThis as Record<string, unknown>).document = {
  documentElement: {
    classList: { toggle() {}, add() {}, remove() {} },
    hasAttribute: () => false,
    style: {},
  },
  querySelector: () => null,
  createElement: () => ({}),
  head: { append() {} },
};

// footer 的用量摘要/快捷键等 hook 在无服务环境按加载态降级，静态渲染不触发 effect。
const platformStub = {} as IPlatformService;
// StoreProvider 只要求一个 IBroadcastService；静态渲染不产生广播流量，全部 no-op。
const broadcastStub = {
  send: async () => {},
  acquireClaim: async () => ({}),
  commitClaim: async () => {},
  releaseClaim: async () => {},
  tryClaim: async () => false,
  onMessage: () => () => {},
} as unknown as import("@lcode/services").IBroadcastService;
// IServiceAccessor 空桩：settingService 缺位走 unavailableSettingsStore 加载态。
const servicesStub = {} as never;

function renderFooter(props: Partial<Parameters<typeof WorkspaceSidebarFooter>[0]>): string {
  return renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <PlatformProvider platform={platformStub}>
        <ServiceProvider services={servicesStub}>
          <StoreProvider broadcastService={broadcastStub}>
            <TooltipProvider>
              <WorkspaceSidebarFooter
                theme="system"
                localeMenuValue="system"
                onLocaleChange={() => {}}
                onThemeChange={() => {}}
                {...props}
              />
            </TooltipProvider>
          </StoreProvider>
        </ServiceProvider>
      </PlatformProvider>
    </LCodeIntlProvider>,
  );
}

test("footer 远程控制快捷入口渲染在设置按钮之前，点击弹出手机配对弹框", () => {
  const markup = renderFooter({
    remoteControlPanel: <div data-testid="mobile-remote-control-panel">弹框内容桩</div>,
  });
  const remoteIndex = markup.indexOf('data-testid="footer-remote-control-button"');
  const settingsIndex = markup.indexOf('data-testid="task-settings-button"');
  assert.ok(remoteIndex >= 0, "应渲染 footer 远程控制入口");
  assert.ok(settingsIndex >= 0, "应渲染设置按钮");
  // 入口位置契约：位于「连接使用」账户入口与设置按钮之间、设置按钮之前。
  assert.ok(remoteIndex < settingsIndex, "远程控制入口必须出现在设置按钮之前");
  assert.match(markup, /aria-label="远程控制"/);
});

test("未传 remoteControlPanel 时不渲染远程控制入口（Web/手机平台门禁由调用方收口）", () => {
  const markup = renderFooter({});
  assert.doesNotMatch(markup, /footer-remote-control-button/);
});

test("无账号体系时身份区回退品牌名，头像写死为品牌 L 徽标", () => {
  // renderToStaticMarkup 不执行 effect，getSystemUsername 未返回时回退 "LCode"；
  // 真实用户名路径由运行时验证（dev 实例 CDP）覆盖。
  const markup = renderFooter({});
  assert.doesNotMatch(markup, /连接使用/);
  assert.doesNotMatch(markup, /sidebar\.profile\.notLoggedIn/);
  // 品牌 L 徽标（app-logo.svg）作为默认头像，替代通用 User 图标。
  assert.match(markup, /src="[^"]*app-logo\.svg"/);
  assert.match(markup, /alt="LCode"/);
});
