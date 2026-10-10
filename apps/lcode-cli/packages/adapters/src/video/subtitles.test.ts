import assert from "node:assert/strict";
import test from "node:test";
import { parseVideoSubtitles, measureVideoMotion, videoFrameTimes } from "./analysis.js";

test("SRT and WebVTT retain timed text with bounded overlapping range selection", () => {
  const srt = "1\n00:00:01,000 --> 00:00:02,000\nhello\n\n2\n00:00:03,000 --> 00:00:04,000\nworld";
  assert.deepEqual(parseVideoSubtitles(srt), [
    { start: 1, end: 2, text: "hello" },
    { start: 3, end: 4, text: "world" },
  ]);
  assert.deepEqual(
    parseVideoSubtitles("WEBVTT\n\n00:01.000 --> 00:02.500 align:start\n<v speaker>你好</v>"),
    [{ start: 1, end: 2.5, text: "你好" }],
  );
});

test("motion samples stay below exclusive end and quantify pixels without inventing causes", () => {
  assert.deepEqual(videoFrameTimes(0, 3, 3), [0, 1, 2]);
  const first = new Uint8Array(12);
  const second = new Uint8Array(first);
  second.set([255, 255, 255], 3);
  assert.deepEqual(measureVideoMotion([first, second], 2, 2), {
    changeRatios: [0.25],
    changedRegion: { x: 0.5, y: 0, width: 0.5, height: 0.5 },
  });
});
