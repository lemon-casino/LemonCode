import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

/*
 * Tailwind v4 preflight 不再默认给 button / [role="button"] 手型光标（v3 有），
 * 依赖各组件零散补 cursor-pointer 会导致全应用光标不一致。
 * 这里锁住 styles.css 的 base 层兜底规则：可按压即手型，禁用态回退箭头。
 */
test("全局 base 层为可按压控件恢复手型光标，禁用态不显示手型", async () => {
  const styles = await readFile(
    new URL("./styles.css", import.meta.url),
    "utf8",
  );
  const start = styles.indexOf(
    "@layer base {",
    styles.indexOf("Tailwind v4 的 preflight"),
  );
  assert.ok(start >= 0, "styles.css 应在 base 层声明按钮光标兜底规则");
  const end = styles.indexOf("}", styles.indexOf("cursor: pointer;", start));
  assert.ok(end > start, "base 层光标规则应完整闭合");
  const rule = styles.slice(start, end + 1);

  assert.match(rule, /button:not\(:disabled\)/, "未禁用的 button 默认手型");
  assert.match(
    rule,
    /\[role="button"\]:not\(\[aria-disabled="true"\]\)/,
    "role=button 默认手型",
  );
  assert.match(rule, /cursor:\s*pointer;/);

  // 规则必须位于 @layer base 内：未分层样式的优先级会压过 cursor-grab 等交互语义 utilities。
  const beforeLayer = styles.slice(0, start);
  const openingLayers =
    beforeLayer.match(/@layer\s+(?!base\b)[\w-]+\s*\{/g) ?? [];
  assert.equal(openingLayers.length, 0, "光标兜底规则不得嵌套在非 base 层里");
});
