import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { renderToStaticMarkup } from "react-dom/server";
import type { IPlatformService } from "@lcode/shared";
import { PlatformProvider } from "@/hooks/usePlatform.js";
import { LCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { WorkspaceHeaderActionSection } from "@/WorkspaceHeaderSections/WorkspaceHeaderActionSection.js";

for (const ready of [false, true])
  test(`open pane chrome stays accessible while execution ready=${ready}`, () => {
    const noop = () => {};
    const html = renderToStaticMarkup(
      <PlatformProvider platform={{} as IPlatformService}>
        <LCodeIntlProvider initialLocale="zh-CN">
          <TooltipProvider>
            <WorkspaceHeaderActionSection
              variant="draft"
              workspaceAbsPath="/fixture"
              isTerminalOpen={false}
              isSidePaneOpen
              isSidePaneReady={ready}
              isDesktop
              showWindowControls
              simplifyForNarrowRemote
              onToggleTerminal={noop}
              onToggleSidePane={noop}
            />
          </TooltipProvider>
        </LCodeIntlProvider>
      </PlatformProvider>,
    );
    for (const control of [
      "side-pane-toggle",
      "window-control-minimize",
      "window-control-maximize",
      "window-control-close",
    ])
      assert.equal(html.includes(`data-testid="${control}"`), !ready);
  });

test("Shell forwards execution recovery without conditionally unmounting the Panel", async () => {
  // 接线护栏配合浏览器的真实 Panel DOM/几何/入口回归，不将源码断言当成布局证据。
  const shell = await readFile(new URL("./WorkspaceShellLayout.tsx", import.meta.url), "utf8");
  assert.doesNotMatch(shell, /const sidePanePanel = executionReady\s*\?/u);
  assert.match(shell, /executionState=\{/u);
  assert.match(shell, /isSidePaneReady=\{executionReady\}/u);
  const app = await readFile(new URL("../App.tsx", import.meta.url), "utf8");
  assert.match(app, /handleRetryExecution=\{execution\.retry\}/u);
});
