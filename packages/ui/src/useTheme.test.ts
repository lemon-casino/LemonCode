import assert from "node:assert/strict";
import test from "node:test";
import {
  applyTheme,
  isThemeValue,
  normalizeThemePreference,
  resolveTheme,
  THEME_OPTIONS,
  type Theme,
} from "./useTheme.js";

// ---------------------------------------------------------------------------
// 主题注册表（specs/ui-theme-modes.md）：resolveTheme / normalizeThemePreference /
// isThemeValue 是纯逻辑可直接单测；applyTheme 只依赖 documentElement.classList，
// 用最小 stub 验证「深基底 = dark + theme-<id>、浅基底 = 仅 theme-<id>」的 class 组合。
// store 异常值回落 / 广播校验 / resource-manager storage 同步是 zustand 工厂与
// window 事件副作用边界，不在 node:test 基建覆盖范围（由 E2E 验收场景覆盖）。
// ---------------------------------------------------------------------------

test("THEME_OPTIONS 注册表：6 个用户可见项且顺序固定", () => {
  assert.deepEqual(
    THEME_OPTIONS.map((option) => option.id),
    ["system", "zai-dark", "zai-light", "sepia-light", "midnight-blue", "forest-dark"],
  );
  assert.deepEqual(
    THEME_OPTIONS.map((option) => option.base),
    ["dynamic", "dark", "light", "light", "dark", "dark"],
  );
});

test("normalizeThemePreference：legacy light/dark 归一 Zai 对，新 id 原样透传", () => {
  assert.equal(normalizeThemePreference("dark"), "zai-dark");
  assert.equal(normalizeThemePreference("light"), "zai-light");
  for (const passthrough of [
    "zai-dark",
    "zai-light",
    "sepia-light",
    "midnight-blue",
    "forest-dark",
    "system",
  ] as const) {
    assert.equal(normalizeThemePreference(passthrough), passthrough);
  }
});

test("isThemeValue：全部合法主题放行，异常本地值/广播 payload 一律拒绝", () => {
  for (const theme of [
    "light",
    "dark",
    "zai-light",
    "zai-dark",
    "sepia-light",
    "midnight-blue",
    "forest-dark",
    "system",
  ] as const) {
    assert.equal(isThemeValue(theme), true, theme);
  }
  // store 本地初始值与广播接收端用同一白名单，异常值回落 zai-dark 的前提是这里拒绝。
  for (const invalid of ["nonsense", "", " zai-dark", "dark ", null, undefined, 0, {}, []]) {
    assert.equal(isThemeValue(invalid), false, String(invalid));
  }
});

test("resolveTheme：legacy 与 Zai 对按预期折叠亮暗", () => {
  assert.equal(resolveTheme("dark"), "dark");
  assert.equal(resolveTheme("light"), "light");
  assert.equal(resolveTheme("zai-dark"), "dark");
  assert.equal(resolveTheme("zai-light"), "light");
});

test("resolveTheme：新深基底不漏判成亮侧，新浅基底落亮侧", () => {
  // 该行为是下游二值折叠（shiki/mermaid/原生标题栏）的唯一依据。
  assert.equal(resolveTheme("sepia-light"), "light");
  assert.equal(resolveTheme("midnight-blue"), "dark");
  assert.equal(resolveTheme("forest-dark"), "dark");
});

test("resolveTheme：system 按 matchMedia 实时解析为亮/暗", () => {
  const originalWindow = globalThis.window;
  try {
    (globalThis as { window?: unknown }).window = {
      matchMedia: (query: string) => ({ matches: query === "(prefers-color-scheme: dark)" }),
    };
    assert.equal(resolveTheme("system"), "dark");

    (globalThis as { window?: unknown }).window = {
      matchMedia: () => ({ matches: false }),
    };
    assert.equal(resolveTheme("system"), "light");
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

// applyTheme 组合测试的最小 DOM stub：只实现 classList.toggle/contains；
// syncBrowserThemeSurface 因 hasAttribute 恒为 false 而提前返回，不触达 meta/computedStyle。
function stubDocumentClasses() {
  const classSet = new Set<string>();
  const classList = {
    contains: (token: string) => classSet.has(token),
    toggle: (token: string, force?: boolean) => {
      const next = force ?? !classSet.has(token);
      if (next) {
        classSet.add(token);
      } else {
        classSet.delete(token);
      }
      return next;
    },
  };
  (globalThis as { document?: unknown }).document = {
    documentElement: {
      classList,
      hasAttribute: () => false,
    },
  };
  return classSet;
}

test("applyTheme：6 项主题的 documentElement class 组合正确", () => {
  const classSet = stubDocumentClasses();

  // 期望组合：dark class + 激活的 theme-<id>；浅基底不含 dark。
  const cases: Array<{
    theme: Theme;
    matchMediaDark?: boolean;
    expected: string[];
  }> = [
    { theme: "zai-dark", expected: ["dark", "theme-zai-dark"] },
    { theme: "zai-light", expected: ["theme-zai-light"] },
    { theme: "sepia-light", expected: ["theme-sepia-light"] },
    { theme: "midnight-blue", expected: ["dark", "theme-midnight-blue"] },
    { theme: "forest-dark", expected: ["dark", "theme-forest-dark"] },
    // system 落 Zai 对：暗偏好 → zai-dark，亮偏好 → zai-light，不落新主题。
    { theme: "system", matchMediaDark: true, expected: ["dark", "theme-zai-dark"] },
    { theme: "system", matchMediaDark: false, expected: ["theme-zai-light"] },
    // legacy 输入等价 Zai 对。
    { theme: "dark", expected: ["dark", "theme-zai-dark"] },
    { theme: "light", expected: ["theme-zai-light"] },
  ];

  const originalWindow = globalThis.window;
  try {
    for (const { theme, matchMediaDark, expected } of cases) {
      classSet.clear();
      (globalThis as { window?: unknown }).window = {
        matchMedia: () => ({ matches: matchMediaDark ?? false }),
      };
      applyTheme(theme);
      assert.deepEqual([...classSet].sort(), [...expected].sort(), `theme=${theme}`);
    }
  } finally {
    (globalThis as { window?: unknown }).window = originalWindow;
  }
});

test("applyTheme：切换主题时清空上一个 theme-* 类，不残留差量变量块", () => {
  const classSet = stubDocumentClasses();
  applyTheme("midnight-blue");
  assert.deepEqual([...classSet].sort(), ["dark", "theme-midnight-blue"]);

  // 深基底 → 浅基底：dark 与 theme-midnight-blue 都必须被移除。
  applyTheme("sepia-light");
  assert.deepEqual([...classSet].sort(), ["theme-sepia-light"]);

  // 浅基底 → 另一浅基底：仅 theme-<id> 更换。
  applyTheme("zai-light");
  assert.deepEqual([...classSet].sort(), ["theme-zai-light"]);
});
