import { useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import { GIT_NOT_AVAILABLE_ERROR_CODE, type GitRepositorySummary } from "@lcode/shared";
import type { IModelSelectionService } from "@lcode/services";
import { WorkspaceGitDependencyNotice } from "@/GitDependencyNotice.js";
import { ModelSelectionLoadErrorNotice } from "@/root/ModelSelectionLoadErrorNotice.js";
import { useModelSelectionServiceView } from "@/hooks/useModelSelectionView.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { applyTheme } from "@/useTheme.js";
import "@/styles.css";

const english = new URLSearchParams(location.search).has("english");
applyTheme(english ? "zai-dark" : "zai-light");
const workspacePath = "/fixture/linux-project";
const workspaceIdentity = "fixture-linux-host";
const summary: GitRepositorySummary = {
  workspacePath,
  repoRoot: workspacePath,
  workspaceInRepoPath: ".",
  autoRefreshWatchPaths: [],
  branchName: null,
  trackingBranchName: null,
  headRefType: "branch",
  ahead: 0,
  behind: 0,
  isDirty: false,
  isGitAvailable: false,
  isRepository: false,
};
const fixture = { scenario: (_value: string) => {}, recovered: false, reads: 0 };
declare global {
  interface Window {
    __missingGitFixture: typeof fixture;
  }
}
window.__missingGitFixture = fixture;

function Fixture() {
  const [scenario, setScenario] = useState("missing");
  fixture.scenario = (value) => {
    fixture.recovered = false;
    setScenario(value);
  };
  const modelService = useMemo<IModelSelectionService>(
    () => ({
      onDidChange: () => ({ dispose() {} }),
      getView: async () => {
        fixture.reads++;
        if (!fixture.recovered) {
          if (scenario === "model-git")
            throw Object.assign(new Error("fixture dependency unavailable"), {
              code: GIT_NOT_AVAILABLE_ERROR_CODE,
            });
          throw new Error(
            scenario === "model-message-only"
              ? "Git binary is not available"
              : "fixture model config invalid",
          );
        }
        return { revision: 1, providers: [] };
      },
    }),
    [scenario],
  );
  const modelRead = useModelSelectionServiceView(modelService, scenario.startsWith("model-"));
  return (
    <LCodeIntlProvider initialLocale={english ? "en-US" : "zh-CN"}>
      <main className="flex h-dvh min-h-0 flex-col text-ui-base">
        <span data-testid="model-status">{modelRead.state.status}</span>
        {modelRead.state.status === "error" ? (
          <ModelSelectionLoadErrorNotice error={modelRead.state.error} onRetry={modelRead.reload} />
        ) : !scenario.startsWith("model-") ? (
          <WorkspaceGitDependencyNotice
            workspacePath={workspacePath}
            workspaceIdentity={workspaceIdentity}
            state={{
              workspaceKey: scenario === "stale" ? "another-host" : workspaceIdentity,
              summary: {
                ...summary,
                workspacePath: scenario === "old-path" ? "/fixture/old" : workspacePath,
                isGitAvailable: scenario === "present",
              },
              loading: scenario === "loading",
              revision: scenario === "unread" ? 0 : 1,
              error: scenario === "unavailable" ? "fixture disconnected" : null,
            }}
          />
        ) : null}
        <textarea
          aria-label="Draft"
          className="mt-auto rounded-md border border-border bg-input p-2 text-mobile-input-safe md:text-ui-base"
        />
      </main>
    </LCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
