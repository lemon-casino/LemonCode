import assert from "node:assert/strict";

/*
 * 控件迁移首版的验收子测试（方案 specs/frontend-ui-component-migration.md C03–C06）。
 * 注入签名与 component-overlay-cases.mjs 一致：{ t, page, load, visibleBounds }。
 *
 * 断言写的是「迁移完成后」的 DOM 契约：packages/ui/src/components/ui/checkbox.tsx 渲染
 * button[role=checkbox][aria-checked][data-state=checked|unchecked|indeterminate]，
 * input.tsx / textarea.tsx 分别带 data-slot="input" / "textarea"。组件迁移尚未发生，
 * 当前实现仍是原生 checkbox/input/textarea，因此这些契约断言此刻失败是预期，
 * 不为此放宽断言、加延时或改动业务组件。
 */

const SYNC_SELECT_ALL = "全选";
const SYNC_SHOW_EXISTING = "显示远端已存在";
const SYNC_START = "同步已选项";

/** 迁移后 checkbox 的 DOM 契约：aria-checked 属性 + data-state 三态 + 可选禁用。 */
async function assertMigratedCheckbox(locator, { ariaChecked, disabled } = {}) {
  if (ariaChecked !== undefined) {
    assert.equal(await locator.getAttribute("aria-checked"), ariaChecked);
    assert.equal(
      await locator.getAttribute("data-state"),
      ariaChecked === "mixed" ? "indeterminate" : ariaChecked === "true" ? "checked" : "unchecked",
    );
  }
  if (disabled !== undefined) {
    assert.equal(await locator.isDisabled(), disabled);
  }
}

/**
 * 三类同步面板共用的选择契约：行级三态、半选点击全选、全选点击清空、
 * 已存在项禁用且不进入选择、过滤开关、零选择时提交禁用。返回全选框供 payload 断言前重新全选。
 */
async function runSyncSelectionContract({ dialog, rows, existingRow }) {
  const missingRows = rows.filter((row) => row !== existingRow);
  const rowCheckbox = (name) => dialog.getByRole("checkbox", { name, exact: true });
  const selectAll = dialog.getByRole("checkbox", { name: SYNC_SELECT_ALL, exact: true });

  for (const row of rows) {
    await rowCheckbox(row).waitFor();
  }
  // 行可访问名继续来自既有 aria-labelledby（候选名）；迁移后 role 来自 Radix Root。
  assert.equal(await rowCheckbox(missingRows[0]).getAttribute("role"), "checkbox");
  for (const row of rows) {
    await assertMigratedCheckbox(rowCheckbox(row), {
      ariaChecked: row === existingRow ? "false" : "true",
      disabled: row === existingRow,
    });
  }

  // 已存在/禁用项不进入选择：强制点击也不改变状态。
  await rowCheckbox(existingRow).click({ force: true });
  await assertMigratedCheckbox(rowCheckbox(existingRow), { ariaChecked: "false", disabled: true });

  // 单选切换：取消一个 → 全选半选；重新勾上 → 全选全选。
  await rowCheckbox(missingRows[0]).press("Space");
  await assertMigratedCheckbox(rowCheckbox(missingRows[0]), { ariaChecked: "false" });
  await assertMigratedCheckbox(selectAll, { ariaChecked: "mixed" });
  await rowCheckbox(missingRows[0]).press("Space");
  await assertMigratedCheckbox(selectAll, { ariaChecked: "true" });

  // 半选态点击全选 → 全部勾上；全选态点击 → 全部清空。
  await rowCheckbox(missingRows[0]).press("Space");
  await assertMigratedCheckbox(selectAll, { ariaChecked: "mixed" });
  await selectAll.click();
  for (const row of missingRows) {
    await assertMigratedCheckbox(rowCheckbox(row), { ariaChecked: "true" });
  }
  await selectAll.click();
  for (const row of missingRows) {
    await assertMigratedCheckbox(rowCheckbox(row), { ariaChecked: "false" });
  }

  // 零选择时提交按钮禁用。
  const start = dialog.getByRole("button", { name: SYNC_START });
  assert.equal(await start.isDisabled(), true);

  // 过滤开关：隐藏已存在项时可选集合不变；迁移后同样是组件 Checkbox。
  const showExisting = dialog.getByRole("checkbox", { name: SYNC_SHOW_EXISTING, exact: true });
  await assertMigratedCheckbox(showExisting, { ariaChecked: "true" });
  await showExisting.click();
  await rowCheckbox(existingRow).waitFor({ state: "hidden" });
  await assertMigratedCheckbox(selectAll, { ariaChecked: "false" });
  await showExisting.click();
  await rowCheckbox(existingRow).waitFor();

  // 重新全选并提交，payload 断言由各面板子测试继续。
  await selectAll.click();
  await start.click();
  return { selectAll };
}

