import assert from "node:assert/strict";
import test from "node:test";
import {
  hasChatLoadingBlockingActiveWork,
  shouldShowTurnChatLoading,
} from "./chatLoadingVisibility.js";

test("stopping suppresses thinking loading while the turn is still persisting", () => {
  for (const stopState of ["idle", "stoppable", "stopping"] as const) {
    const blockedByActiveWork = hasChatLoadingBlockingActiveWork([], stopState);
    assert.equal(
      shouldShowTurnChatLoading({
        blockedByActiveWork,
        blockedByInteraction: false,
        isLastTurn: true,
        isRunning: true,
        rows: [],
      }),
      stopState !== "stopping",
    );
  }
});
