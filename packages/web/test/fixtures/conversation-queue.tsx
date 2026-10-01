/// <reference types="vite/client" />
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { QueueState } from "@lcode/shared/lcode-protocol-v4";
import { ConversationQueuePanel } from "@/v4/ConversationQueuePanel.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { platform } from "./git-backup-platform.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import "@lcode/ui/styles.css";

let calls = 0;
let settle: ((fail: boolean) => void) | null = null;
let switchSession: () => void = () => undefined;
const queue: QueueState = {
  autoDrain: true,
  items: [
    {
      queueItemId: "queued",
      sourceCommandId: "original",
      clientId: "client",
      kind: "sendText",
      text: "使用新模型完成工作流头像替换",
      attachments: [],
      modelSelection: {
        providerId: "provider-b",
        modelId: "model-b",
        options: { reasoningLevel: "max", speed: "fast" },
      },
      admittedAt: 1,
      order: { admissionSeq: 1, queuePosition: 0 },
      delivery: { requested: "queue", admitted: "queue" },
      steer: { state: "notRequested" },
      dispatch: { state: "queued" },
    },
  ],
};

function App() {
  const [session, setSession] = useState(1);
  switchSession = () => setSession((s) => s + 1);
  return (
    <div className="w-full p-3">
      <ConversationQueuePanel
        key={session}
        queue={queue}
        onSendNow={async () => {
          calls += 1;
          await new Promise<void>((resolve, reject) => {
            settle = (fail) => (fail ? reject(new Error("fixture failure")) : resolve());
          });
        }}
        onEditItem={() => undefined}
        onDeleteItem={() => undefined}
      />
    </div>
  );
}

Object.assign(globalThis, {
  __queueFixture: {
    calls: () => calls,
    settle: (fail: boolean) => settle?.(fail),
    switchSession: () => switchSession(),
  },
});
createRoot(document.getElementById("root")!).render(
  <PlatformProvider platform={platform}>
    <LCodeIntlProvider defaultLocale="zh-CN">
      <TooltipProvider>
        <App />
      </TooltipProvider>
    </LCodeIntlProvider>
  </PlatformProvider>,
);
