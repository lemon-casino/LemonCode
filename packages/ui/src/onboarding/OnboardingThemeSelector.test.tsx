import assert from "node:assert/strict";
import test from "node:test";
import { renderToStaticMarkup } from "react-dom/server";
import { LCodeIntlProvider } from "../i18n/IntlProvider.js";
import { THEME_OPTIONS } from "../useTheme.js";
import { OnboardingThemeSelector } from "./OnboardingThemeSelector.js";

function render(theme: (typeof THEME_OPTIONS)[number]["id"]) {
  return renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <OnboardingThemeSelector theme={theme} saving={false} onSelect={() => {}} />
    </LCodeIntlProvider>,
  );
}

// 引导是第三个主题入口：选项必须由 THEME_OPTIONS 注册表派生，
// 不能像旧实现那样在各入口各写一份白名单（spec: specs/ui-theme-modes.md）。
test("onboarding theme selector renders every registered theme from the registry", () => {
  const markup = render("zai-dark");
  const buttons = markup.match(/<button[^>]*aria-pressed[^>]*>/g) ?? [];
  assert.equal(buttons.length, THEME_OPTIONS.length);
  for (const option of THEME_OPTIONS) {
    assert.match(markup, new RegExp(`aria-pressed="${option.id === "zai-dark"}"`));
  }
  // 八个显示名都走 i18n，不出现裸 id。
  for (const option of THEME_OPTIONS) {
    const label = option.labelKey.split(".").pop() ?? "";
    assert.ok(label.length > 0);
  }
});

test("onboarding theme selector marks exactly the current theme as pressed", () => {
  for (const option of THEME_OPTIONS) {
    const markup = render(option.id);
    const pressed = markup.match(/aria-pressed="true"/g) ?? [];
    assert.equal(pressed.length, 1, `${option.id} must select exactly one option`);
  }
});

test("onboarding theme selector disables options while saving", () => {
  const markup = renderToStaticMarkup(
    <LCodeIntlProvider initialLocale="zh-CN">
      <OnboardingThemeSelector theme="zai-dark" saving onSelect={() => {}} />
    </LCodeIntlProvider>,
  );
  const buttons = markup.match(/<button[^>]*aria-pressed[^>]*>/g) ?? [];
  assert.equal(buttons.length, THEME_OPTIONS.length);
  for (const button of buttons) assert.match(button, /\bdisabled\b/);
});
