import type { ProjectExecutionSetHostService } from "./contract.js";
import type { ProjectContextSnapshot } from "@lcode/shared";
export async function prepareCollaboration(
  service: ProjectExecutionSetHostService,
  projectContext: ProjectContextSnapshot,
) {
  const set = await service.prepare({
    operationId: "example-request",
    name: "Frontend and backend",
    projectContext,
  });
  if (set.status !== "ready") throw new Error(set.error ?? "A repository could not be prepared");
  return service.attachSession({
    ...set.origin,
    executionSetId: set.id,
    sessionId: "example-session",
    operationId: "example-attach",
  });
}
