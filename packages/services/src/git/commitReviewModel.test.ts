import assert from "node:assert/strict";
import test from "node:test";
import { parseCommitReviewModelOutput, buildCommitReviewPrompt } from "./commitReviewModel.js";
const group = {
  id: "A",
  sessionIds: ["A"],
  label: "会话 A",
  dependsOn: [],
  message: "",
  requiresConfirmation: false,
  files: [],
};
const output = {
  decision: "keep",
  warnings: [],
  messages: [{ id: "A", message: "feat: 增强功能" }],
  mergedMessage: "feat: 合并功能",
};
test("审核 JSON 只接受已冻结的完整候选集合", () => {
  assert.equal(
    parseCommitReviewModelOutput(JSON.stringify(output), [group]).messages[0]!.message,
    "feat: 增强功能",
  );
  for (const messages of [
    [],
    [{ id: "B", message: "feat: 假归属" }],
    [output.messages[0], output.messages[0]],
    [{ id: "A", message: "some prose" }],
  ]) {
    assert.throws(() =>
      parseCommitReviewModelOutput(JSON.stringify({ ...output, messages }), [group]),
    );
  }
  assert.throws(() =>
    parseCommitReviewModelOutput(JSON.stringify({ ...output, patches: [] }), [group]),
  );
  assert.match(
    buildCommitReviewPrompt({ workspacePath: "/repo", groups: [group], warnings: [] }),
    /简体中文/,
  );
});

test("大量冻结文件的 prompt 按字符预算裁剪且明示完整数量，不修改完整审核预览", () => {
  const files = Array.from({ length: 10_001 }, (_, i) => ({
    path: `目录/${i}.ts`,
    patch: '+"中文\\n'.repeat(100),
    added: 100,
    removed: 0,
  }));
  const prompt = buildCommitReviewPrompt({
    workspacePath: "/fixture",
    warnings: ["review-truncated"],
    groups: [{ ...group, files }],
  });
  assert.ok(prompt.length < 65_000);
  const data = JSON.parse(prompt.split("\n").at(-1)!);
  assert.equal(data.groups[0].totalFileCount, 10_001);
  assert.ok(data.groups[0].omittedFileCount > 0);
  assert.equal(files.length, 10_001);
  assert.equal(files[0]!.patch, '+"中文\\n'.repeat(100));
});

test("预算内的所有补丁必须完整，不能被摘要策略误截断", () => {
  const files = ["a.ts", "b.ts"].map((path) => ({
    path,
    patch: "+a".repeat(4500),
    added: 1,
    removed: 0,
  }));
  const prompt = buildCommitReviewPrompt({
    workspacePath: "/fixture",
    warnings: [],
    groups: [{ ...group, files }],
  });
  assert.deepEqual(JSON.parse(prompt.split("\n").at(-1)!).groups[0].files, files);
});

test("合并候选的空展示标签在模型输入中使用稳定 id，不触发缺少 label 的伪警告", () => {
  const prompt = buildCommitReviewPrompt({
    workspacePath: "/fixture",
    warnings: [],
    groups: [{ ...group, id: "merged", label: "" }],
  });
  const data = JSON.parse(prompt.split("\n").at(-1)!);
  assert.equal(data.groups[0].label, "merged");
  assert.match(prompt, /display metadata/);
});

test("审核消息与独立纪要复用同一 Markdown 标题归一化，候选校验不放宽", () => {
  const result = parseCommitReviewModelOutput(
    JSON.stringify({
      ...output,
      messages: [{ id: "A", message: "`feat: 增强功能`\n\n保留正文" }],
      mergedMessage: "**feat: 合并功能**",
    }),
    [group],
  );
  assert.equal(result.messages[0]!.message, "feat: 增强功能\n\n保留正文");
  assert.equal(result.mergedMessage, "feat: 合并功能");
});

test("候选可将提交正文放在独立 body 字段，合并后仍执行原提交消息校验", () => {
  const result = parseCommitReviewModelOutput(
    JSON.stringify({
      ...output,
      messages: [{ id: "A", message: "fix: 修复提交审核", body: "兼容模型拆分的正文。" }],
    }),
    [group],
  );
  assert.equal(result.messages[0]!.message, "fix: 修复提交审核\n\n兼容模型拆分的正文。");
  assert.deepEqual(Object.keys(result.messages[0]!).sort(), ["id", "message"]);
});

test("候选内警告归入原顶层审核警告且保留关联，不写入提交消息或改动输入", () => {
  const raw = {
    ...output,
    warnings: ["需检查完整补丁"],
    messages: [
      { id: "A", message: "feat: 增强功能", warnings: ["确认功能依赖", "确认功能依赖"] },
      { id: "B", message: "test: 补充验证", warnings: [] },
    ],
  };
  const serialized = JSON.stringify(raw);
  const result = parseCommitReviewModelOutput(serialized, [group, { ...group, id: "B" }]);
  assert.deepEqual(result.warnings, ["需检查完整补丁", "[A] 确认功能依赖"]);
  assert.deepEqual(result.messages, [
    { id: "A", message: "feat: 增强功能" },
    { id: "B", message: "test: 补充验证" },
  ]);
  assert.equal(JSON.stringify(raw), serialized);
  const prompt = buildCommitReviewPrompt({ workspacePath: "/repo", groups: [group], warnings: [] });
  assert.match(prompt, /warnings belong only at the top level/);
  assert.match(prompt, /optional body/);
  assert.match(prompt, /do not add other fields/);
});

test("仅兼容有界字符串警告，不允许其他字段、错误类型或候选身份绕过校验", () => {
  for (const warnings of [null, "警告", [1], [""], ["x".repeat(1001)], Array(21).fill("警告")])
    assert.throws(() =>
      parseCommitReviewModelOutput(
        JSON.stringify({ ...output, messages: [{ ...output.messages[0], warnings }] }),
        [group],
      ),
    );
  for (const item of [
    { ...output.messages[0], warnings: [], patches: [] },
    { ...output.messages[0], body: 1 },
    { id: "B", message: "feat: 增强功能", warnings: ["提示"] },
    { id: "A", message: "普通说明", warnings: ["提示"] },
  ])
    assert.throws(() =>
      parseCommitReviewModelOutput(JSON.stringify({ ...output, messages: [item] }), [group]),
    );
  assert.throws(() =>
    parseCommitReviewModelOutput(
      JSON.stringify({
        ...output,
        warnings: [1],
        messages: [{ ...output.messages[0], warnings: [] }],
      }),
      [group],
    ),
  );
});
