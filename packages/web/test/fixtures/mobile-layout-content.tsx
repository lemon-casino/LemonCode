import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { V4ComposerDraft } from "@/v4/composer/composerDraftStore.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { DesktopWindowFrame } from "@/DesktopWindowFrame.js";
import { SettingsRow, SettingsGroupCard, ThemeSelect } from "@/settings/SettingsPageParts.js";
import { useLCodeStore } from "@/store/StoreProvider.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { ConversationComposer } from "@/v4/ConversationComposer.js";
import { ConversationRowView } from "@/v4/ConversationRowView.js";
import { ConversationTurnGroup } from "@/v4/ConversationTurnGroup.js";
import { buildConversationTurnRenderUnits } from "@/v4/conversationTurnRenderUnits.js";
import { ChatContextUsage } from "@/chat-input-toolbar/contextUsage.js";
import { GitActionMenu } from "@/GitActionMenu.js";
import { DEFAULT_CODE_PREVIEW_SETTINGS } from "@/lib/codePreviewSettings.js";
import { THEME_OPTIONS, type Theme } from "@/useTheme.js";
import {
  action,
  assistantRow,
  changed,
  conversation,
  conversationContext,
  counters,
  gitSummary,
  hookRow,
  modelView,
  noop,
  selection,
  snapshotRevision,
  subscribe,
  userRow,
  workspacePath,
} from "./mobile-layout-data.js";

const query = new URLSearchParams(location.search);
const initialTheme =
  THEME_OPTIONS.find((option) => option.id === query.get("theme"))?.id ?? "zai-light";
const initialDraft: V4ComposerDraft = {
  text: "未发送草稿 / retained draft",
  mode: "build",
  planEnabled: true,
  modelSelection: selection,
  updatedAt: 1,
};

export function Controls({ onSettings, onRows }: { onSettings: () => void; onRows: () => void }) {
  const { localePreference, setLocalePreference } = useLCodeIntl();
  const theme = useLCodeStore((state) => state.theme);
  const setTheme = useLCodeStore((state) => state.setTheme);
  const fontSize = useLCodeStore((state) => state.uiFontSizePx);
  const setFontSize = useLCodeStore((state) => state.setUiFontSizePx);
  useEffect(() => {
    setTheme(initialTheme);
    setFontSize(query.get("font") === "20" ? 20 : 14);
  }, [setTheme, setFontSize]);
  return (
    <div
      className="flex flex-wrap items-center gap-2 border-b border-border p-2 text-ui-sm"
      data-testid="fixture-controls"
    >
      <Button size="sm" variant="outline" onClick={onSettings}>
        Settings page / 设置页
      </Button>
      <Button size="sm" variant="outline" onClick={onRows}>
        Settings rows / 设置行
      </Button>
      <label>
        Language{" "}
        <select
          aria-label="Fixture language"
          value={localePreference}
          onChange={(event) => setLocalePreference(event.target.value as "en-US" | "zh-CN")}
        >
          <option value="zh-CN">中文</option>
          <option value="en-US">English</option>
        </select>
      </label>
      <label>
        Theme{" "}
        <select
          aria-label="Fixture theme"
          value={theme}
          onChange={(event) => setTheme(event.target.value as Theme)}
        >
          {THEME_OPTIONS.map((option) => (
            <option key={option.id} value={option.id}>
              {option.id}
            </option>
          ))}
        </select>
      </label>
      <label>
        UI px{" "}
        <select
          aria-label="Fixture font size"
          value={fontSize}
          onChange={(event) => setFontSize(Number(event.target.value))}
        >
          <option value={14}>14</option>
          <option value={20}>20</option>
        </select>
      </label>
    </div>
  );
}

