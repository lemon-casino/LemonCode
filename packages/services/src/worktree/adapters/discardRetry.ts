import { setTimeout } from "node:timers/promises";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import type { WorktreeDiscardRetryWait } from "../nodeTypes.js";

export function createWorktreeDiscardRetryWait(): WorktreeDiscardRetryWait {
  const logger = createServiceLogger("worktree");
  return async (params) => {
    logger.warn(undefined, "Worktree discard waiting for a transient filesystem lock", {
      event: "worktree.discard.retry",
      ...params,
    });
    await setTimeout(params.delayMs);
  };
}
