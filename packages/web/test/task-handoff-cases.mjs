import assert from "node:assert/strict";

export async function runTaskHandoffCases({ t, page, url, calls }) {
  const configure = (method, value) =>
    page.evaluate(({ method, value }) => globalThis.__taskHandoffFixture[method](value), {
      method,
      value,
    });
  const open = async () => {
    await page.getByTestId("sidebar-row-default").click({ button: "right" });
    await page.getByTestId("task-handoff").waitFor();
  };
  await t.test("desktop handoff preserves draft and sends no conversation command", async () => {
    await page.goto(url + "?sidebar&handoff");
    await page.getByTestId("handoff-draft").waitFor();
    await open();
    assert.notEqual(await page.getByTestId("task-handoff").getAttribute("aria-disabled"), "true");
    await page.getByTestId("task-handoff").click();
    assert.match(
      await page.getByTestId("handoff-draft").inputValue(),
      /^preserved draft\n.*#sidebar-worktree/,
    );
    assert.equal((await calls()).filter((c) => /send|submit|fork/i.test(c.method)).length, 0);
  });
  await t.test(
    "self reference, different identity and unavailable composer stay disabled",
    async () => {
      for (const [method, value] of [
        ["setTarget", "sidebar-worktree"],
        ["setIdentity", "remote-other"],
        ["setEnabled", false],
      ]) {
        await page.goto(url + "?sidebar&handoff");
        await page.getByTestId("handoff-draft").waitFor();
        await configure(method, value);
        await open();
        assert.equal(await page.getByTestId("task-handoff").getAttribute("aria-disabled"), "true");
        await page.keyboard.press("Escape");
      }
    },
  );
  await t.test("narrow screen menu appends editable context without navigation", async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(url + "?sidebar&handoff");
    await page.getByTestId("handoff-draft").waitFor();
    await page.getByTestId("fork-mobile-menu").click();
    await page.getByTestId("task-handoff").click();
    const field = page.getByTestId("handoff-draft");
    assert.match(await field.inputValue(), /ReadSessionContext/);
    await field.fill("edited context");
    assert.equal(await field.inputValue(), "edited context");
    assert.equal((await calls()).filter((c) => /send|submit|fork/i.test(c.method)).length, 0);
  });
  await t.test("saving a reusable summary is an explicit editable draft", async () => {
    await page.goto(url + "?sidebar&handoff");
    await page.getByTestId("handoff-draft").waitFor();
    await open();
    await page.getByTestId("task-handoff-save").click();
    assert.match(await page.getByTestId("handoff-draft").inputValue(), /persistCapsule=true/);
    assert.equal((await calls()).filter((c) => /send|submit|fork/i.test(c.method)).length, 0);
  });
  await t.test("Chinese and English menus remain keyboard operable in both themes", async () => {
    for (const english of [false, true]) {
      for (const dark of [false, true]) {
        await page.goto(url + "?sidebar&handoff" + (english ? "&english" : ""));
        await page.getByTestId("handoff-draft").waitFor();
        await page.evaluate(
          (dark) => document.documentElement.classList.toggle("dark", dark),
          dark,
        );
        const trigger = page.getByTestId("fork-mobile-menu");
        await trigger.focus();
        await page.keyboard.press("Enter");
        const item = page.getByTestId("task-handoff");
        await item.waitFor();
        assert.match(await item.innerText(), english ? /current conversation/i : /当前会话/);
        await item.focus();
        await page.keyboard.press("Enter");
        assert.match(await page.getByTestId("handoff-draft").inputValue(), /#sidebar-worktree/);
        assert.equal((await calls()).filter((c) => /send|submit|fork/i.test(c.method)).length, 0);
      }
    }
  });
}
