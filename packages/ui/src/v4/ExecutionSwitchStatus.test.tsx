import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { ModelSelection } from "@lcode/shared";
import type { ExecutionFailoverState } from "@lcode/shared/lcode-protocol-v4";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
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
    <LCodeIntlProvider initialLocale={locale}>
      <ExecutionSwitchStatus currentSelection={from} modelSelectionView={null} state={state} />
    </LCodeIntlProvider>,
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
    /已切换：provider-a\/model-a（推理强度：高，速度：标准） → provider-a\/model-a（推理强度：中，速度：快速）/,
  );
});

test("explains immediate switching while retaining full custom model options", () => {
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
    /Switching: provider-a\/model-a \(reasoning: High, speed: Standard\) → provider-a\/model-a \(reasoning: custom-depth, speed: turbo\); finishing the old request or waiting for tools/,
  );
});