export async function runSyncCheckboxCases({ t, page, load }) {
  await t.test(
    "C03 MCP sync dialog: checkbox contract, select-all states, payload excludes existing items",
    async () => {
      await load("component-migration-sync.html", "?scenario=mcp");
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await runSyncSelectionContract({
        dialog,
        rows: ["Notes Server", "Search Server", "Legacy Server"],
        existingRow: "Legacy Server",
      });
      await page.waitForFunction(() => window.__sync.mcp.exports.length > 0);
      const exports = await page.evaluate(() => window.__sync.mcp.exports);
      assert.deepEqual(
        exports
          .map((call) => call.serverIds)
          .flat()
          .sort(),
        ["mcp-notes", "mcp-search"],
      );
      const imports = await page.evaluate(() => window.__sync.mcp.imports);
      assert.equal(imports.length, 1);
      assert.equal(imports[0].overwrite, false);
      assert.deepEqual(imports[0].servers.map((server) => server.name).sort(), [
        "Notes Server",
        "Search Server",
      ]);
    },
  );

  await t.test(
    "C03 plugin sync dialog: checkbox contract and per-plugin export payload excludes existing items",
    async () => {
      await load("component-migration-sync.html", "?scenario=plugin");
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await runSyncSelectionContract({
        dialog,
        rows: ["Notes Plugin", "Slides Plugin", "Legacy Plugin"],
        existingRow: "Legacy Plugin",
      });
      await page.waitForFunction(() => window.__sync.plugin.exports.length > 0);
      const exports = await page.evaluate(() => window.__sync.plugin.exports);
      // Plugin 面板逐个导出：pluginIds 取自 inline 候选 id，已存在项不得出现。
      assert.deepEqual(
        exports
          .map((call) => call.pluginIds)
          .flat()
          .sort(),
        ["plugin-notes", "plugin-slides"],
      );
      const imports = await page.evaluate(() => window.__sync.plugin.imports);
      assert.equal(imports.length, 2);
      assert.deepEqual(
        imports.map((call) => call.overwrite),
        [false, false],
      );
    },
  );

  await t.test(
    "C03 skill sync dialog: checkbox contract and archive payload excludes existing items",
    async () => {
      await load("component-migration-sync.html", "?scenario=skill");
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      await runSyncSelectionContract({
        dialog,
        rows: ["Review Skill", "Slides Skill", "Legacy Skill"],
        existingRow: "Legacy Skill",
      });
      await page.waitForFunction(() => window.__sync.skill.exports.length > 0);
      const exports = await page.evaluate(() => window.__sync.skill.exports);
      assert.deepEqual(
        exports
          .map((call) => call.skillIds)
          .flat()
          .sort(),
        ["skill-review", "skill-slides"],
      );
      const imports = await page.evaluate(() => window.__sync.skill.imports);
      assert.equal(imports.length, 1);
      assert.equal(imports[0].overwrite, false);
    },
  );

  await t.test(
    "C03 MCP sync dialog with zero selectable items keeps select-all and submit disabled",
    async () => {
      await load("component-migration-sync.html", "?scenario=mcp&empty=1");
      const dialog = page.getByRole("dialog");
      await dialog.waitFor();
      for (const row of ["Notes Server", "Search Server", "Legacy Server"]) {
        await assertMigratedCheckbox(dialog.getByRole("checkbox", { name: row, exact: true }), {
          ariaChecked: "false",
          disabled: true,
        });
      }
      await assertMigratedCheckbox(
        dialog.getByRole("checkbox", { name: SYNC_SELECT_ALL, exact: true }),
        {
          ariaChecked: "false",
          disabled: true,
        },
      );
      assert.equal(await dialog.getByRole("button", { name: SYNC_START }).isDisabled(), true);
    },
  );
}