export function RowsFixture({ onBack }: { onBack: () => void }) {
  const [value, setValue] = useState("Unsaved / 未保存");
  const [theme, setTheme] = useState<Parameters<typeof ThemeSelect>[0]["value"]>("github-light");
  return (
    <DesktopWindowFrame title="Settings rows">
      <div className="h-full overflow-y-auto p-4">
        <Button onClick={onBack}>Return / 返回</Button>
        <p className="py-3 text-ui-base">
          Production SettingsRow; the separate Settings page covers its real navigation rail and
          height.
        </p>
        <div className="mx-auto w-full max-w-3xl">
          <SettingsGroupCard>
            <SettingsRow
              label="Long translated setting label / 较长的设置名称"
              description="A complete description must be readable, without a forced 192px column squeezing it into one-character lines."
              control={<Button onClick={action}>Save configuration / 保存</Button>}
              detail={
                <Input
                  aria-label="Fixture settings draft"
                  value={value}
                  onChange={(event) => setValue(event.target.value)}
                />
              }
            />
            <SettingsRow
              controlLayout="wide"
              label="Wide control / 宽控件"
              description="Theme and an additional action stay within the actual content column."
              detail={<ThemeSelect value={theme} onValueChange={setTheme} />}
              control={<Button onClick={action}>Apply / 应用</Button>}
            />
          </SettingsGroupCard>
        </div>
      </div>
    </DesktopWindowFrame>
  );
}

