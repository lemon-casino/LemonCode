import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelSelection } from "@zcode/shared";
import type { ExecutionFailoverState } from "@zcode/shared/zcode-protocol-v4";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ExecutionSwitchStatus } from "./ExecutionSwitchStatus.js";

function renderStatus({
  locale,
  from,
  to,
  status = "active",
}: {
  locale: "zh-CN" | "en-US";
  from: ModelSelection;
  to: ModelSelection;
  status?: "waitingSafeBoundary" | "active";
}): string {
  const state: ExecutionFailoverState = {
    revision: 2,
    sourceCommandId: "command-1",
    modelSelection: to,
    foregroundExecutionId: "execution-1",
    targets: [
      {
        kind: "foregroundExecution",
        id: "execution-1",
        status,
        currentSelection: from,
      },
    ],
    ...(status === "active"
      ? {
          lastTransition: {
            targetKind: "foregroundExecution" as const,
            targetId: "execution-1",
            from,
            to,
            reasonCode: "userRequested" as const,
            attempt: 1,
            at: 1,
          },
        }
      : {}),
    updatedAt: 1,
  };

  return renderToStaticMarkup(
    <ZCodeIntlProvider initialLocale={locale}>
      <ExecutionSwitchStatus currentSelection={from} modelSelectionView={null} state={state} />
    </ZCodeIntlProvider>,
  );
}

test("distinguishes a same-model reasoning and speed switch in localized status text", () => {
  const markup = renderStatus({
    locale: "zh-CN",
    from: {
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high", speed: "standard" },
    },
    to: {
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "medium", speed: "fast" },
    },
  });

  assert.match(
    markup,
    /已安全切换：provider-a\/model-a（推理强度：高，速度：标准） → provider-a\/model-a（推理强度：中，速度：快速）/,
  );
});

test("keeps custom option values visible while waiting for the safe boundary", () => {
  const markup = renderStatus({
    locale: "en-US",
    status: "waitingSafeBoundary",
    from: {
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "high", speed: "standard" },
    },
    to: {
      providerId: "provider-a",
      modelId: "model-a",
      options: { reasoningLevel: "custom-depth", speed: "turbo" },
    },
  });

  assert.match(
    markup,
    /Current provider-a\/model-a \(reasoning: High, speed: Standard\) \/ switching to provider-a\/model-a \(reasoning: custom-depth, speed: turbo\) at the next safe step/,
  );
});
