import { createRoot } from "react-dom/client";
import type { BroadcastMessage, IBroadcastService } from "@lcode/services";
import { LCodeIntlProvider, useLCodeIntl } from "@/i18n/IntlProvider.js";
import { StoreProvider, useLCodeStore } from "@/store/StoreProvider.js";
import { OnboardingThemeSelector } from "@/onboarding/OnboardingThemeSelector.js";
import { ConversationDraftEmptyState } from "@/v4/ConversationDraftEmptyState.js";
import { ConversationTimeline } from "@/v4/ConversationTimeline.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { Textarea } from "@/components/ui/textarea.js";
import { Alert, AlertDescription } from "@/components/ui/alert.js";
import { Dialog, DialogTrigger, DialogContent, DialogTitle } from "@/components/ui/dialog.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu.js";
import { UI_FONT_SIZE_STORAGE_KEY } from "@/lib/uiFontSize.js";
import { QualityControls } from "./quality-controls.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import "./theme-quality.css";

const query = new URLSearchParams(location.search);
const nativePlatform = query.get("platform");
if (nativePlatform) {
  // 只用于检查生产窗口框架的三条 renderer 分支，不冒充对应 OS 的原生桥接。
  document.documentElement.removeAttribute("data-lcode-browser-theme-surface");
  document.documentElement.classList.add(`platform-${nativePlatform}-desktop`);
}
localStorage.setItem(UI_FONT_SIZE_STORAGE_KEY, query.get("font") || "14");
// 使用真实 store 的持久化/DOM 投影；BroadcastChannel 只替代 Host 的消息传输。
const transport = new BroadcastChannel("theme-quality");
let themeSendCount = 0;
const broadcastService = {
  send: async (message: BroadcastMessage) => {
    if (message.channel === "state:theme") {
      document.body.dataset.themeSendCount = String(++themeSendCount);
    }
    transport.postMessage(message);
  },
  onMessage: (listener: (message: BroadcastMessage) => void) => {
    const receive = (event: MessageEvent<BroadcastMessage>) => listener(event.data);
    transport.addEventListener("message", receive);
    return { dispose: () => transport.removeEventListener("message", receive) };
  },
} as unknown as IBroadcastService;

function Fixture() {
  const theme = useLCodeStore((state) => state.theme);
  const setTheme = useLCodeStore((state) => state.setTheme);
  const setInterfaceMode = useLCodeStore((state) => state.setInterfaceMode);
  const { intl } = useLCodeIntl();
  const english = query.has("english");
  if (query.has("controls")) {
    const content = <QualityControls english={english} />;
    return nativePlatform ? (
      <DesktopWindowFrame
        title="Platform quality"
        isDesktop
        isMacDesktop={nativePlatform === "mac"}
        isWindowsDesktop={nativePlatform === "windows"}
      >
        {content}
      </DesktopWindowFrame>
    ) : (
      content
    );
  }
  const label = english
    ? "A long control label for keyboard and large type"
    : "用于键盘与大字号验证的长控件文字";
  if (query.has("timeline")) {
    return (
      <main className="flex h-full min-h-0 flex-col bg-background text-ui-base text-foreground">
        <ConversationTimeline
          rows={[]}
          totalCount={0}
          sessionKey="draft"
          rowContext={{
            workspacePath: "/fixture",
            theme,
            codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
          }}
          centerEmptyStateWithDock
          compactEmptyStateWithDock={query.has("compact")}
          hideTurnNavigator
          emptyState={<ConversationDraftEmptyState />}
          bottomDock={
            <div className="space-y-2 rounded-2xl border border-input-border bg-input p-3">
              {query.has("stress") ? (
                <>
                  <div className="text-ui-caption text-foreground-subtle">
                    Quality project / workspace
                  </div>
                  <Textarea aria-label="Composer" placeholder={label} rows={3} />
                </>
              ) : (
                <Input aria-label="Composer" placeholder={label} />
              )}
              <div className="flex justify-end">
                <Button>{english ? "Send" : "发送"}</Button>
              </div>
              {query.has("stress") && (
                <div className="flex flex-wrap gap-2">
                  {["Summary", "Fix issue", "Slides", "Idle task"].map((name) => (
                    <Button key={name} variant="outline">
                      {name}
                    </Button>
                  ))}
                </div>
              )}
            </div>
          }
        />
      </main>
    );
  }
  return (
    <main className="h-full overflow-y-auto bg-background p-4 text-ui-base text-foreground">
      <section className="mx-auto flex min-h-[28rem] max-w-2xl flex-col items-center justify-center">
        <ConversationDraftEmptyState />
        <Input aria-label="Composer" placeholder={label} />
      </section>
      <section className="mx-auto max-w-2xl space-y-4">
        <OnboardingThemeSelector theme={theme} saving={false} onSelect={setTheme} />
        <div className="flex flex-wrap gap-2">
          <Button
            data-testid="primary"
            className="max-w-full whitespace-normal [overflow-wrap:anywhere]"
          >
            {label}
          </Button>
          <Button variant="secondary">{english ? "Secondary" : "次级操作"}</Button>
          <Button disabled>{english ? "Disabled" : "已禁用"}</Button>
          <Button onClick={() => setInterfaceMode("office")}>{english ? "Office" : "办公"}</Button>
          <Button onClick={() => setInterfaceMode("coding")}>{english ? "Coding" : "编码"}</Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button variant="outline">{english ? "Menu" : "菜单"}</Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent>
              <DropdownMenuItem>{label}</DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
          <Dialog>
            <DialogTrigger asChild>
              <Button variant="outline">{english ? "Dialog" : "弹窗"}</Button>
            </DialogTrigger>
            <DialogContent aria-describedby={undefined}>
              <DialogTitle>{intl.formatMessage({ id: "settings.themeMode" })}</DialogTitle>
              <Input aria-label="Dialog input" placeholder={label} />
            </DialogContent>
          </Dialog>
        </div>
        <Input aria-label="Quality input" defaultValue={label} />
        <Textarea aria-label="Quality textarea" placeholder={label} />
        <Alert variant="warning">
          <AlertDescription>{english ? "Attention required" : "需要关注"}</AlertDescription>
        </Alert>
        <Alert variant="destructive">
          <AlertDescription>{english ? "Operation failed" : "操作失败"}</AlertDescription>
        </Alert>
        <div className="overflow-x-auto rounded-lg border border-card-border bg-card">
          <table className="w-full text-left text-ui-base">
            <thead className="bg-header">
              <tr>
                <th className="p-2">{label}</th>
                <th className="p-2">Status</th>
              </tr>
            </thead>
            <tbody>
              <tr className="bg-selected">
                <td className="p-2">Selected row</td>
                <td className="p-2 text-success">Ready</td>
              </tr>
            </tbody>
          </table>
        </div>
        <div data-testid="dark-variant" className="bg-card dark:bg-primary">
          Theme projection
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <StoreProvider broadcastService={broadcastService}>
    <LCodeIntlProvider initialLocale={query.has("english") ? "en-US" : "zh-CN"}>
      <Fixture />
    </LCodeIntlProvider>
  </StoreProvider>,
);
