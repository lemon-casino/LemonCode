import type { SessionModePort } from "./deps.js";
import type { AgentRuntimeInternal } from "./internal.js";
import { applyRuntimeExecutionState, readRuntimeExecutionState } from "./execution-state.js";

export function createRuntimeSessionModePort(runtime: AgentRuntimeInternal): SessionModePort {
  return {
    supportsPermissionFullAccess: () => Boolean(runtime.sessionStore?.commitPermissionFullAccess),
    getMode: () => runtime.config.mode ?? "build",
    getPrePlanMode: () => undefined,
    isPlanEnabled: () => readRuntimeExecutionState(runtime).planEnabled,
    async enterPlanMode(input) {
      const previous = readRuntimeExecutionState(runtime);
      const next = await applyRuntimeExecutionState(
        runtime,
        { planEnabled: true },
        { ...input, source: "tool" },
      );
      return { ...next, previousMode: previous.mode, previousPlanEnabled: previous.planEnabled };
    },
    async exitPlanMode(input) {
      const previous = readRuntimeExecutionState(runtime);
      if (!previous.planEnabled) {
        throw new Error(
          "You are not in plan mode. This tool is only for exiting plan mode after writing a plan. If your plan was already approved, continue with implementation.",
        );
      }

      const next = await applyRuntimeExecutionState(
        runtime,
        { planEnabled: false },
        { ...input, source: "tool" },
      );
      return { ...next, previousMode: previous.mode, previousPlanEnabled: true };
    },
  };
}
