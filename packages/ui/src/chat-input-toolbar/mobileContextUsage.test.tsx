import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ContextContent, ContextContentBody } from "../components/ai-elements/context.js";
import { Button } from "../components/ui/button.js";

// HoverCard 的 Portal 不参与 SSR；这里只锁定真实容器/内容与事件透传，几何和滚动需浏览器验收。
test("context content uses Radix available dimensions, dynamic viewport margins and vertical scrolling", () => {
  const content = ContextContent({});
  assert.match(content.props.className, /--radix-hover-card-content-available-height/);
  assert.match(content.props.className, /--radix-hover-card-content-available-width/);
  assert.match(content.props.className, /100dvh-1rem/);
  assert.match(content.props.className, /100dvw-1rem/);
  assert.match(content.props.className, /\boverflow-y-auto\b/);
  assert.doesNotMatch(content.props.className, /\boverflow-(?:hidden|clip)\b/);
  assert.equal(content.props.collisionPadding, 8);
});

test("context content preserves the final action, caller handlers and portal content identity", () => {
  let invoked = 0;
  const onEscapeKeyDown = () => invoked++;
  const lastAction = (
    <Button type="button" onClick={() => invoked++}>
      Final quota action
    </Button>
  );
  const children = (
    <ContextContentBody>
      <p>{"Full usage detail ".repeat(80)}</p>
      {lastAction}
    </ContextContentBody>
  );
  const content = ContextContent({ children, onEscapeKeyDown, side: "top", sideOffset: 2 });
  assert.equal(content.props.children, children);
  assert.equal(content.props.onEscapeKeyDown, onEscapeKeyDown);
  assert.equal(content.props.side, "top");
  assert.equal(content.props.sideOffset, 2);
  const markup = renderToStaticMarkup(children);
  assert.match(markup, /Final quota action/);
  assert.equal((markup.match(/Full usage detail/g) ?? []).length, 80);
  lastAction.props.onClick();
  onEscapeKeyDown();
  assert.equal(invoked, 2);
});

test("usage caller bounds its preferred width and wraps the title/summary without changing touch refresh", async () => {
  const source = await readFile(new URL("./contextUsage.tsx", import.meta.url), "utf8");
  const preferredWidth = source.match(/const contextPanelWidthClass = "([^"]+)"/)?.[1] ?? "";
  assert.ok(preferredWidth.includes("min(20rem,calc(100dvw-1rem))"));
  assert.match(source, /className="[^"]*flex-wrap[^"]*"[\s\S]*?id: "chat\.contextUsage\.title"/);
  const touchHandler =
    source.match(/onPointerDown=\{\(event\) => \{([\s\S]*?)\n\s*\}\}/)?.[1] ?? "";
  assert.match(touchHandler, /event\.pointerType === "touch"/);
  assert.match(touchHandler, /matchMedia\?\.\("\(hover: none\)"\)/);
  assert.match(touchHandler, /if \(!contextOpen\)\s*\{\s*handleContextOpenChange\(true\)/);
  assert.match(source, /codingPlanUsageRemaining\?\.onAccess \?\? startPlanBalance\?\.onAccess/);
  assert.match(source, /if \(!open && quotaResetDialogOpenRef\.current\)/);
  assert.match(
    source,
    /<ChatCodingPlanUsageRemainingPanel[\s\S]*onQuotaResetDialogOpenChange=\{handleQuotaResetDialogOpenChange\}/,
  );
  assert.match(source, /<ChatStartPlanBalancePanel/);
});
