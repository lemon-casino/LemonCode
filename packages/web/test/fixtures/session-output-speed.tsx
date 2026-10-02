/// <reference types="vite/client" />
import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { ConversationSnapshot } from "@lcode/shared/lcode-protocol-v4";
import type { LCodeProvider } from "@lcode/shared";
import { LCodeIntlProvider, useLCodeIntl } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ChatContextUsage } from "@/chat-input-toolbar/contextUsage.js";
import { ReadOnlySessionTokenStats } from "@/v4/composer/ReadOnlySessionTokenStats.js";
import { LiveOutputRateRegistry } from "@/v4/composer/liveOutputRateRegistry.js";
import { readSessionOutputSpeed } from "@/v4/composer/sessionOutputSpeed.js";
import {
  V4ConversationContext,
  type V4ConversationContextValue,
} from "@/v4/V4ConversationContext.js";
import "@lcode/ui/styles.css";

const rates = new LiveOutputRateRegistry();
const context = { layer: { liveOutputRates: rates } } as unknown as V4ConversationContextValue;
type Scenario = "pending" | "average" | "pending-average" | "live" | "completed" | "other";

function makeSnapshot(scenario: Scenario, tokens = 13): ConversationSnapshot {
  const average = !["pending", "other"].includes(scenario);
  return {
    sessionId: scenario === "other" ? "other-session" : "child-session",
    logEpoch: "epoch-one",
    control: { phase: scenario === "completed" ? "completedSuccess" : "running" },
    rows: {
      window: [
        {
          turnId: "turn-one",
          rowId: 1,
          ...(scenario === "live"
            ? {
                kind: "assistantText",
                state: "streaming",
                assistantResponseId: "response-two",
                text: "x".repeat(tokens * 3),
              }
            : { kind: "turnHeader" }),
        },
      ],
    },
    usage: {
      cumulative: { inputTokens: average ? 1_000 : 0, outputTokens: average ? 100 : 0 },
      contextWindow: null,
      modelOutput:
        scenario === "other"
          ? null
          : {
              turnId: "turn-one",
              activeRequestId: ["average", "completed"].includes(scenario) ? null : "request-two",
              lastRequest: average
                ? {
                    requestId: "request-one",
                    outputTokens: 100,
                    durationMs: 2_000,
                    completedAt: 100,
                  }
                : null,
            },
    },
  } as ConversationSnapshot;
}

function App() {
  const { intl, locale, setLocale } = useLCodeIntl();
  const [snapshot, setSnapshot] = useState(() => makeSnapshot("pending"));
  Object.assign(globalThis, {
    __speedFixture: {
      scenario: (scenario: Scenario) => {
        if (scenario === "live") rates.observe(makeSnapshot("live", 1), 1_000);
        const next = makeSnapshot(scenario);
        rates.observe(next, 1_600);
        setSnapshot(next);
      },
      locale: setLocale,
    },
  });
  const speed = readSessionOutputSpeed(snapshot, rates.read(snapshot));
  return (
    <div className="min-h-full max-w-full space-y-4 bg-background p-4 text-foreground">
      <div data-testid="parent" className="flex min-w-0 flex-wrap items-center">
        <ChatContextUsage
          taskUsage={null}
          sessionUsage={{ inputTokens: 0, outputTokens: 0 }}
          childUsage={{ ...snapshot.usage.cumulative, unknownCount: 0 }}
          childCount={1}
          childOutputSpeed={speed}
          selectedProvider={{} as LCodeProvider}
          intl={intl}
          locale={locale}
        />
      </div>
      <ReadOnlySessionTokenStats snapshot={snapshot} />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <LCodeIntlProvider initialLocale="zh-CN">
    <TooltipProvider>
      <V4ConversationContext value={context}>
        <App />
      </V4ConversationContext>
    </TooltipProvider>
  </LCodeIntlProvider>,
);
