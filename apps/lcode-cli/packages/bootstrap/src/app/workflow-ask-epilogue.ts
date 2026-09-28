// ============================================================
// dwf ask 的质量尾注
// ============================================================
//
// 独立成文件：workflow-driver.ts 早已超过 max-lines，而这段是纯文案 + 一个 schema 探测，
// 与 driver 的状态机无关。
//
// 尾注曾按 persona 的工具档位分支——零工具的 GLM 子代理读到「every finding
// cites what you read or ran」后去找它没有的工具，发出 `escalate("placeholder")`。
// 工具档位整个退场，每个子代理
// 都有完整工作工具集，尾注回到一份文本。

/**
 * 每个 ask 的质量尾注：结果的内容标准——证据、
 * 「跑过」与「相信」的区分、做不到的部分照实说、堵住时 escalate。typed / untyped 都加；typed
 * 时 schema 尾注紧随其后。schema 顶层 properties 含 `evidence` / `confidence` 时按名点出这两个
 * 字段，没有就不提。
 * 格式（本注释即契约）：两个空行 + 分隔线 + 标题行 + 要点列表。
 */
export function qualityEpilogue(schema: unknown): string {
  const fields = topLevelSchemaProperties(schema);
  return [
    "",
    "",
    "---",
    "Standard for this result:",
    "- Every finding cites what you read or ran: path and line for code; the exact command and its output for a check; the part of the ask for material the ask itself gave you.",
    "- A check counts as passed only if you ran it during this ask. Otherwise report it as not run.",
    // 子代理挑最快变绿的命令当「测试跑过了」——ask 说的是整套件，它跑一个文件；
    // ask 说的是 e2e，它跑单测。契约只管它诚实，这句管它的尺度：替身按替身报告，说清跑了哪条。
    "- Run the check the ask names, at the scale it names. A narrower or faster substitute — one test file for the suite, a build for the tests — is reported as what it is, never as the ask's check; say the exact command you ran.",
    "- Anything you could not do, verify, or find is stated as such — never filled with a plausible guess.",
    ...(fields.has("evidence") ? ["- Put each finding's citation in its `evidence` field."] : []),
    ...(fields.has("confidence")
      ? ["- Rate `confidence` honestly; a low value with a reason beats a confident guess."]
      : []),
    "- If you are blocked by something outside your reach, call `escalate` instead of inventing a value.",
  ].join("\n");
}

/** schema 顶层 `properties` 的键集合；非对象 schema 或缺席时为空集。 */
function topLevelSchemaProperties(schema: unknown): Set<string> {
  if (typeof schema !== "object" || schema === null) return new Set();
  const properties = (schema as { properties?: unknown }).properties;
  if (typeof properties !== "object" || properties === null) return new Set();
  return new Set(Object.keys(properties as Record<string, unknown>));
}
