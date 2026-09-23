import assert from "node:assert/strict";
import { resolve } from "node:path";
import test from "node:test";
import {
  LINUX_CUA_XA11Y_NATIVE_ROOT_ENV,
  resolveLinuxCuaNativePackageRoots,
} from "./linux-cua-native-package.mjs";

test("non-Linux targets do not read the Linux xa11y override", () => {
  assert.equal(
    resolveLinuxCuaNativePackageRoots({
      targetPlatform: { os: "win32", arch: "x64", key: "win32-x64" },
      env: { [LINUX_CUA_XA11Y_NATIVE_ROOT_ENV]: "relative/untrusted" },
    }),
    undefined,
  );
});

test("Linux targets map the absolute package root to their native package", () => {
  const x64Root = resolve("fixtures", "xa11y-linux-x64");
  const arm64Root = resolve("fixtures", "xa11y-linux-arm64");

  assert.deepEqual(
    resolveLinuxCuaNativePackageRoots({
      targetPlatform: { os: "linux", arch: "x64", key: "linux-x64" },
      env: { [LINUX_CUA_XA11Y_NATIVE_ROOT_ENV]: `  ${x64Root}  ` },
    }),
    { "@crowecawcaw/xa11y-linux-x64-gnu": x64Root },
  );
  assert.deepEqual(
    resolveLinuxCuaNativePackageRoots({
      targetPlatform: { os: "linux", arch: "arm64", key: "linux-arm64" },
      env: { [LINUX_CUA_XA11Y_NATIVE_ROOT_ENV]: arm64Root },
    }),
    { "@crowecawcaw/xa11y-linux-arm64-gnu": arm64Root },
  );
});

test("Linux packaging fails closed without an absolute release addon root", () => {
  const targetPlatform = { os: "linux", arch: "x64", key: "linux-x64" };

  assert.throws(
    () => resolveLinuxCuaNativePackageRoots({ targetPlatform, env: {} }),
    new RegExp(`${LINUX_CUA_XA11Y_NATIVE_ROOT_ENV} is required`, "u"),
  );
  assert.throws(
    () =>
      resolveLinuxCuaNativePackageRoots({
        targetPlatform,
        env: { [LINUX_CUA_XA11Y_NATIVE_ROOT_ENV]: "artifacts/xa11y" },
      }),
    new RegExp(`${LINUX_CUA_XA11Y_NATIVE_ROOT_ENV} must be an absolute path`, "u"),
  );
});

test("Linux packaging rejects unregistered architectures before reading an override", () => {
  assert.throws(
    () =>
      resolveLinuxCuaNativePackageRoots({
        targetPlatform: { os: "linux", arch: "riscv64", key: "linux-riscv64" },
        env: {},
      }),
    /unsupported Linux architecture: riscv64/u,
  );
});
