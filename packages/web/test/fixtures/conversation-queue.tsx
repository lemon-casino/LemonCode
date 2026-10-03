/// <reference types="vite/client" />
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ExecutionFailoverState, QueueState } from "@lcode/shared/lcode-protocol-v4";
import { ConversationQueuePanel } from "@/v4/ConversationQueuePanel.js";
import { ExecutionSwitchStatus } from "@/v4/ExecutionSwitchStatus.js";
import { QueueSendNowError } from "@/v4/queueSendNowFailure.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { platform } from "./git-backup-platform.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import "@lcode/ui/styles.css";

let calls = 0;
let settle: ((fail: boolean, reason?: string) => void) | null = null;
let switchSession: () => void = () => undefined;
let showSwitch: (status: "waitingSafeBoundary" | "active" | null) => void = () => undefined;
const from = {
  providerId: "provider-a",
  modelId: "model-a",
  options: { reasoningLevel: "max", speed: "fast" },
};
const to = {
  providerId: "provider-b",
  modelId: "model-b",
  options: { reasoningLevel: "xhigh", speed: "fast" },
};
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
  const [switchStatus, setSwitchStatus] = useState<"waitingSafeBoundary" | "active" | null>(null);
  switchSession = () => setSession((s) => s + 1);
  showSwitch = setSwitchStatus;
  const switchState: ExecutionFailoverState | null = switchStatus
    ? {
        revision: 2,
        sourceCommandId: "switch",
        modelSelection: to,
        foregroundExecutionId: "execution",
        updatedAt: 1,
        targets: [
          {
            kind: "foregroundExecution",
            id: "execution",
            status: switchStatus,
            currentSelection: from,
          },
        ],
        ...(switchStatus === "active"
          ? {
              lastTransition: {
                targetKind: "foregroundExecution" as const,
                targetId: "execution",
                from,
                to,
                reasonCode: "userRequested" as const,
                attempt: 1,
                at: 1,
              },
            }
          : {}),
      }
    : null;
  return (
    <div className="w-full p-3">
      {switchState ? (
        <ExecutionSwitchStatus
          currentSelection={from}
          modelSelectionView={null}
          state={switchState}
        />
      ) : null}
      <ConversationQueuePanel
        key={session}
        queue={queue}
        onSendNow={async () => {
          calls += 1;
          await new Promise<void>((resolve, reject) => {
            settle = (fail, reason) =>
              fail
                ? reject(reason ? new QueueSendNowError(reason) : new Error("fixture failure"))
                : resolve();
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
    settle: (fail: boolean, reason?: string) => settle?.(fail, reason),
    switchSession: () => switchSession(),
    showSwitch: (status: "waitingSafeBoundary" | "active" | null) => showSwitch(status),
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
