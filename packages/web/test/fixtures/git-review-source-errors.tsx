import { useState } from "react";
import { createRoot } from "react-dom/client";
import type { IBroadcastService, IServiceAccessor } from "@lcode/services";
import type { GitChangeSourceId, GitFileChange, GitRefreshResult } from "@lcode/shared";
import { GitPane } from "@/GitPane.js";
import { ServiceProvider } from "@/hooks/useServices.js";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { useGitRepository } from "@/hooks/useGitRepository.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { StoreProvider } from "@/store/StoreProvider.js";
import { TabStoreProvider } from "@/store/TabStoreProvider.js";
import { platform } from "./git-backup-platform.js";
import "@lcode/ui/styles.css";

type Mode = "missing" | "recovered" | "legacy" | "status-failure";
const workspacePath = "/fixture/repo";
let mode: Mode = "missing";

function change(sourceId: "unstaged" | "staged" | "branch"): GitFileChange {
  const path = `${sourceId}.txt`;
  return {
    path: `${workspacePath}/${path}`,
    repoRelativePath: path,
    workspaceRelativePath: path,
    kind: "modified",
    section: sourceId,
    added: 1,
    removed: 1,
    isStaged: sourceId === "staged",
    isUntracked: false,
    isConflicted: false,
  };
}

const services = {
  gitService: {
    refresh: async (): Promise<GitRefreshResult> => {
      if (mode === "status-failure") throw new Error("fixture local status failed");
      return {
        summary: {
          workspacePath,
          repoRoot: workspacePath,
          workspaceInRepoPath: "",
          autoRefreshWatchPaths: [],
          branchName: "L-GO",
          trackingBranchName: "origin/L-GO",
          headRefType: "branch",
          ahead: 0,
          behind: 0,
          isDirty: true,
          isGitAvailable: true,
          isRepository: true,
        },
        identity: null,
        unstagedChanges: [change("unstaged")],
        stagedChanges: [change("staged")],
        branchComparison:
          mode === "missing"
            ? null
            : {
                baseRef: "origin/L-GO",
                headRef: "HEAD",
                comparisonLabel: "origin/L-GO...HEAD",
                changes: [change("branch")],
              },
        ...(mode === "missing"
          ? {
              branchComparisonError:
                "git diff --numstat upstream...HEAD failed: fatal: bad revision 'origin/L-GO...HEAD'",
            }
          : {}),
      };
    },
    getDiff: async ({ path, sourceId }: { path: string; sourceId: string }) => ({
      path,
      availability: "patch",
      beforeContent: null,
      afterContent: null,
      patch: `diff --git a/${sourceId}.txt b/${sourceId}.txt\n--- a/${sourceId}.txt\n+++ b/${sourceId}.txt\n@@ -1 +1 @@\n-old\n+${sourceId} content\n`,
    }),
  },
} as unknown as IServiceAccessor;
const broadcastService = {
  send: async () => {},
  onMessage: () => () => {},
} as unknown as IBroadcastService;

declare global {
  interface Window {
    __gitReviewSourceFixture: { setMode: (next: Mode) => void };
  }
}

function FixtureApp() {
  const [source, setSource] = useState<GitChangeSourceId>("unstaged");
  const [refreshToken, setRefreshToken] = useState(0);
  const gitState = useGitRepository({
    workspacePath,
    activeTaskId: null,
    includeExtendedData: true,
    refreshToken,
  });
  window.__gitReviewSourceFixture = {
    setMode: (next) => {
      mode = next;
      setRefreshToken((current) => current + 1);
    },
  };
  return (
    <div style={{ height: "100dvh" }}>
      <GitPane
        workspacePath={workspacePath}
        gitState={gitState}
        selectedSourceId={source}
        fileChangeFindActiveIndex={0}
        fileChangeFindNavigationRequestId={0}
        fileChangeFindQuery=""
        onFileChangeFindMatchCountChange={() => {}}
        onSelectSource={setSource}
        onClose={() => {}}
        onRefresh={() => setRefreshToken((current) => current + 1)}
      />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(
  <ServiceProvider services={services}>
    <PlatformProvider platform={platform}>
      <StoreProvider broadcastService={broadcastService}>
        <TabStoreProvider>
          <LCodeIntlProvider
            initialLocale={new URLSearchParams(location.search).has("english") ? "en-US" : "zh-CN"}
          >
            <FixtureApp />
          </LCodeIntlProvider>
        </TabStoreProvider>
      </StoreProvider>
    </PlatformProvider>
  </ServiceProvider>,
);
