import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { IServiceAccessor } from "@lcode/services";
import type { LCodeSavedWorkflowEntry, Locale } from "@lcode/shared";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import enUS from "@/i18n/locales/en-US.js";
import zhCN from "@/i18n/locales/zh-CN.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import {
  selectSavedWorkflowState,
  useSavedWorkflowStore,
  type SavedWorkflowWorkspaceState,
} from "@/store/savedWorkflowStore.js";
import { SavedWorkflowGlobalGroup } from "./SavedWorkflowGlobalGroup.js";
import { SavedWorkflowProjectGroup } from "./SavedWorkflowProjectGroup.js";

const project = { workspacePath: "/fixture/project", label: "Fixture Project" };
const workflow: LCodeSavedWorkflowEntry = {
  name: "review-template",
  description: "Review the selected files",
  scope: "project",
  path: "/fixture/project/.lcode/workflows/review-template.dwf.ts",
};
const services = {
  lcodeAgentService: {
    listSavedWorkflows: async () => ({ workflows: [], invalid: [], dir: "/fixture/workflows" }),
    listSavedWorkflowRuns: async () => ({ runs: [] }),
  },
  fileWatcherService: {
    watch: async () => ({ id: "fixture-watch" }),
    unwatch: async () => undefined,
    onDynamicChange: () => () => ({ dispose() {} }),
  },
} as unknown as IServiceAccessor;
const commonProps = {
  refreshSeq: 0,
  mode: { kind: "list" } as const,
  onStateChange() {},
  onOpenDetail() {},
  onBack() {},
};

function snapshot(
  overrides: Partial<SavedWorkflowWorkspaceState> = {},
): SavedWorkflowWorkspaceState {
  return { ...selectSavedWorkflowState(useSavedWorkflowStore.getState(), null), ...overrides };
}

function renderGroup(
  scope: "project" | "global",
  state: SavedWorkflowWorkspaceState,
  locale: Locale = "en-US",
) {
  // Zustand 的 SSR 读取初始快照；只替换测试输入，保留真实组、hook 与服务 provider。
  const initial = useSavedWorkflowStore.getInitialState();
  const previous = initial.byWorkspaceKey;
  initial.byWorkspaceKey = { [scope === "global" ? "global" : project.workspacePath]: state };
  try {
    return renderToStaticMarkup(
      <LCodeIntlProvider initialLocale={locale}>
        <ServiceProvider services={services}>
          <TabStoreProvider>
            <TooltipProvider>
              {scope === "project" ? (
                <SavedWorkflowProjectGroup {...commonProps} project={project} isCurrent />
              ) : (
                <SavedWorkflowGlobalGroup
                  {...commonProps}
                  localProjects={[project]}
                  activeProjectKey={project.workspacePath}
                  onMoved={() => {}}
                />
              )}
            </TooltipProvider>
          </TabStoreProvider>
        </ServiceProvider>
      </LCodeIntlProvider>,
    );
  } finally {
    initial.byWorkspaceKey = previous;
  }
}

afterEach(() => {
  useSavedWorkflowStore.setState({ byWorkspaceKey: {} });
});

