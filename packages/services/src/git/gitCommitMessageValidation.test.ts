import assert from "node:assert/strict";
import test from "node:test";
import { validateGeneratedGitCommitMessage } from "./gitCommitMessageValidation.js";

test("只移除有效标题的 Markdown 展示包装，中文正文原样保留", () => {
  const subject = "test(workflow): 补充执行效率基准与压力回归";
  for (const newline of ["\n", "\r\n"]) {
    const body = `${newline}${newline}- 保留 \`schema\` 校验和 **人工确认**。`;
    for (const wrapped of [subject, `\`${subject}\``, `\`\`${subject}\`\``, `**${subject}**`])
      assert.deepEqual(validateGeneratedGitCommitMessage(wrapped + body), {
        ok: true,
        message: subject + body,
      });
  }
});

test("原代码围栏与整体引号兼容，不能从解释性长文中搜索或伪造标题", () => {
  for (const wrapped of ['"fix: 修复格式解析"', "```text\nfix: 修复格式解析\n```"])
    assert.deepEqual(validateGeneratedGitCommitMessage(wrapped), {
      ok: true,
      message: "fix: 修复格式解析",
    });
  for (const raw of [
    "",
    "`普通说明`",
    "以下是提交消息：\n`fix: 修复格式解析`",
    "`fix: 未闭合",
    "`fix: a` / `fix: b`",
  ])
    assert.equal(validateGeneratedGitCommitMessage(raw).ok, false);
});
