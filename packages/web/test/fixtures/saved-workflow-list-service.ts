import type { IServiceAccessor, LCodeAgentSavedWorkflowTarget } from "@lcode/services";
import type { LCodeWorkflowsListResult } from "@lcode/shared";

export type ListScenario = "error" | "empty" | "invalid" | "success" | "pending";
export const workspacePath = "/fixture/saved-workflows";

let scenario: ListScenario = "error";
let queued: Array<(result: LCodeWorkflowsListResult) => void> = [];

function resultFor(
  target: LCodeAgentSavedWorkflowTarget,
  selected: ListScenario,
): LCodeWorkflowsListResult {
  const scope = target.scope === "global" ? "global" : "project";
  const dir =
    scope === "global" ? "/fixture/global/workflows" : `${workspacePath}/.lcode/workflows`;
  const entry = {
    name: `${scope}-review`,
    description: "Reusable review template",
    scope,
    path: `${dir}/${scope}-review.dwf.ts`,
  };
  return {
    workflows: selected === "success" ? [entry] : [],
    invalid:
      selected === "invalid"
        ? [{ path: `${dir}/broken.dwf.ts`, reason: "Invalid template metadata" }]
        : [],
    dir,
  };
}

export function selectScenario(next: ListScenario) {
  scenario = next;
}

export function releaseOldEmptyResults() {
  const current = queued;
  queued = [];
  for (const resolve of current) resolve({ workflows: [], invalid: [], dir: "/fixture/old-empty" });
  return current.length;
}

// 仅替换服务边界，不写模板文件、不启动模型或工作流。
export const services = {
  lcodeAgentService: {
    listSavedWorkflows: async (target: LCodeAgentSavedWorkflowTarget) => {
      if (scenario === "error") throw new Error("Saved-template request failed");
      if (scenario === "pending")
        return new Promise<LCodeWorkflowsListResult>((resolve) => queued.push(resolve));
      return resultFor(target, scenario);
    },
    listSavedWorkflowRuns: async () => ({ runs: [] }),
  },
  fileWatcherService: {
    watch: async () => ({ id: "saved-workflow-fixture-watch" }),
    unwatch: async () => undefined,
    onDynamicChange: () => () => ({ dispose() {} }),
  },
} as unknown as IServiceAccessor;