for (const [locale, messages] of [
  ["en-US", enUS],
  ["zh-CN", zhCN],
] as const) {
  const message = (key: string) => {
    const value = messages[key];
    assert.ok(typeof value === "string", `Missing locale entry: ${key}`);
    return value;
  };
  test(`${locale}: first project failure is visible instead of hidden as empty`, () => {
    const markup = renderGroup(
      "project",
      snapshot({ loaded: true, error: "listing unavailable" }),
      locale,
    );
    assert.match(markup, /listing unavailable/);
    assert.match(markup, /role="alert"/);
    assert.ok(
      markup.includes(message("workflows.hub.loadError").replace("{error}", "listing unavailable")),
    );
  });

  test(`${locale}: global loading before and during the first request never says empty`, () => {
    for (const loading of [false, true]) {
      const markup = renderGroup("global", snapshot({ loading }), locale);
      assert.ok(!markup.includes(message("workflows.hub.global.empty")));
      assert.match(markup, /role="status"/);
      assert.ok(markup.includes(message("workflows.hub.loading")));
    }
  });

  test(`${locale}: only successfully completed empty results show the empty presentation`, () => {
    const empty = snapshot({ loaded: true });
    assert.equal(renderGroup("project", empty, locale), "");
    assert.ok(renderGroup("global", empty, locale).includes(message("workflows.hub.global.empty")));
    for (const scope of ["project", "global"] as const) {
      const retry = renderGroup(scope, { ...empty, loading: true }, locale);
      assert.match(retry, /role="status"/);
      assert.ok(!retry.includes(message("workflows.hub.global.empty")));
    }
  });

  test(`${locale}: invalid-only results show the reason, not an empty directory`, () => {
    const invalid = [{ path: "/fixture/workflows/broken.dwf.ts", reason: "invalid metadata" }];
    for (const scope of ["project", "global"] as const) {
      const markup = renderGroup(scope, snapshot({ loaded: true, invalid }), locale);
      assert.match(markup, /data-workflows-invalid="true"/);
      assert.match(markup, /invalid metadata/);
      assert.ok(!markup.includes(message("workflows.hub.global.empty")));
    }
  });

  test(`${locale}: cached cards do not hide refresh errors or retry loading`, () => {
    for (const scope of ["project", "global"] as const) {
      for (const loading of [false, true]) {
        const markup = renderGroup(
          scope,
          snapshot({
            loaded: true,
            loading,
            entries: [{ ...workflow, scope }],
            error: "refresh unavailable",
          }),
          locale,
        );
        assert.match(markup, /data-workflow-name="review-template"/);
        assert.match(markup, /refresh unavailable/);
        assert.match(markup, /role="alert"/);
        if (loading) assert.match(markup, /role="status"/);
        assert.ok(!markup.includes(message("workflows.hub.global.empty")));
      }
    }
  });

  test(`${locale}: unsupported global requests remain visible even with cached entries`, () => {
    for (const entries of [[], [{ ...workflow, scope: "global" as const }]]) {
      const markup = renderGroup(
        "global",
        snapshot({
          loaded: true,
          entries,
          error: "unsupported scope",
          errorCode: -32602,
        }),
        locale,
      );
      assert.ok(markup.includes(message("workflows.hub.global.unsupported")));
      assert.match(markup, /role="alert"/);
      assert.ok(!markup.includes(message("workflows.hub.global.empty")));
    }
  });
}

for (const scope of ["project", "global"] as const) {
  test(`${scope}: actual store retry, recovery and cached refresh failure render truthfully`, async () => {
    const target = scope === "global" ? { scope } : project;
    const replies: Array<"error" | "success"> = ["error", "success", "error"];
    const agentService = {
      ...services.lcodeAgentService,
      listSavedWorkflows: async () => {
        if (replies.shift() === "error") throw new Error("temporary list failure");
        return { workflows: [{ ...workflow, scope }], invalid: [], dir: "/fixture/workflows" };
      },
    };
    const current = () => selectSavedWorkflowState(useSavedWorkflowStore.getState(), target);
    const refresh = () =>
      useSavedWorkflowStore.getState().load(target, agentService, { bypassCache: true });
    await refresh();
    const failure = renderGroup(scope, current());
    const pending = refresh();
    const retry = renderGroup(scope, current());
    await pending;
    const recovered = renderGroup(scope, current());
    await refresh();
    const cachedFailure = renderGroup(scope, current());
    assert.match(failure, /temporary list failure/);
    assert.match(retry, /role="status"/);
    assert.match(recovered, /data-workflow-name="review-template"/);
    assert.doesNotMatch(recovered, /temporary list failure|role="alert"|role="status"/);
    assert.match(cachedFailure, /temporary list failure/);
    assert.match(cachedFailure, /data-workflow-name="review-template"/);
    assert.match(cachedFailure, /role="alert"/);
  });
}
