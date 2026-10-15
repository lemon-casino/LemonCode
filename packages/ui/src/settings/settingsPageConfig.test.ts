import assert from "node:assert/strict";
import test from "node:test";
import zhCN from "@/i18n/locales/zh-CN.js";
import enUS from "@/i18n/locales/en-US.js";
import { createSettingsPageConfig } from "./settingsPageConfig.js";

test("各组按当前语言名称从短到长排列，等长保留注册顺序且不改变注册配置", () => {
  const original = createSettingsPageConfig({ isDesktop: true });
  for (const messages of [zhCN, enUS]) {
    const getSectionTitle = (id: string) => {
      const title = messages[id];
      assert.ok(typeof title === "string", `missing title: ${id}`);
      return title;
    };
    const sorted = createSettingsPageConfig({ isDesktop: true, getSectionTitle });
    assert.deepEqual(sorted.settingsSections, original.settingsSections);
    assert.deepEqual(
      sorted.settingsSectionGroups.map((group) => group.id),
      original.settingsSectionGroups.map((group) => group.id),
    );
    for (const group of sorted.settingsSectionGroups) {
      const previous = original.settingsSectionGroups.find((entry) => entry.id === group.id)!;
      for (let index = 1; index < group.sections.length; index++) {
        const current = group.sections[index]!;
        const preceding = group.sections[index - 1]!;
        const currentLength = Array.from(
          getSectionTitle(current.titleId).replace(/\s/gu, ""),
        ).length;
        const precedingLength = Array.from(
          getSectionTitle(preceding.titleId).replace(/\s/gu, ""),
        ).length;
        assert.ok(currentLength >= precedingLength, `${group.id}: ${current.id}`);
        if (currentLength === precedingLength) {
          assert.ok(previous.sections.indexOf(current) > previous.sections.indexOf(preceding));
        }
      }
    }
  }
  assert.deepEqual(createSettingsPageConfig({ isDesktop: true }), original);
});

test("标题空白不影响长度，同长度稳定排序，Web 平台继续隐藏桌面分区", () => {
  const original = createSettingsPageConfig();
  const sorted = createSettingsPageConfig({ getSectionTitle: () => "同 长" });
  assert.deepEqual(sorted.settingsSectionGroups, original.settingsSectionGroups);
  assert.equal(
    sorted.settingsSections.some(
      (entry) => entry.id === "remoteControl" || entry.id === "computerUse",
    ),
    false,
  );
});
