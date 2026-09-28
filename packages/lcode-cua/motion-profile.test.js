import assert from "node:assert/strict";
import test from "node:test";
import { createMotionPath, executeMotionPath } from "./motion-profile.js";

test("instant profile emits only the destination", () => {
  assert.deepEqual(createMotionPath([0, 0], [120, 80]), [[120, 80]]);
});

test("smooth profile is deterministic, bounded and ends exactly at destination", () => {
  const first = createMotionPath([0, 0], [1000, 500], {
    profile: "smooth",
    maxSegments: 8,
    segmentPixels: 10,
  });
  const second = createMotionPath([0, 0], [1000, 500], {
    profile: "smooth",
    maxSegments: 8,
    segmentPixels: 10,
  });
  assert.deepEqual(first, second);
  assert.ok(first.length >= 2 && first.length <= 8);
  assert.deepEqual(first.at(-1), [1000, 500]);
});

test("execution accepts injected driver and clock", async () => {
  const moves = [];
  const waits = [];
  const result = await executeMotionPath(
    { moveTo: async (target) => moves.push(target) },
    [0, 0],
    [200, 0],
    {
      profile: "smooth",
      segmentPixels: 50,
      durationMs: 40,
      sleep: async (milliseconds) => waits.push(milliseconds),
    },
  );
  assert.equal(result.pointCount, moves.length);
  assert.deepEqual(moves.at(-1), [200, 0]);
  assert.equal(waits.length, moves.length - 1);
});
