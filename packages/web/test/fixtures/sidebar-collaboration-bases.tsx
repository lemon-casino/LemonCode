import type { IServiceAccessor } from "@lcode/services";
import { buildRemoteWorkspaceIdentity } from "@lcode/shared";
import { useWorktreeCapabilities } from "@/hooks/useWorktreeCapabilities.js";
import { CollaborationBasePicker } from "@/worktree/CollaborationBasePicker.js";
import { useDraftExecutionStore } from "@/store/draftExecutionStore.js";
import { Button } from "@/components/ui/button.js";
import { DraftExecutionSetPreparation } from "@/worktree/DraftExecutionSetPreparation.js";
import { DraftWorkspaceExecutionControls } from "@/worktree/DraftWorkspaceExecutionControls.js";
const origin = "/fixture/repo";
const identity = new URLSearchParams(location.search).has("remote-bases")
  ? buildRemoteWorkspaceIdentity(origin, {
      kind: "ssh",
      host: "fixture.invalid",
      username: "fixture",
      port: 22,
    })
  : undefined;
const scope = identity || origin;
export function installSidebarBasesFixture(
  services: IServiceAccessor,
  calls: { method: string; params: unknown }[],
) {
  if (!new URLSearchParams(location.search).has("bases")) return;
  if (new URLSearchParams(location.search).has("missing-base")) {
    const service = services.projectExecutionSetService!;
    const list = service.list.bind(service);
    service.list = async (request) =>
      (await list(request)).map((snapshot) => ({
        ...snapshot,
        requestId: "submitted",
        status: "failed",
        repositories: [],
        preflightFailure: {
          memberId: "member-1",
          sourcePath: `${origin}/contracts`,
          error: `${origin}/contracts: folder is absent from the selected Git base`,
        },
      }));
  }
  const get = services.settingService.get.bind(services.settingService);
  services.settingService.get = async () => ({
    ...(await get()),
    projectDefinitions: {
      version: 1,
      projects: [
        {
          id: "bases",
          revision: 1,
          name: "协作基线项目",
          primaryFolderPath: origin,
          workspaceIdentity: identity,
          sourceFolderPaths: [origin, `${origin}/contracts`, "/fixture/backend"],
          members: [origin, `${origin}/contracts`, "/fixture/backend"].map((path, index) => ({
            id: `member-${index}`,
            path,
            enabled: true,
            role: "custom",
            label: "",
            description: "",
          })),
        },
      ],
    },
  });
  services.worktreeService!.getCapabilities = async (request) => {
    calls.push({ method: "baseCapabilities", params: request });
    return {
      supported: true,
      create: true,
      integrate: true,
      archive: true,
      restore: true,
      repositoryRoot: request.workspacePath.startsWith(origin) ? origin : "/fixture/backend",
      currentBranch: "main",
    };
  };
  services.gitService.getLocalBranches = async (request) => {
    calls.push({ method: "baseBranches", params: request });
    return {
      headRefType: "branch",
      currentBranchName: "main",
      branches: ["main", request.workspacePath === origin ? "frontend-base" : "backend-base"].map(
        (name) => ({
          name,
          isCurrent: name === "main",
          upstreamName: null,
          commitHash: "a".repeat(40),
          commitTimestampMs: 1,
        }),
      ),
    };
  };
}
export function SidebarBasesFixture() {
  const capability = useWorktreeCapabilities(origin, identity);
  const draft = useDraftExecutionStore((state) => state.drafts[scope]);
  return (
    <div
      className="fixed bottom-8 left-84 right-4 rounded-xl bg-surface p-4 max-sm:left-4"
      data-testid="sidebar-bases-harness"
    >
      <CollaborationBasePicker
        repositories={capability.repositories ?? []}
        baseRefs={draft?.baseRefs}
        frozen={Boolean(draft?.frozen)}
        supported={Boolean(capability.capabilities?.create)}
        onChoose={(baseRefs) => useDraftExecutionStore.getState().choose(scope, { baseRefs })}
        onRefreshGit={() => {}}
      />
      <Button onClick={() => useDraftExecutionStore.getState().begin(scope, "submitted")}>
        冻结选择
      </Button>
      <output data-testid="base-selection">{JSON.stringify(draft?.baseRefs ?? {})}</output>
      <Button
        onClick={() => {
          useDraftExecutionStore.getState().reset(scope);
          useDraftExecutionStore.getState().choose(scope, { executionSetId: "a".repeat(32) });
        }}
      >
        使用已有工作集
      </Button>
      {draft?.executionSetId ? (
        <DraftWorkspaceExecutionControls
          workspacePath={origin}
          workspaceIdentity={identity}
          gitSummary={{
            workspacePath: origin,
            repoRoot: origin,
            workspaceInRepoPath: "",
            autoRefreshWatchPaths: [],
            branchName: "main",
            trackingBranchName: null,
            headRefType: "branch",
            ahead: 0,
            behind: 0,
            isDirty: false,
            isGitAvailable: true,
            isRepository: true,
          }}
          dirtyFileCount={0}
          onRefreshGit={() => {}}
        />
      ) : null}
      {new URLSearchParams(location.search).has("missing-base") ? (
        <DraftExecutionSetPreparation workspacePath={origin} />
      ) : null}
    </div>
  );
}