export function FixtureConversation({
  openPreview,
  openTerminal,
}: {
  openPreview: () => void;
  openTerminal: () => void;
}) {
  useSyncExternalStore(subscribe, snapshotRevision, snapshotRevision);
  const { intl, locale } = useLCodeIntl();
  const theme = useLCodeStore((state) => state.theme);
  const [draft, setDraft] = useState<V4ComposerDraft>(initialDraft);
  const [running, setRunning] = useState(false);
  const [inputDisabled, setInputDisabled] = useState(false);
  const [identity, setIdentity] = useState("not recorded");
  const rootRef = useRef<HTMLDivElement>(null);
  const identities = useRef<Record<string, Element | null> | null>(null);
  const updateContent = useCallback(
    (content: Pick<V4ComposerDraft, "text" | "editorStateJson" | "mention">) =>
      setDraft((current) => ({ ...current, ...content })),
    [],
  );
  const replaceDraft = useCallback(
    (next: Omit<V4ComposerDraft, "updatedAt">) => setDraft({ ...next, updatedAt: 1 }),
    [],
  );
  const context = useMemo(
    () => ({
      workspacePath,
      sessionId: "mobile-fixture-session",
      theme,
      codePreviewSettings: DEFAULT_CODE_PREVIEW_SETTINGS,
    }),
    [theme],
  );
  const currentSnapshot = useMemo(
    () =>
      running
        ? {
            ...conversation,
            control: {
              ...conversation.control,
              phase: "running" as const,
              sessionEnded: false,
              canStop: true,
              stopState: "stoppable" as const,
            },
            inputRouting: { mode: "enqueue" as const },
          }
        : conversation,
    [running],
  );
  const turns = useMemo(
    () =>
      buildConversationTurnRenderUnits([userRow, assistantRow], {
        sessionPhase: "completedSuccess",
      }),
    [],
  );
  const hooks = useMemo(
    () =>
      buildConversationTurnRenderUnits(
        [
          { ...userRow, rowId: 3, entityId: "fixture-hook-user", turnId: "fixture-hook-turn" },
          hookRow,
        ],
        { sessionPhase: "completedSuccess" },
      ),
    [],
  );
  const sampleNodes = () => ({
    editor: rootRef.current?.querySelector('[data-lexical-editor="true"]') ?? null,
    preview: document.querySelector('[data-testid="preview-pane"]'),
    terminal: document.querySelector(".xterm"),
  });
  return (
    <div className="flex min-h-0 flex-1 flex-col" ref={rootRef}>
      <div
        className="min-h-0 min-w-0 flex-1 overflow-y-auto p-3"
        data-testid="fixture-conversation-scroll"
      >
        <div className="flex flex-wrap gap-2 py-2">
          <Button onClick={openPreview}>Open preview / 打开预览</Button>
          <Button onClick={openTerminal}>Side terminal / 侧栏终端</Button>
          <Button onClick={() => setInputDisabled((value) => !value)}>
            Toggle disabled / 输入门禁
          </Button>
          <Button onClick={() => setRunning((value) => !value)}>Toggle running / 运行态</Button>
          <Button
            onClick={() => {
              identities.current = sampleNodes();
              setIdentity(
                Object.entries(identities.current)
                  .map(([key, value]) => `${key}:${value ? "recorded" : "missing"}`)
                  .join(";"),
              );
            }}
          >
            Record nodes
          </Button>
          <Button
            onClick={() => {
              const nodes = sampleNodes();
              const before = identities.current;
              setIdentity(
                before
                  ? Object.entries(nodes)
                      .map(
                        ([key, value]) =>
                          `${key}:${before[key] && value ? before[key] === value : "missing"}`,
                      )
                      .join(";")
                  : "not recorded",
              );
            }}
          >
            Compare nodes
          </Button>
        </div>
        <output data-testid="fixture-identity" className="block break-words text-ui-sm">
          {identity}
        </output>
        <output data-testid="fixture-counters" className="block break-words text-ui-sm">
          {JSON.stringify(counters)}
        </output>
        <output data-testid="fixture-draft" className="block break-words text-ui-sm">
          {draft.text}
        </output>
        <ConversationRowView row={userRow} context={context} onEdit={action} />
        <ConversationRowView
          row={assistantRow}
          context={context}
          onFork={action}
          onFeedbackChange={action}
        />
        {turns.map((unit) => (
          <ConversationTurnGroup
            key={unit.key}
            unit={unit}
            context={context}
            onFork={action}
            onRetry={action}
          />
        ))}
        {hooks.map((unit) => (
          <ConversationTurnGroup key={unit.key} unit={unit} context={context} />
        ))}
        <div className="flex items-center gap-3 py-3" data-testid="fixture-long-overlays">
          <ChatContextUsage
            intl={intl}
            locale={locale}
            selectedProvider="glm"
            taskUsage={{
              used: 84000,
              size: 128000,
              breakdown: conversation.usage.contextWindow?.breakdown,
              cache: { hitRate: 0.92 },
            }}
            sessionUsage={conversation.usage.cumulative}
            childUsage={{ inputTokens: 230000, outputTokens: 70000, unknownCount: 0 }}
            childCount={8}
            childCurrentOutputTokens={8000}
            childLiveOutputRate={45}
            liveOutputRate={78}
          />
          <GitActionMenu
            workspacePath={workspacePath}
            gitSummary={gitSummary}
            onRefreshGit={noop}
          />
        </div>
        <p className="text-ui-sm">
          Extracted production shell geometry and controls; not App routing, real task index, Host,
          command admission or replay. Node checks require non-null nodes.
        </p>
      </div>
      <div className="shrink-0 min-w-0 p-2" data-testid="fixture-composer-dock">
        <ConversationComposer
          snapshot={currentSnapshot}
          sessionId="mobile-fixture-session"
          composerDraft={draft}
          draftConfig={{
            ...conversation.config,
            mode: draft.mode,
            planEnabled: draft.planEnabled,
            modelSelection: draft.modelSelection,
          }}
          updateComposerContent={updateContent}
          replaceComposerDraft={replaceDraft}
          disabled={inputDisabled}
          autoFocusEnabled
          workspacePath={workspacePath}
          provider="glm"
          modelSelectionView={modelView}
          modelSelectionState={{ status: "ready", view: modelView }}
          attachmentSessionId="mobile-fixture-session"
          attachmentPut={conversationContext.attachmentPut}
          onSendText={async () => {
            counters.sends++;
            changed();
          }}
          onStop={() => {
            counters.stops++;
            changed();
            setRunning(false);
          }}
          onSelectModel={noop}
          onSelectThought={(reasoningLevel) =>
            setDraft((current) => ({
              ...current,
              modelSelection: {
                ...selection,
                options: { ...current.modelSelection?.options, reasoningLevel },
              },
            }))
          }
          onSelectSpeed={(speed) =>
            setDraft((current) => ({
              ...current,
              modelSelection: {
                ...selection,
                options: { ...current.modelSelection?.options, speed },
              },
            }))
          }
          onSwitchMode={(mode) =>
            setDraft((current) =>
              mode === "plan" || mode === "plan-off"
                ? { ...current, planEnabled: mode === "plan" }
                : { ...current, mode: mode as V4ComposerDraft["mode"] },
            )
          }
          listenAddToChatEvents={false}
          runningSubagentCount={2}
          onOpenRunningBackgroundWorks={action}
        />
      </div>
    </div>
  );
}