export async function runShareConfirmationCases({ t, page, load, visibleBounds }) {
  await t.test(
    "C04 share confirmation dock: title edit, consent gate, single submit and focus refs",
    async () => {
      await page.emulateMedia({ reducedMotion: "reduce" });
      await load("component-migration-share.html");
      const dock = page.getByTestId("conversation-share-confirmation-dock");
      await dock.waitFor();

      // 分享标题：迁移后是共享 Input，编辑仍进入 onTitleChange 草稿；权限不被触碰。
      const titleInput = page.getByRole("textbox", { name: "分享标题" });
      await titleInput.waitFor();
      assert.equal(await titleInput.getAttribute("data-slot"), "input");
      await titleInput.fill("发布指南");
      assert.deepEqual(await page.evaluate(() => window.__share.titleChanges), ["发布指南"]);
      assert.deepEqual(await page.evaluate(() => window.__share.accessChanges), []);
      assert.equal(
        await page
          .getByRole("radio", { name: "拥有链接的人可导入并继续" })
          .getAttribute("aria-checked"),
        "true",
      );

      // 知情同意：迁移后是 button[role=checkbox]，aria-checked/data-state 由组件维护。
      const checkbox = page.getByTestId("conversation-share-disclosure-checkbox");
      assert.equal(await checkbox.getAttribute("role"), "checkbox");
      assert.equal(await checkbox.getAttribute("aria-checked"), "false");
      assert.equal(await checkbox.getAttribute("data-state"), "unchecked");

      // 同意门槛：未勾选时点击确认不触发 onConfirm，只把焦点引到勾选框（焦点引用有效）。
      const confirm = page.getByTestId("conversation-share-confirm");
      await confirm.click();
      assert.equal(await page.evaluate(() => window.__share.confirms), 0);
      await visibleBounds(page.getByTestId("conversation-share-disclosure"), 1280, 720);
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
        "conversation-share-disclosure-checkbox",
      );

      await checkbox.press("Space");
      assert.equal(await checkbox.getAttribute("aria-checked"), "true");
      assert.equal(await checkbox.getAttribute("data-state"), "checked");
      assert.deepEqual(await page.evaluate(() => window.__share.consentChanges), [true]);

      // 提交单次触发：一次点击恰好一次 onConfirm，不因事件冒泡重复。
      await confirm.click();
      assert.equal(await page.evaluate(() => window.__share.confirms), 1);
      await confirm.click();
      assert.equal(await page.evaluate(() => window.__share.confirms), 2);

      // 取消勾选后门槛重新生效，确认点击再次被拦截并还焦到勾选框。
      await checkbox.press("Space");
      assert.deepEqual(await page.evaluate(() => window.__share.consentChanges), [true, false]);
      await confirm.click();
      assert.equal(await page.evaluate(() => window.__share.confirms), 2);
      assert.equal(
        await page.evaluate(() => document.activeElement?.getAttribute("data-testid")),
        "conversation-share-disclosure-checkbox",
      );
    },
  );
}

