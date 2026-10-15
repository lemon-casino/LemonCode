import assert from "node:assert/strict";

export async function verifyCompactFooter(bar) {
  const geometry = await bar.evaluate((element) => {
    const shell = element.closest('[data-composer-statusbar-slot="inside"]').parentElement;
    return {
      height: element.getBoundingClientRect().height,
      bottomGap: shell.getBoundingClientRect().bottom - element.getBoundingClientRect().bottom,
    };
  });
  assert.ok(geometry.height <= 28, JSON.stringify(geometry));
  assert.ok(geometry.bottomGap <= 9, JSON.stringify(geometry));
}

export async function verifyStatusBarPlacement(composer, position) {
  const geometry = await composer.evaluate((element) => {
    const slot = element.querySelector("[data-composer-statusbar-slot]");
    const toolbar = element.querySelector("[data-composer-leading-actions]").parentElement;
    const shell = toolbar.parentElement;
    return {
      inside: shell.contains(slot),
      shell: shell.getBoundingClientRect().toJSON(),
      toolbar: toolbar.getBoundingClientRect().toJSON(),
      editor: element
        .querySelector('[data-testid="v4-composer-input"]')
        .getBoundingClientRect()
        .toJSON(),
      slot: slot.getBoundingClientRect().toJSON(),
    };
  });
  assert.equal(geometry.inside, position !== "below", JSON.stringify(geometry));
  if (position === "below") assert.ok(geometry.slot.top >= geometry.shell.bottom - 1);
  if (position === "inside") assert.ok(geometry.slot.top >= geometry.toolbar.bottom - 1);
  if (position === "above") {
    assert.ok(geometry.slot.top >= geometry.editor.bottom - 1, JSON.stringify(geometry));
    assert.ok(geometry.slot.bottom <= geometry.toolbar.top + 1, JSON.stringify(geometry));
  }
}

export async function verifyNewConversationStatusBar(page, composer, bar) {
  for (const scenario of ["empty", "draft"]) {
    await page.evaluate((name) => globalThis.__tokenFixture.scenario(name), scenario);
    await bar.waitFor({ state: "detached" });
    assert.ok(await composer.getByTestId("v4-composer-input").isVisible());
    assert.equal(await composer.locator("[data-composer-statusbar-slot]").isVisible(), false);
  }
  await page.evaluate(() => globalThis.__tokenFixture.scenario("first-request"));
  await bar.waitFor();
  assert.match(await bar.innerText(), /会话/);
  await verifyStatusBarPlacement(composer, "above");
  await page.evaluate(() => globalThis.__tokenFixture.scenario("average"));
}

export async function verifyTokenUsageInteractions(page, composer, bar) {
  const sessionMetric = bar.getByTestId("token-usage-session");
  const detail = page.getByTestId("token-usage-detail-session");
  const editor = composer.getByTestId("v4-composer-input");
  await editor.focus();
  await sessionMetric.hover();
  await detail.waitFor();
  assert.ok(await editor.evaluate((element) => element === document.activeElement));
  await detail.hover();
  // 等待超过跨越浮层间隙的关闭延迟，确认面板本身也属于悬停区域。
  await page.waitForTimeout(180);
  assert.ok(await detail.isVisible());
  await page.mouse.move(5, 5);
  await detail.waitFor({ state: "hidden" });
  assert.ok(await editor.evaluate((element) => element === document.activeElement));
  await sessionMetric.hover();
  await detail.waitFor();
  await bar.getByTestId("token-usage-cache").hover();
  const hoverCache = page.getByTestId("token-usage-detail-cache");
  await hoverCache.waitFor();
  await detail.waitFor({ state: "hidden" });
  await hoverCache.hover();
  await page.waitForTimeout(180);
  assert.ok(await hoverCache.isVisible());
  await page.mouse.move(5, 5);
  await hoverCache.waitFor({ state: "hidden" });
  await sessionMetric.click();
  await detail.waitFor();
  await page.mouse.move(5, 5);
  await page.waitForTimeout(180);
  assert.ok(await detail.isVisible());
  await sessionMetric.click();
  await detail.waitFor({ state: "hidden" });
  await page.mouse.move(5, 5);
  await sessionMetric.focus();
  await page.keyboard.press("Enter");
  await detail.waitFor();
  assert.match(await detail.innerText(), /420,000/);
  assert.match(await detail.innerText(), /50,000/);
  await page.keyboard.press("Escape");
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("data-testid") === "token-usage-session",
  );
  const childSample = page.getByTestId("subagents-sample");
  await childSample.getByTestId("token-usage-subagents").click();
  const childDetail = page.getByTestId("token-usage-detail-subagents");
  await childDetail.waitFor();
  assert.match(await childDetail.innerText(), /部分子代理用量暂不可用/);
  assert.match(await childDetail.innerText(), /≥320/);
  await page.keyboard.press("Escape");
  await childDetail.waitFor({ state: "hidden" });
}
