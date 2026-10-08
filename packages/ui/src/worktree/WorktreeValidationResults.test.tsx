import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import test from "node:test";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { WorktreeValidationResults } from "./WorktreeValidationResults.js";

function render(results: { command: string; exitCode: number; output: string }[]) {
  return renderToStaticMarkup(
    createElement(LCodeIntlProvider, {
      initialLocale: "zh-CN",
      children: createElement(WorktreeValidationResults, {
        results,
        commands: results.map((item) => item.command),
      }),
    }),
  );
}
test("依赖准备不冒充检查通过；准备失败的外层与日志默认展开", () => {
  const html = render([
    { command: "pnpm install --frozen-lockfile", exitCode: 1, output: "dependency-failed" },
  ]);
  assert.match(html, /检查：0 项通过/);
  const details = html.match(/<details[^>]*>/gu)!;
  assert.match(details[0]!, /open=/u);
  assert.match(details[1]!, /open=/u);
  assert.match(html, /dependency-failed/u);
});
test("依赖准备和真正检查分别计数", () => {
  const html = render([
    { command: "pnpm install --frozen-lockfile", exitCode: 0, output: "prepared" },
    { command: "pnpm lint", exitCode: 0, output: "checked" },
  ]);
  assert.match(html, /检查：1 项通过/u);
  assert.match(html, /依赖准备：1 项已完成/u);
});
