import assert from "node:assert/strict";

export async function verifyModelMenuCompact(rows) {
  await rows.first().evaluate(async (element) => {
    const menu = element.closest(
      '[data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"]',
    );
    // Radix 碰撞定位可取消入场动画；结束和取消都表示该动画不再影响几何读数。
    await Promise.allSettled(menu.getAnimations().map((animation) => animation.finished));
  });
  await rows.first().waitFor();
  const geometry = await rows.evaluateAll((elements) =>
    elements.map((element) => {
      const column = element.querySelector("[data-model-billing-column]").getBoundingClientRect();
      const badge = element.querySelector("[data-model-billing]")?.getBoundingClientRect();
      const indicator = element
        .querySelector(
          '[data-model-status-column], [data-slot="dropdown-menu-radio-item-indicator"]',
        )
        ?.getBoundingClientRect();
      const menu = element.closest(
        '[data-slot="dropdown-menu-content"], [data-slot="dropdown-menu-sub-content"]',
      );
      const right = menu.getBoundingClientRect().left + menu.clientLeft + menu.clientWidth;
      return {
        columnWidth: column.width,
        badgeWidth: badge?.width ?? 0,
        columnRight: column.right,
        statusRight: indicator?.right ?? null,
        statusWidth: indicator?.width ?? 0,
        trailingGap: indicator ? right - indicator.right : null,
      };
    }),
  );
  const widestBadge = Math.max(...geometry.map((row) => row.badgeWidth));
  assert.ok(geometry.length > 0);
  const widestStatus = Math.max(...geometry.map((row) => row.statusWidth));
  for (const row of geometry) {
    assert.ok(
      Math.abs(row.columnWidth - widestBadge) <= 1,
      `billing column has spare width: ${JSON.stringify({ row, widestBadge })}`,
    );
    if (row.statusRight !== null) {
      const statusGap = row.statusRight - widestStatus - row.columnRight;
      assert.ok(statusGap >= 0 && statusGap <= 12, `billing-to-check gap: ${JSON.stringify(row)}`);
    }
    if (row.trailingGap !== null)
      assert.ok(
        row.trailingGap >= 0 && row.trailingGap <= 12,
        `check-to-scroll edge gap: ${JSON.stringify(row)}`,
      );
  }
}
