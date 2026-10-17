import assert from "node:assert/strict";
import { test } from "node:test";
import { extractSceneContours } from "../src/renderer/src/startup/sceneContours.js";

test("轮廓连接出真实长折线并保留四周细节，平坦画面不产生噪声", () => {
  const width = 384,
    height = 256;
  const pixels = new Uint8ClampedArray(width * height * 4);
  assert.equal(extractSceneContours(pixels, width, height).length, 0);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const light =
        (x > 30 && x < 110 && y > 25 && y < 220) || (x > 220 && x < 350 && y > 60 && y < 190)
          ? 240
          : 15;
      pixels.set([light, light, light, 255], (y * width + x) * 4);
    }
  const paths = extractSceneContours(pixels, width, height);
  assert.ok(
    paths.some((path) => path.length > 8),
    "连续轮廓不能退化为两点横线",
  );
  const points = paths.flat();
  assert.ok(points.some(([x]) => x < 150));
  assert.ok(points.some(([x]) => x > 1350));
  assert.ok(points.some(([, y]) => y > 850));
  assert.ok(paths.every((path) => path.length >= 3));
});
