// request-access 状态 schema 单测：逐字段严格校验。
import assert from "node:assert/strict";
import test from "node:test";
import { cuaRequestAccessStatusSchema } from "./request-access-contract.js";

const valid = {
  schemaVersion: 1,
  platform: "darwin",
  grantOwner: "helper-uid-501",
  accessibility: "granted",
  screenRecording: "unknown",
};

test("合法状态解析成功且不回传多余字段", () => {
  const parsed = cuaRequestAccessStatusSchema.safeParse({ ...valid, extra: "ignored?" });
  assert.equal(parsed.success, true);
  assert.deepEqual(parsed.data, valid);
});

test("字段缺失/类型/枚举外取值一律失败", () => {
  const invalid = [
    undefined,
    null,
    42,
    [],
    {},
    { ...valid, schemaVersion: 2 },
    { ...valid, platform: "win32" },
    { ...valid, grantOwner: "" },
    { ...valid, grantOwner: 42 },
    { ...valid, accessibility: "unknown" },
    { ...valid, accessibility: undefined },
    { ...valid, screenRecording: "stale" },
    { ...valid, screenRecording: "granted " },
  ];
  for (const input of invalid) {
    const parsed = cuaRequestAccessStatusSchema.safeParse(input);
    assert.equal(parsed.success, false, JSON.stringify(input));
    assert.ok(parsed.error instanceof Error, JSON.stringify(input));
  }
});
