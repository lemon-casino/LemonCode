import { useState } from "react";
import type { IServiceAccessor } from "@lcode/services";
import { useActiveExecutionWorkspace } from "@/hooks/useActiveExecutionWorkspace.js";
import { useRemoteWorkspaceSessionStore } from "@/store/remoteWorkspaceSessionStore.js";
import { useWorktreeLifecycleStore } from "@/store/worktreeLifecycleStore.js";
import { origin, services } from "./git-session-refresh-runtime.js";

let hold = false;
let release: (() => void) | undefined;
let held = 0;
function hostServices(host: string) {
  return {
    ...services,
    worktreeService: { getBinding: async () => null },
    lcodeSessionService: {
      readSession: async () => {
        if (hold) {
          hold = false;
          held++;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return { session: { workspace: { workspacePath: `/fixture/execution/${host}` } } };
      },
    },
  } as unknown as IServiceAccessor;
}
const registry = useRemoteWorkspaceSessionStore.getState();
registry.registerSession({ sessionId: "host-A", services: hostServices("A") });
registry.registerSession({ sessionId: "host-B", services: hostServices("B") });
registry.bindWorkspaceIdentity("fixture-A/same", "host-A");
registry.bindWorkspaceIdentity("fixture-B/same", "host-B");
export function RemoteExecutionFixture() {
  const [host, setHost] = useState("A");
  const identity = `fixture-${host}/same`;
  const execution = useActiveExecutionWorkspace(origin, identity, "same-session", `host-${host}`);
  Object.assign(window, {
    __remoteExecution: {
      hold: () => {
        hold = true;
      },
      release: () => {
        release?.();
        release = undefined;
      },
      held: () => held,
      switchHost: setHost,
      invalidate: () => useWorktreeLifecycleStore.getState().invalidate(origin, identity),
      replaceService: () =>
        useRemoteWorkspaceSessionStore
          .getState()
          .registerSession({ sessionId: "host-B", services: hostServices("B2") }),
    },
  });
  return (
    <output data-testid="remote-execution">
      {execution.workspace?.workspacePath ?? "pending"}
    </output>
  );
}