export async function runWhiteboardSliderCases({ t, page, load }) {
  await t.test(
    "C05 slider adapter: initial 5, range 2-18, step 1, continuous onChange and Home/End",
    async () => {
      // 迁移前 fixture 因 @/components/controls/slider.js 不存在而无法加载；
      // 该失败发生在 fixture-ready 等待处，属于预期（方案：先补场景，再实施适配层）。
      await load("component-migration-slider.html");
      const slider = page.getByRole("slider", { name: "笔触粗细" });
      await slider.waitFor();
      // aria-label 必须透传，值域与初值通过 slider 语义属性暴露。
      assert.equal(await slider.getAttribute("aria-valuemin"), "2");
      assert.equal(await slider.getAttribute("aria-valuemax"), "18");
      assert.equal(await slider.getAttribute("aria-valuenow"), "5");
      const readout = page.getByTestId("stroke-width");

      // 方向键与 Home/End：每次按键一次 onChange，连续进入 setStrokeWidth（readout 即受控值）。
      await slider.focus();
      const pressKey = async (key, expected) => {
        await slider.press(key);
        assert.equal(await slider.getAttribute("aria-valuenow"), String(expected));
        assert.equal(await readout.innerText(), String(expected));
      };
      await pressKey("ArrowUp", 6);
      await pressKey("ArrowRight", 7);
      await pressKey("ArrowDown", 6);
      await pressKey("Home", 2);
      await pressKey("End", 18);
      const keyboardChanges = await page.evaluate(() => window.__slider.changes.slice());
      assert.deepEqual(keyboardChanges, [6, 7, 6, 2, 18]);

      // 拖动连续触发：松开前每一步移动都已进入 setStrokeWidth，不允许 onChangeEnd 延迟提交。
      // Mantine useMove 用 rAF 合并 onChange 且新事件会取消上一次未渲染的值，
      // 因此分段扫过轨道、每段之间等双 rAF，保证每步的值真正落地（诊断依据：
      // node_modules/@mantine/hooks/esm/use-move/use-move.mjs 的 onScrub/cancelAnimationFrame）。
      const surface = page.getByTestId("slider-surface");
      const box = await surface.boundingBox();
      assert.ok(box, "slider surface must be measurable");
      const centerY = box.y + box.height / 2;
      const startX = box.x + 2;
      const endX = box.x + box.width + 20 / 6; // 越过右缘，保证终点取到 max
      await page.mouse.move(startX, centerY);
      await page.mouse.down();
      let midDragDistinct = 0;
      for (let step = 1; step <= 6; step++) {
        await page.mouse.move(startX + ((endX - startX) * step) / 6, centerY);
        await page.evaluate(
          () =>
            new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))),
        );
        const dragSoFar = (await page.evaluate(() => window.__slider.changes.slice())).slice(
          keyboardChanges.length,
        );
        midDragDistinct = Math.max(midDragDistinct, new Set(dragSoFar).size);
      }
      await page.mouse.up();
      const dragChanges = (await page.evaluate(() => window.__slider.changes.slice())).slice(
        keyboardChanges.length,
      );
      assert.ok(
        midDragDistinct >= 2,
        `onChange must fire continuously during drag: ${JSON.stringify(dragChanges)}`,
      );
      assert.deepEqual(
        dragChanges,
        [...dragChanges].sort((a, b) => a - b),
        `drag values must be non-decreasing within range: ${JSON.stringify(dragChanges)}`,
      );
      assert.ok(
        dragChanges.every((value) => Number.isInteger(value) && value >= 2 && value <= 18),
        `step=1 keeps integer values in [2,18]: ${JSON.stringify(dragChanges)}`,
      );
      assert.equal(dragChanges.at(-1), 18);
      assert.equal(await readout.innerText(), "18");

      // label=null：不出数值浮层——失焦后滑杆区域内不得出现数值文本。
      await page.mouse.click(5, 5);
      const surfaceText = await surface.innerText();
      assert.ok(
        !/\d/.test(surfaceText),
        `label=null must not render a numeric overlay: ${JSON.stringify(surfaceText)}`,
      );
    },
  );
}

