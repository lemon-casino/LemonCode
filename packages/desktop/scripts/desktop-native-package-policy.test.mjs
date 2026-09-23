import assert from "node:assert/strict";
import test from "node:test";
import {
  createDesktopNativePackagePrunePatterns,
  findDesktopNativePackageViolations,
  parseAsarListWithPackState,
} from "./desktop-native-package-policy.mjs";

const TARGET_PLATFORM = "win32-x64";

test("prunes every Helper-only CUA package before building app.asar", () => {
  const patterns = createDesktopNativePackagePrunePatterns(TARGET_PLATFORM);
  assert.ok(patterns.includes("!node_modules/@nut-tree-fork/**"));
  assert.ok(patterns.includes("!node_modules/@crowecawcaw/xa11y/**"));
  assert.ok(patterns.includes("!node_modules/@crowecawcaw/xa11y-*/**"));
});

test("rejects Helper-only CUA packages in packed and unpacked app paths", () => {
  const entries = parseAsarListWithPackState(String.raw`
pack: /node_modules/@nut-tree-fork/nut-js/dist/index.js
unpack: \node_modules\@nut-tree-fork\libnut-win32\build\Release\libnut.node
pack: /node_modules/@crowecawcaw/xa11y/index.js
unpack: /node_modules/@crowecawcaw/xa11y-win32-x64/xa11y.node
`);

  assert.deepEqual(findDesktopNativePackageViolations(entries, TARGET_PLATFORM), [
    "Helper-only CUA native 依赖不得进入 desktop app (@nut-tree-fork/**): /node_modules/@nut-tree-fork/nut-js/dist/index.js",
    "Helper-only CUA native 依赖不得进入 desktop app (@nut-tree-fork/**): /node_modules/@nut-tree-fork/libnut-win32/build/Release/libnut.node",
    "Helper-only CUA native 依赖不得进入 desktop app (@crowecawcaw/xa11y*): /node_modules/@crowecawcaw/xa11y/index.js",
    "Helper-only CUA native 依赖不得进入 desktop app (@crowecawcaw/xa11y*): /node_modules/@crowecawcaw/xa11y-win32-x64/xa11y.node",
  ]);
});

test("rejects forbidden CUA packages nested below another dependency", () => {
  const entries = [
    {
      packState: "pack",
      path: "/node_modules/wrapper/node_modules/@nut-tree-fork/shared/package.json",
    },
    {
      packState: "unpack",
      path: "/node_modules/wrapper/node_modules/@crowecawcaw/xa11y-linux-x64/xa11y.node",
    },
  ];

  assert.equal(findDesktopNativePackageViolations(entries, TARGET_PLATFORM).length, 2);
});

test("does not reject similarly named non-CUA packages", () => {
  const entries = [
    { packState: "pack", path: "/node_modules/@nut-tree-forked/example/index.js" },
    { packState: "pack", path: "/node_modules/@crowecawcaw/not-xa11y/index.js" },
    { packState: "pack", path: "/node_modules/@crowecawcaw/prexa11y/index.js" },
  ];

  assert.deepEqual(findDesktopNativePackageViolations(entries, TARGET_PLATFORM), []);
});
