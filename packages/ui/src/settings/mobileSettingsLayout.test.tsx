import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button } from "../components/ui/button.js";
import { Input } from "../components/ui/input.js";
import { SettingsRow, ThemeSelect } from "./SettingsPageParts.js";

// SSR/元素接线回归不测几何；320px + 导航 rail、大字号和滚动命中由浏览器 fixture 验收。
for (const controlLayout of ["default", "wide"] as const) {
  test(`${controlLayout} settings row stacks before md and retains the desktop control column`, () => {
    const markup = renderToStaticMarkup(
      <SettingsRow
        controlLayout={controlLayout}
        label="A long setting label / 较长的设置名称"
        description="The complete description remains readable."
        control={<Button type="button">Save configuration</Button>}
      />,
    );
    const column = controlLayout === "wide" ? 280 : 192;
    assert.match(markup, /\bgrid-cols-1\b/);
    assert.ok(markup.includes(`md:grid-cols-[minmax(0,1fr)_${column}px]`));
    assert.doesNotMatch(markup, /(?:class="|\s)(?:sm:)?grid-cols-\[minmax\(0,1fr\)_/);
    assert.match(markup, /The complete description remains readable/);
    assert.match(markup, /Save configuration/);
  });

  test(`${controlLayout} settings row retains its real controls, detail and callbacks`, () => {
    let saved = 0;
    const control = (
      <Button type="button" onClick={() => saved++}>
        Save
      </Button>
    );
    const detail = <Input aria-label="Draft" defaultValue="unsaved value" />;
    const row = SettingsRow({ label: "Setting", control, detail, controlLayout });
    const [grid, belowDetail] = row.props.children;
    const controls = grid.props.children[1];
    const [inlineDetail, actualControl] = controls.props.children;
    assert.equal(actualControl, control);
    actualControl.props.onClick();
    assert.equal(saved, 1);
    assert.equal(controlLayout === "wide" ? inlineDetail : belowDetail.props.children, detail);
    assert.match(controls.props.className, /\bmin-w-0\b/);
    assert.match(controls.props.className, /\bmax-w-full\b/);
    assert.match(controls.props.className, /\bflex-wrap\b/);
    assert.doesNotMatch(controls.props.className, /overflow-(?:hidden|clip)/);
    if (controlLayout === "default") {
      assert.match(belowDetail.props.className, /\bmin-w-0\b/);
      assert.match(belowDetail.props.className, /\bmax-w-full\b/);
    }
  });
}

test("theme selection is bounded by the actual control column, not the viewport", () => {
  const markup = renderToStaticMarkup(
    <ThemeSelect value="github-light" onValueChange={() => {}} />,
  );
  const trigger = markup.match(/<button[^>]*data-slot="select-trigger"[^>]*>/)?.[0] ?? "";
  assert.match(trigger, /role="combobox"/);
  assert.match(trigger, /\bmin-w-0\b/);
  assert.match(trigger, /\bmax-w-full\b/);
});

// 控件列宽度由 SettingsRow 的 grid 决定；行内控件再声明固定宽度会与之互相覆盖，
// 导致同卡片下拉框右边界参差或被截断（见 specs/settings-control-column.md）。
test("settings select triggers defer their width to the SettingsRow control column", async () => {
  const sources = [
    "../settingsPageHelpers.tsx",
    "../settingsCodePreview.tsx",
    "../worktree/ExecutionPolicySettings.tsx",
  ];
  // 只匹配独立的数字宽度与任意值宽度（w-52 / w-[260px]）；w-full 是允许的流体宽度，
  // min-w-0 / max-w-full 这类前缀工具类不算控件自带宽度。
  const fixedWidth = /(?<![\w-])w-(?:\d+|\[[^\]]+\])(?![\w-])/;
  for (const relative of sources) {
    const source = await readFile(new URL(relative, import.meta.url), "utf8");
    // 只看 SettingsRow 的 control：项目级策略面板用自己的 label 布局，不受控件列约束。
    // 以 <SettingsRow 切段，再截到该行自己的自闭合标签，避免把行外控件算进来。
    const rows = source
      .split("<SettingsRow")
      .slice(1)
      .map((segment) => {
        const end = segment.search(/\n\s{6,8}\/>/);
        return end === -1 ? segment : segment.slice(0, end);
      });
    assert.ok(rows.length > 0, `${relative} must render settings rows`);
    let checked = 0;
    for (const row of rows) {
      for (const trigger of row.match(/<SelectTrigger[\s\S]*?>/g) ?? []) {
        checked += 1;
        const className = trigger.match(/className="([^"]*)"/)?.[1] ?? "";
        assert.doesNotMatch(
          className,
          fixedWidth,
          `${relative} settings-row select trigger must not hardcode a width: ${className}`,
        );
        assert.match(className, /\bw-full\b/, `${relative} trigger must fill its column`);
        assert.match(trigger, /size="lg"/, `${relative} trigger must use the lg size`);
      }
    }
    assert.ok(checked > 0, `${relative} must render select triggers inside settings rows`);
  }
});

test("settings height inherits the window frame and keeps separate navigation/content scroll owners", async () => {
  const source = await readFile(new URL("../SettingsPage.tsx", import.meta.url), "utf8");
  const pageClass =
    source.match(/data-testid=\{TID_SETTINGS_PAGE\}[\s\S]*?className="([^"]+)"/)?.[1] ?? "";
  assert.match(pageClass, /\bh-full\b/);
  assert.match(pageClass, /\bmin-h-0\b/);
  assert.doesNotMatch(pageClass, /\bh-screen\b|\bmin-h-full\b|overflow-[xy]-hidden/);
  assert.ok(pageClass.includes("grid-cols-[68px_minmax(0,1fr)]"));
  const navClass = source.match(/<nav\b[\s\S]*?className="([^"]+)"/)?.[1] ?? "";
  const mainClass = source.match(/<main\s+className="([^"]+)"/)?.[1] ?? "";
  for (const owner of [navClass, mainClass]) {
    assert.match(owner, /\bmin-h-0\b/);
    assert.match(owner, /\boverflow-y-auto\b/);
  }
});
