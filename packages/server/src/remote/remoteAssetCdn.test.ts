import assert from "node:assert/strict";
import test from "node:test";
import {
  assertRemoteCdnBaseVersionMatches,
  buildReleaseBaseCandidates,
  buildComponentArtifactUrlCandidates,
} from "./remoteAssetCdn.js";

test("fixed release tags never append a second version or probe the parent release", () => {
  for (const base of [
    "https://fixture.invalid/api/v1/releases/download/v9.8.7",
    "https://github.com/fixture/repo/releases/download/v9.8.7",
  ]) {
    const releaseBases = buildReleaseBaseCandidates([base], "9.8.7");
    assert.deepEqual(releaseBases, [base]);
    assert.deepEqual(
      buildComponentArtifactUrlCandidates(
        releaseBases,
        "remote-linux-x64-node-runtime-sha.tar.gz",
        "9.8.7",
      ),
      [`${base}/remote-linux-x64-node-runtime-sha.tar.gz`],
    );
    assert.throws(() => assertRemoteCdnBaseVersionMatches([base], "9.8.8"), /版本不匹配/);
  }
});

test("custom CDN retains shared components root and versioned manifest location", () => {
  const base = "https://fixture.invalid/lcode/electron/releases/9.8.7";
  assert.deepEqual(buildReleaseBaseCandidates([base], "9.8.7"), [base]);
  assert.deepEqual(
    buildComponentArtifactUrlCandidates(
      [base],
      "components/linux-x64/node-runtime/v1.tar.gz",
      "9.8.7",
    ),
    [
      "https://fixture.invalid/lcode/electron/releases/components/linux-x64/node-runtime/v1.tar.gz",
      `${base}/components/linux-x64/node-runtime/v1.tar.gz`,
    ],
  );
});
