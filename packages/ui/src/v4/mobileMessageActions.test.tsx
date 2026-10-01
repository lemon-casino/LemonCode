import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AssistantTextRow,
  HookInvocationRow,
  UserInputRow,
} from "@lcode/shared/lcode-protocol-v4";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import type { ConversationRowRenderContext } from "./conversationRowContext.js";

// SSR 仅检查真实消息组件的动作接线与资格，不声称证明了触控可见性或可点击几何。
registerHooks({
  load(url, context, nextLoad) {
    if (/\.(?:svg|gif|jpe?g|png|webp)(?:\?[^/]*)?$/.test(url)) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(url)};`,
      };
    }
    return nextLoad(url, context);
  },
});

const { ConversationRowView } = await import("./ConversationRowView.js");
const { ConversationTurnGroup } = await import("./ConversationTurnGroup.js");
const { buildConversationTurnRenderUnits } = await import("./conversationTurnRenderUnits.js");

const context: ConversationRowRenderContext = {
  workspacePath: "C:/mobile-layout-fixture",
  workspaceIdentity: "fixture-workspace",
  sessionId: "fixture-session",
  theme: "zai-light",
  codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
};
const user: UserInputRow = {
  kind: "userInput",
  rowId: 1,
  entityId: "user-1",
  turnId: "turn-1",
  createdAt: 1,
  createdAtSeq: 1,
  origin: "realUser",
  text: "手机草稿消息",
  actions: { canEdit: true },
};
const assistant: AssistantTextRow = {
  kind: "assistantText",
  rowId: 2,
  entityId: "assistant-2",
  turnId: "turn-1",
  createdAt: 2,
  createdAtSeq: 2,
  state: "complete",
  text: "已完成",
  actions: { canFork: true, canRetry: true },
};
const hook: HookInvocationRow = {
  kind: "hookInvocation",
  rowId: 3,
  entityId: "hook-3",
  turnId: "turn-1",
  createdAt: 3,
  createdAtSeq: 3,
  hookInvocationId: "hook-invocation-3",
  hookEventName: "Stop",
  hookCount: 1,
  state: "completed",
  startedAt: 3,
  lane: "assistantWork",
  executions: [
    {
      hookRunId: "hook-run-3",
      hookIndex: 0,
      didExecute: true,
      state: "completed",
      outcome: "success",
      startedAt: 3,
      displayName: "fixture hook",
      sourceKind: "project",
    },
  ],
};

function render(children: ReactNode) {
  return renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="en-US">
      <TooltipProvider>{children}</TooltipProvider>
    </LCodeIntlProvider>,
  );
}

function assertTouchActionContract(markup: string, hoverGroup: string) {
  const actionClasses = [...markup.matchAll(/class="([^"]*)"/g)]
    .map((match) => match[1]!)
    .find((className) => className.includes(`group-hover/${hoverGroup}:opacity-100`));
  assert.ok(actionClasses, `the ${hoverGroup} action container is rendered`);
  assert.ok(actionClasses.includes("[@media(hover:none)]:opacity-100"));
  assert.ok(actionClasses.includes("opacity-0"), "fine-pointer hover behavior is retained");
  assert.ok(actionClasses.includes("focus-within:opacity-100"));
}

test("user row keeps copy/edit and exposes their container on no-hover devices", () => {
  const markup = render(
    <ConversationRowView row={user} context={context} onEdit={() => undefined} />,
  );
  assertTouchActionContract(markup, "user-row");
  assert.match(markup, /data-testid="v4-copy-1"/);
  assert.match(markup, /data-testid="v4-edit-1"/);
  const readonly = render(<ConversationRowView row={user} context={context} />);
  assert.doesNotMatch(readonly, /data-testid="v4-edit-1"/);
});

test("assistant row exposes completed actions without adding streaming actions", () => {
  const markup = render(
    <ConversationRowView
      row={assistant}
      context={context}
      onFork={() => undefined}
      onFeedbackChange={() => undefined}
    />,
  );
  assertTouchActionContract(markup, "assistant-row");
  assert.match(markup, /data-testid="v4-copy-2"/);
  const streaming = render(
    <ConversationRowView row={{ ...assistant, state: "streaming" }} context={context} />,
  );
  assert.doesNotMatch(streaming, /data-testid="v4-copy-2"/);
});

test("turn-tail actions are touch-visible and retain CLI fork eligibility", () => {
  const unit = buildConversationTurnRenderUnits([user, assistant], {
    sessionPhase: "completedSuccess",
  })[0]!;
  const markup = render(
    <ConversationTurnGroup unit={unit} context={context} onFork={() => undefined} />,
  );
  assertTouchActionContract(markup, "assistant-turn");
  assert.match(markup, /data-testid="v4-fork-2"/);
  const ineligible = buildConversationTurnRenderUnits(
    [user, { ...assistant, actions: undefined }],
    {
      sessionPhase: "completedSuccess",
    },
  )[0]!;
  assert.doesNotMatch(
    render(<ConversationTurnGroup unit={ineligible} context={context} onFork={() => undefined} />),
    /data-testid="v4-fork-2"/,
  );
});

test("hook-only turns expose actions only for completed eligible executed hooks", () => {
  const unit = buildConversationTurnRenderUnits([user, hook], {
    sessionPhase: "completedSuccess",
  })[0]!;
  const markup = render(<ConversationTurnGroup unit={unit} context={context} />);
  assertTouchActionContract(markup, "assistant-turn");
  assert.match(markup, /data-testid="v4-hook-details-trigger-turn-1"/);
  for (const ineligible of [
    { ...unit, isRunning: true },
    { ...unit, timelineOnly: true },
    { ...unit, hookInvocations: [{ ...hook, executions: [] }] },
  ]) {
    assert.doesNotMatch(
      render(<ConversationTurnGroup unit={ineligible} context={context} />),
      /data-testid="v4-hook-details-trigger-turn-1"/,
    );
  }
});
