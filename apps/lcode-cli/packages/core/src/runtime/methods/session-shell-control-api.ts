import {
  getSessionShellSelection,
  initializeSessionShellEnvironmentIfNeeded,
  prepareSessionShellEnvironment,
} from "./config.js";

export function installSessionShellControlApi(proto: Record<string, unknown>): void {
  proto.getSessionShellSelection = getSessionShellSelection;
  proto.initializeSessionShellEnvironmentIfNeeded = initializeSessionShellEnvironmentIfNeeded;
  proto.prepareSessionShellEnvironment = prepareSessionShellEnvironment;
}
