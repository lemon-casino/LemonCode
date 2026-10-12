import assert from "node:assert/strict";
import test from "node:test";
import { mkdir } from "node:fs/promises";
import { register } from "tsx/esm/api";
import { fileURLToPath } from "node:url";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

register();
const { createAuthDriver } = await import("../../provider-node/src/index.ts");
const { PROVIDER_AUTH_CHANNELS } =
  await import("../../services/src/model-provider/providerAccountStoreSchema.ts");
const channels = [];
for (const channel of PROVIDER_AUTH_CHANNELS) {
  const driver = await createAuthDriver(channel.id);
  try {
    channels.push({ ...channel, methods: await driver.methods() });
  } finally {
    await driver.dispose?.();
  }
}
const artifacts = fileURLToPath(new URL("../../../.artifacts/oauth-settings", import.meta.url));

test(
  "all provider brand avatars load locally in light and dark desktop and mobile layouts",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    for (const width of [1280, 390]) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      await page.addInitScript((catalog) => {
        window.__providerAuthorizationChannels = catalog;
      }, channels);
      for (const theme of ["light", "dark"]) {
        await page.goto(
          `http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?theme=${theme}`,
        );
        await page.getByRole("tab", { name: "OAuth", exact: true }).click();
        const logos = page.getByTestId("oauth-provider-avatar").locator("[data-provider-logo]");
        assert.equal(await logos.count(), 25);
        await page.waitForFunction(() =>
          [...document.querySelectorAll('[data-testid="oauth-provider-avatar"] img')].every(
            (img) => img.complete && img.naturalWidth > 0,
          ),
        );
        const rendered = await logos.evaluateAll(async (elements) =>
          Promise.all(
            elements.map(async (element) => {
              const style = getComputedStyle(element);
              const mask = style.maskImage;
              const src =
                element.tagName === "IMG"
                  ? element.src
                  : /^url\(["']?(.+?)["']?\)$/.exec(mask)?.[1];
              const response = await fetch(src);
              return {
                key: element.dataset.providerLogo,
                mode: element.tagName,
                local: src.startsWith("data:image/") || new URL(src).origin === location.origin,
                loaded: response.ok,
                width: element.getBoundingClientRect().width,
                height: element.getBoundingClientRect().height,
                color: style.backgroundColor,
                parentColor: getComputedStyle(element.parentElement).color,
              };
            }),
          ),
        );
        assert.ok(
          rendered.every(
            (logo) => logo.local && logo.loaded && logo.width === 24 && logo.height === 24,
          ),
          JSON.stringify(
            rendered.filter(
              (logo) => !logo.local || !logo.loaded || logo.width !== 24 || logo.height !== 24,
            ),
          ),
        );
        assert.ok(
          rendered
            .filter((logo) => logo.mode !== "IMG")
            .every((logo) => logo.color === logo.parentColor),
        );
        assert.equal(rendered.find((logo) => logo.key === "workbuddy")?.mode, "IMG");
        assert.equal(
          await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
          true,
        );
        await mkdir(artifacts, { recursive: true });
        // 滚动属于内部设置区域；完整画面只在测试中展开其高度，便于逐品牌核对素材。
        await page.getByTestId("fixture-settings-scroll").evaluate((element) => {
          element.style.height = "auto";
          element.style.overflow = "visible";
        });
        await page.addStyleTag({
          content: "html, body, #root { height: auto !important; overflow: visible !important; }",
        });
        await page.screenshot({
          path: `${artifacts}/brand-icons-${theme}-${width}.png`,
          fullPage: true,
          animations: "disabled",
        });
      }
      await page.close();
    }
  },
);

