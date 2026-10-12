import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationShareAccessMode } from "@lcode/shared";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ConversationShareConfirmationDock } from "@/v4/ConversationShareConfirmationDock.js";
import "@lcode/ui/styles.css";

// C04：分享确认 dock 的控件迁移契约。dock 只负责展示与单次事件适配，
// title/同意状态/权限的草稿所有者在本 fixture（与生产父级一致），提交 spy 记录在 window.__share。
const bridge = {
  titleChanges: [] as string[],
  consentChanges: [] as boolean[],
  accessChanges: [] as string[],
  confirms: 0,
  backs: 0,
  cancels: 0,
};
Object.assign(window, { __share: bridge });

function Fixture() {
  const [title, setTitle] = useState("Share");
  const [disclosureAccepted, setDisclosureAccepted] = useState(false);
  const [accessMode, setAccessMode] = useState<ConversationShareAccessMode>("public_importable");
  return (
    <main className="flex min-h-dvh items-start justify-center bg-background p-4 text-ui-base text-foreground">
      <div data-testid="fixture-ready" className="h-px w-px" />
      <div className="w-full max-w-xl">
        <ConversationShareConfirmationDock
          selectedCount={2}
          totalCount={5}
          title={title}
          accessMode={accessMode}
          disclosureAccepted={disclosureAccepted}
          onTitleChange={(next) => {
            bridge.titleChanges.push(next);
            setTitle(next);
          }}
          onDisclosureAcceptedChange={(accepted) => {
            bridge.consentChanges.push(accepted);
            setDisclosureAccepted(accepted);
          }}
          onAccessModeChange={(next) => {
            bridge.accessChanges.push(next);
            setAccessMode(next);
          }}
          onCancel={() => {
            bridge.cancels += 1;
          }}
          onBack={() => {
            bridge.backs += 1;
          }}
          onConfirm={() => {
            bridge.confirms += 1;
          }}
        />
      </div>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(
  <LCodeIntlProvider initialLocale="zh-CN">
    <TooltipProvider>
      <Fixture />
    </TooltipProvider>
  </LCodeIntlProvider>,
);
