import { setTimeout } from "node:timers/promises";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { WorktreeTransientRetryWait } from "../nodeTypes.js";

export function createWorktreeTransientRetryWait(): WorktreeTransientRetryWait {
  const logger = createServiceLogger("worktree");
  return async (params) => {
    logger.warn(undefined, "Worktree operation waiting for a transient filesystem lock", {
      event: "worktree.transient-lock.retry",
      ...params,
    });
    await setTimeout(params.delayMs);
  };
}
