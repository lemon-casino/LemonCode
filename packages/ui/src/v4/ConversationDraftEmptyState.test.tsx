import assert from "node:assert/strict";
import { registerHooks } from "node:module";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";

// Node 源码测试不经过 Vite；品牌 SVG 在这里等价为可断言的 URL 模块。
registerHooks({
  load(url, context, nextLoad) {
    if (url.endsWith(".svg")) {
      return {
        format: "module",
        shortCircuit: true,
        source: `export default ${JSON.stringify(url)};`,
      };
    }
    return nextLoad(url, context);
  },
});

const { LCodeIntlProvider } = await import("@/i18n/IntlProvider.js");
const { ConversationDraftEmptyState } = await import("./ConversationDraftEmptyState.js");

test("新会话空状态复用 V12 品牌资产，不再渲染旧 Z 路径", () => {
  const markup = renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <ConversationDraftEmptyState />
    </LCodeIntlProvider>,
  );

  assert.match(markup, /data-v4-draft-logo="v12"/);
  assert.match(markup, /src="[^"]*app-logo\.svg"/);
  assert.doesNotMatch(markup, /Z\.svg/);
  assert.doesNotMatch(markup, /M398\.97 0\.5L147\.576/);
});