export async function runAutomationComposerCases({ t, page, load }) {
  await t.test(
    "C06 automation composer: auto height 116-156, long content scroll, IME input, onInput count, Enter does not submit",
    async () => {
      await load("component-migration-composer.html");
      const textarea = page.getByRole("textbox", { name: "指令" });
      await textarea.waitFor();
      // 迁移后必须是共享 Textarea（data-slot=textarea），而不是裸 textarea。
      assert.equal(await textarea.getAttribute("data-slot"), "textarea");

      const geometry = () =>
        textarea.evaluate((el) => ({
          height: el.getBoundingClientRect().height,
          inlineHeight: el.style.height,
          overflowY: getComputedStyle(el).overflowY,
          scrollHeight: el.scrollHeight,
        }));

      // 短内容：自动高度停在 116px，内部不滚动。
      let size = await geometry();
      assert.ok(
        Math.abs(size.height - 116) <= 1,
        `short content sits at 116px: ${JSON.stringify(size)}`,
      );
      assert.equal(size.overflowY, "hidden");

      // 逐键输入：每个 input 事件触发一次 onInput，onInput 次数与内容保持。
      await textarea.press("H");
      await textarea.press("i");
      let inputs = await page.evaluate(() => window.__composer.inputs.slice());
      assert.equal(inputs.length, 2);
      assert.equal(inputs.at(-1).value, "Hi");
      size = await geometry();
      assert.ok(
        Math.abs(size.height - 116) <= 1,
        `short content stays at 116px: ${JSON.stringify(size)}`,
      );

      // 中文组合输入：composition 期间的 input 不丢且 isComposing 透传，结束后草稿值收敛。
      // 精确计数只针对离散输入；fill 的整段替换按行拆分会触发多次 input，不做计数断言。
      await textarea.evaluate((el) => {
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLTextAreaElement.prototype,
          "value",
        ).set;
        const fireComposition = (type, data) =>
          el.dispatchEvent(new CompositionEvent(type, { bubbles: true, data }));
        const fireInput = (data, isComposing) =>
          el.dispatchEvent(
            new InputEvent("input", { bubbles: true, data, isComposing, inputType: "insertText" }),
          );
        el.focus();
        fireComposition("compositionstart", "nihao");
        setValue.call(el, "Hi x nihao");
        fireInput("ni", true);
        fireComposition("compositionupdate", "nihao");
        setValue.call(el, "Hi x 你好");
        fireInput("nihao", true);
        fireComposition("compositionend", "nihao");
        fireInput("nihao", false);
      });
      inputs = await page.evaluate(() => window.__composer.inputs.slice());
      // 逐键 2 次 + 组合期 2 次 + 组合结束 1 次。
      assert.equal(inputs.length, 5);
      assert.equal(inputs.filter((entry) => entry.isComposing).length, 2);
      assert.equal(inputs.at(-1).value, "Hi x 你好");
      assert.equal(await textarea.inputValue(), "Hi x 你好");

      // 多行长文：封顶 156px，超出部分在正文内部滚动。
      const longText = Array.from({ length: 20 }, (_, index) => `自动执行任务 ${index}`).join("\n");
      await textarea.fill(longText);
      size = await geometry();
      assert.ok(
        Math.abs(size.height - 156) <= 1,
        `long content caps at 156px: ${JSON.stringify(size)}`,
      );
      assert.ok(size.scrollHeight > 156, `content must exceed the cap: ${JSON.stringify(size)}`);
      assert.equal(size.overflowY, "auto");
      const scrolled = await textarea.evaluate((el) => {
        el.scrollTop = el.scrollHeight;
        return el.scrollTop;
      });
      assert.ok(scrolled > 0, "long content must scroll inside the textarea");

      // 手动高度：输入不再无条件覆盖用户调整过的尺寸（既有手动高度处理）。
      await textarea.evaluate((el) => {
        el.style.height = "200px";
      });
      await textarea.press("x");
      size = await geometry();
      assert.equal(size.inlineHeight, "200px");

      // Enter 不意外提交：textarea 内按 Enter 只换行；点保存按钮才走提交边界。
      await textarea.fill("无换行文本");
      assert.equal(await page.evaluate(() => window.__composer.submits), 0);
      await textarea.press("Enter");
      assert.equal(await textarea.inputValue(), "无换行文本\n");
      assert.equal(await page.evaluate(() => window.__composer.submits), 0);
      await page.getByRole("button", { name: "保存" }).click();
      assert.equal(await page.evaluate(() => window.__composer.submits), 1);
    },
  );
}
