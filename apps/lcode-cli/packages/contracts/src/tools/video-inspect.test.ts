import assert from "node:assert/strict";
import test from "node:test";
import { VideoInspectInputSchema } from "./video-inspect.js";

test("video parameters bound frames, crop and independent timestamp selection", () => {
  assert.equal(VideoInspectInputSchema.parse({ file_path: "/tmp/video.mp4" }).action, "inspect");
  for (const extra of [
    { action: "frames", timestamps: [Infinity] },
    { action: "frames", timestamps: [1], start: 0 },
    { action: "motion", timestamps: [1] },
    { action: "storyboard", count: 13 },
    { action: "frames", crop: { x: 0.8, y: 0, width: 0.3, height: 1 } },
    { action: "inspect", crop: { x: 0, y: 0, width: 1, height: 1 } },
    { action: "frames", start: 3, end: 2 },
  ])
    assert.equal(
      VideoInspectInputSchema.safeParse({ file_path: "/tmp/video.mp4", ...extra }).success,
      false,
    );
  assert.equal(
    VideoInspectInputSchema.safeParse({
      file_path: "/tmp/video.mp4",
      action: "frames",
      timestamps: [0, 0.5],
      crop: { x: 0.5, y: 0, width: 0.5, height: 1 },
    }).success,
    true,
  );
});