for (const width of [1280, 390]) {
  test(
    `all OAuth methods are localized with one selected-method action at ${width}px`,
    { timeout: 120_000 },
    async (t) => {
      const { browser, port } = await startWorkflowProgressBrowser(t);
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.addInitScript((catalog) => {
        window.__providerAuthorizationChannels = catalog;
      }, channels);
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?theme=light`);
      const oauth = page.getByRole("tab", { name: "OAuth", exact: true });
      await oauth.waitFor();
      assert.equal(await oauth.getAttribute("aria-selected"), "true");
      await page.getByRole("tab", { name: "API", exact: true }).click();
      const apiHeight = (
        await page.getByTestId("model-provider-template-item-fixture-api").boundingBox()
      ).height;
      await page.getByRole("tab", { name: "OAuth", exact: true }).click();
      assert.equal(await page.getByTestId("oauth-provider-avatar").count(), 25);
      assert.equal(
        (await page.getByTestId("oauth-channel-workbuddy-ai").boundingBox()).height,
        apiHeight,
      );
      await mkdir(artifacts, { recursive: true });
      await page.screenshot({
        path: `${artifacts}/oauth-picker-${width}.png`,
        animations: "disabled",
      });
      for (const channel of channels) {
        await page.getByTestId(`oauth-channel-${channel.id}`).click();
        const dialog = page.getByRole("dialog");
        const select = dialog.getByLabel("授权方式", { exact: true });
        for (const method of channel.methods) {
          await select.click();
          const options = page.getByRole("option");
          const labels = await options.allTextContents();
          assert.equal(labels.length, channel.methods.length);
          assert.ok(
            labels.every((label) => /[\u3400-\u9fff]/u.test(label)),
            channel.id,
          );
          await options.nth(channel.methods.indexOf(method)).click();
          if (method.kind === "import") {
            assert.equal(
              await dialog.getByRole("button", { name: "开始授权", exact: true }).count(),
              0,
            );
            await dialog.getByRole("button", { name: "导入账号", exact: true }).waitFor();
          } else {
            const button = dialog.getByRole("button", {
              name: method.kind === "local" ? "读取客户端登录" : "开始授权",
              exact: true,
            });
            assert.equal(await button.count(), 1);
            const a = await select.boundingBox();
            const b = await button.boundingBox();
            assert.ok(
              a.width <= 288,
              `authorization selector should keep a normal width: ${a.width}`,
            );
            const row = await dialog.getByTestId("oauth-authorization-controls").boundingBox();
            assert.ok(a.x >= row.x && b.x + b.width <= row.x + row.width + 1);
            if (channel.id === "bigmodel" && method.id === "1")
              await page.screenshot({
                path: `${artifacts}/authorization-controls-${width}.png`,
                animations: "disabled",
              });
            assert.ok(
              Math.abs(a.y + a.height / 2 - b.y - b.height / 2) < 3,
              JSON.stringify({ channel: channel.id, method: method.id, select: a, button: b }),
            );
          }
        }
        assert.equal(await page.evaluate(() => window.__providerAccounts.starts.length), 0);
        await page.keyboard.press("Escape");
        await dialog.waitFor({ state: "detached" });
      }
      await page.getByTestId("oauth-channel-workbuddy-ai").click();
      const dialog = page.getByRole("dialog");
      await dialog.getByText(/无需安装 WorkBuddy AI 客户端/u).waitFor();
      await page.screenshot({
        path: `${artifacts}/workbuddy-browser-${width}.png`,
        animations: "disabled",
      });
      await dialog.getByRole("button", { name: "开始授权", exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.__providerAccounts.starts[0]), {
        channelId: "workbuddy-ai",
        methodId: "0",
        inputs: {},
      });
      await dialog.getByRole("button", { name: "取消授权", exact: true }).click();
      await dialog.getByLabel("授权方式", { exact: true }).click();
      await page.getByRole("option", { name: "读取 WorkBuddy AI 客户端登录", exact: true }).click();
      await dialog.getByText(/不会读取 LCode 中已保存的浏览器授权/u).waitFor();
      await dialog.getByRole("button", { name: "读取客户端登录", exact: true }).click();
      assert.deepEqual(await page.evaluate(() => window.__providerAccounts.starts[1]), {
        channelId: "workbuddy-ai",
        methodId: "1",
        inputs: {},
      });
      await dialog.getByRole("button", { name: "取消授权", exact: true }).click();
      assert.equal(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        true,
      );
      assert.deepEqual(errors, []);
    },
  );
}

test(
  "English keeps driver labels and device authorization keeps its code in Chinese",
  { timeout: 90_000 },
  async (t) => {
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    await page.addInitScript((catalog) => {
      window.__providerAuthorizationChannels = catalog;
    }, channels);
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/provider-accounts.html?locale=en-US`);
    await page.getByRole("tab", { name: "OAuth", exact: true }).click();
    await page.getByTestId("oauth-channel-workbuddy-ai").click();
    await page.getByLabel("Authorization method", { exact: true }).click();
    assert.deepEqual(
      await page.getByRole("option").allTextContents(),
      channels
        .find((channel) => channel.id === "workbuddy-ai")
        .methods.map((method) => method.label),
    );
    await page.getByRole("option").first().click();
    await page.keyboard.press("Escape");
    await page.getByRole("dialog").waitFor({ state: "detached" });
    await page.goto(`http://127.0.0.1:${port}/test/fixtures/provider-accounts.html`);
    await page.getByRole("tab", { name: "OAuth", exact: true }).click();
    await page.getByTestId("oauth-channel-copilot").click();
    await page.evaluate(() => {
      window.__providerAccounts.authorizationInstructions = "Enter code: ABCD-1234";
    });
    await page.getByRole("button", { name: "开始授权", exact: true }).click();
    await page
      .getByText("在 GitHub 授权页面输入并确认验证码：ABCD-1234。完成后会自动返回结果。", {
        exact: true,
      })
      .waitFor();
  },
);
