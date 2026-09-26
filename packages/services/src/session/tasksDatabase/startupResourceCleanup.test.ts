import assert from "node:assert/strict";
import test from "node:test";

import {
  NO_TASKS_STORAGE_STARTUP_FAILURE,
  closeTasksStorageStartupResources,
} from "./startupResourceCleanup.js";

function captureThrown(run: () => void): { thrown: boolean; error: unknown } {
  try {
    run();
    return { thrown: false, error: undefined };
  } catch (error) {
    return { thrown: true, error };
  }
}

test("keeps a falsy primary startup failure while attempting every close", () => {
  const closeError = new Error("close failed");
  for (const primaryError of [undefined, null, false, 0, ""]) {
    const closeCalls: string[] = [];
    const result = captureThrown(() =>
      closeTasksStorageStartupResources({ failed: true, error: primaryError }, [
        () => {
          closeCalls.push("first");
          throw closeError;
        },
        () => {
          closeCalls.push("second");
        },
        () => {
          closeCalls.push("third");
          throw new Error("later close failed");
        },
      ]),
    );

    assert.deepEqual(closeCalls, ["first", "second", "third"]);
    assert.equal(result.thrown, true);
    assert.equal(result.error, primaryError);
  }
});

test("throws the first close failure only after a successful startup operation", () => {
  const firstCloseError = new Error("first close failed");
  const closeCalls: string[] = [];

  const result = captureThrown(() =>
    closeTasksStorageStartupResources(NO_TASKS_STORAGE_STARTUP_FAILURE, [
      () => {
        closeCalls.push("first");
        throw firstCloseError;
      },
      () => {
        closeCalls.push("second");
        throw new Error("second close failed");
      },
    ]),
  );

  assert.deepEqual(closeCalls, ["first", "second"]);
  assert.equal(result.thrown, true);
  assert.equal(result.error, firstCloseError);
});
