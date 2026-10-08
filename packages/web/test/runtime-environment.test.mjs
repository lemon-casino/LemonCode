import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { once } from "node:events";
import { access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { stripVTControlCharacters } from "node:util";
import test from "node:test";
import { chromium } from "playwright-core";
import { runRuntimeEnvironmentComposerCases } from "./runtime-environment-composer-cases.mjs";
import { runRuntimeEnvironmentScopeCases } from "./runtime-environment-scope-cases.mjs";

// 真实共享组件/hook，只有 Host 合同以确定性桩替换；不证明生产 owner 的安装/进程/Git 副作用。
test(
  "runtime environment UI: scoped facts, diagnostics, services and candidate receipts",
  { timeout: 240_000 },
  async (t) => {
    const socket = createServer();
    socket.listen(0, "127.0.0.1");
    await once(socket, "listening");
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const server = spawn(
      process.execPath,
      [
        fileURLToPath(new URL("./bin/vite.js", import.meta.resolve("vite/package.json"))),
        "--host",
        "127.0.0.1",
        "--port",
        String(port),
        "--strictPort",
      ],
      {
        cwd: fileURLToPath(new URL("../", import.meta.url)),
        windowsHide: true,
        stdio: "pipe",
      },
    );
    let output = "";
    server.stdout.on("data", (data) => {
      output += data;
    });
    server.stderr.on("data", (data) => {
      output += data;
    });
    let browser;
    t.after(async () => {
      await browser?.close();
      if (process.platform === "win32") {
        const stop = spawn("taskkill", ["/PID", String(server.pid), "/T", "/F"], {
          windowsHide: true,
          stdio: "ignore",
        });
        await once(stop, "exit");
      } else {
        server.kill("SIGTERM");
        if (server.exitCode === null) await once(server, "exit");
      }
    });
    assert.ok(
      await new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), 45_000);
        const check = () => {
          if (stripVTControlCharacters(output).includes("Local:")) {
            clearTimeout(timer);
            resolve(true);
          }
        };
        server.stdout.on("data", check);
        server.once("exit", () => {
          clearTimeout(timer);
          resolve(false);
        });
        check();
      }),
      output,
    );
    let executablePath = process.env.LCODE_TEST_BROWSER_PATH;
    if (!executablePath && process.platform === "win32") {
      for (const path of [
        "C:/Program Files/Google/Chrome/Application/chrome.exe",
        "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      ]) {
        try {
          await access(path);
          executablePath = path;
          break;
        } catch {
          /* Try the next installed browser. */
        }
      }
    }
    browser = await chromium.launch({
      headless: true,
      ...(executablePath ? { executablePath } : {}),
    });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    page.setDefaultTimeout(10_000);
    const errors = [];
    page.on("pageerror", (error) => {
      errors.push(error.message);
      t.diagnostic(error.stack ?? error.message);
    });
    const url = `http://127.0.0.1:${port}/test/fixtures/runtime-environment.html`;
    const calls = () => page.evaluate(() => globalThis.__runtimeFixture.calls);
    const configure = (values) =>
      page.evaluate((values) => Object.assign(globalThis.__runtimeFixture, values), values);
    const invoke = (method, ...args) =>
      page.evaluate(({ method, args }) => globalThis.__runtimeFixture[method](...args), {
        method,
        args,
      });
    const load = async (query = "") => {
      await page.goto(url + query);
      await page.getByTestId("runtime-environment-details").waitFor();
      await page.getByTestId("runtime-environment-pending").waitFor({ state: "hidden" });
    };
    const state = (name) =>
      page.getByTestId("runtime-environment-status").filter({ hasText: name }).waitFor();

    await runRuntimeEnvironmentScopeCases({ t, page, load, calls, configure, invoke, state });
    for (const width of [1280, 390])
      for (const english of [false, true]) {
        await t.test(
          `layout, policy and keyboard ${width}px ${english ? "English" : "中文"}`,
          async () => {
            await page.setViewportSize({ width, height: 900 });
            await load(english ? "?english" : "");
            assert.match(
              await page.getByTestId("runtime-environment-tools").innerText(),
              /node 24\.14\.0/,
            );
            assert.equal(await page.getByTestId("runtime-environment-revision").innerText(), "2");
            assert.ok(
              await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
            );
            const policy = page.getByTestId("project-policy-environmentPolicy");
            await policy.focus();
            await policy.press("Enter");
            await page
              .getByRole("option", {
                name: english ? "Managed environment" : "托管环境",
                exact: true,
              })
              .click();
            await page.waitForFunction(() =>
              globalThis.__runtimeFixture.calls.some((call) => call.method === "settings.update"),
            );
            const saved = (await calls()).find((call) => call.method === "settings.update");
            assert.equal(
              saved.params.projectExecutionPreferences["/fixture/项目"].environmentPolicy,
              "managed",
            );
            assert.equal(
              (await calls()).some((call) => call.method === "prepare"),
              false,
            );
          },
        );
      }
    await t.test(
      "explicit upgrade failure/retry retains request, diagnostic draft and attachments",
      async () => {
        await load();
        await configure({ failPrepare: true });
        await page.getByTestId("runtime-environment-upgrade").click();
        await state("环境准备失败");
        await page.getByTestId("git-failure-to-composer").click();
        const text = await page.getByTestId("runtime-draft").inputValue();
        assert.ok(text.startsWith("已有正文\n\n"));
        assert.match(text, /dependency-install-failed/);
        assert.match(text, /"exitCode": 1/);
        assert.doesNotMatch(text, /private-fixture-token/);
        assert.equal(await page.getByTestId("runtime-attachments").innerText(), "原附件.png");
        assert.equal(
          (await calls()).some((call) => ["send", "createSession"].includes(call.method)),
          false,
        );
        await configure({ failPrepare: false });
        await page.getByTestId("runtime-environment-retry").click();
        await state("环境已就绪");
        const preparation = (await calls()).filter((call) => call.method === "prepare");
        assert.equal(preparation.length, 2);
        assert.deepEqual(preparation[0].params, preparation[1].params);
        assert.equal(preparation[0].params.operation, "upgrade");
        assert.equal(preparation[0].params.bindingId, "binding");
        assert.equal(preparation[0].params.expectedRevision, 2);
        assert.equal(preparation[0].params.expectedManifestDigest, "manifest-2");
        assert.match(preparation[0].params.workspacePath, /工作树/);
      },
    );
    await t.test("failed upgrade can be explicitly cancelled before a new upgrade", async () => {
      await load();
      await configure({ failPrepare: true });
      await page.getByTestId("runtime-environment-upgrade").click();
      await state("环境准备失败");
      await page.getByTestId("runtime-environment-cancel").click();
      await state("环境准备已取消");
      await configure({ failPrepare: false });
      await page.getByTestId("runtime-environment-upgrade").click();
      await state("环境已就绪");
      const requests = (await calls()).filter((call) => call.method === "prepare");
      assert.equal(requests[1].params.requestId, requests[0].params.requestId);
      assert.equal(requests[1].params.cancel, true);
      assert.notEqual(requests[2].params.requestId, requests[0].params.requestId);
    });
    for (const width of [1280, 390]) {
      await t.test(
        `failed upgrade restores its original request after details remount at ${width}px`,
        async () => {
          await page.setViewportSize({ width, height: 900 });
          await load("?remote");
          await configure({ failPrepare: true });
          await page.getByTestId("runtime-environment-upgrade").click();
          await state("环境准备失败");
          await invoke("remountDetails");
          await page.getByTestId("runtime-environment-pending").waitFor({ state: "hidden" });
          await configure({ failPrepare: false });
          await page.getByTestId("runtime-environment-retry").click();
          await state("环境已就绪");
          const requests = (await calls()).filter((call) => call.method === "prepare");
          assert.equal(requests.length, 2);
          assert.deepEqual(requests[1].params, requests[0].params);
          assert.equal(requests[1].params.workspaceIdentity, "remote-a");
        },
      );
    }
    await t.test(
      "pending never creates readiness and cancel uses the original request",
      async () => {
        await load();
        await configure({ holdPrepare: true });
        await page.getByTestId("runtime-environment-upgrade").click();
        await state("正在准备依赖");
        await page.getByTestId("runtime-environment-cancel").click();
        await state("环境准备已取消");
        const preparation = (await calls()).filter((call) => call.method === "prepare");
        assert.equal(preparation[0].params.requestId, preparation[1].params.requestId);
        assert.equal(preparation[1].params.cancel, true);
        assert.equal(await page.getByTestId("runtime-environment-retry").count(), 0);
        await invoke("remountDetails");
        await page.getByTestId("runtime-environment-pending").waitFor({ state: "hidden" });
        await configure({ holdPrepare: false });
        await page.getByTestId("runtime-environment-upgrade").click();
        await state("环境已就绪");
        const resumed = (await calls()).filter((call) => call.method === "prepare");
        assert.notEqual(resumed.at(-1).params.requestId, preparation[0].params.requestId);
      },
    );
    await t.test(
      "service start/stop/restart, bounded scan and unreachable mobile preview",
      async () => {
        await page.setViewportSize({ width: 390, height: 844 });
        await load();
        const row = page.locator('[data-service-id="dev:web"]');
        await row.getByRole("button", { name: "启动", exact: true }).click();
        await row.getByTestId("runtime-service-state").filter({ hasText: "运行中" }).waitFor();
        assert.equal(
          await row.getByRole("button", { name: "预览", exact: true }).isDisabled(),
          true,
        );
        assert.match(await row.innerText(), /不会直接打开宿主 localhost/);
        await row.getByRole("button", { name: "重启", exact: true }).click();
        await page.waitForFunction(
          () =>
            globalThis.__runtimeFixture.calls.filter((call) => call.method === "startService")
              .length === 2,
        );
        await row.getByRole("button", { name: "停止", exact: true }).click();
        await row.getByTestId("runtime-service-state").filter({ hasText: "已停止" }).waitFor();
        const actions = (await calls()).filter((call) =>
          ["startService", "stopService"].includes(call.method),
        );
        assert.deepEqual(
          actions.map((call) => call.method),
          ["startService", "stopService", "startService", "stopService"],
        );
        assert.equal(actions[1].params.expectedGeneration, 1);
        assert.equal(actions[2].params.expectedGeneration, 1);
        assert.equal(actions[3].params.expectedGeneration, 2);
        await page.getByTestId("runtime-environment-scan").click();
        await page.getByText("fixture budget reached").waitFor();
        assert.deepEqual(
          (await calls()).find((call) => call.method === "resourceSummary").params.budget,
          { maxEntries: 2000, maxDurationMs: 200 },
        );
        assert.equal(
          (await calls()).some((call) => call.method === "openExternal"),
          false,
        );
      },
    );
    await t.test("same-identity late snapshot cannot overwrite new revision", async () => {
      await load("?remote");
      await configure({ holdSnapshot: true });
      await page.getByRole("button", { name: "刷新环境", exact: true }).click();
      await invoke("change", { status: "needsUpdate" });
      await state("需要更新");
      await invoke("releaseSnapshot");
      await page.getByTestId("runtime-environment-pending").waitFor({ state: "hidden" });
      assert.match(await page.getByTestId("runtime-environment-status").innerText(), /需要更新/);
    });
    await t.test(
      "remote disconnect does not call local owner and reconnect only reads facts",
      async () => {
        await load("?remote");
        const before = (await calls()).length;
        await invoke("setConnected", false);
        await page.getByText("等待目标远程 Host 连接；不会改用本机服务。").waitFor();
        assert.equal(await page.getByTestId("runtime-environment-upgrade").isDisabled(), true);
        assert.equal((await calls()).length, before);
        await invoke("setConnected", true);
        await page.getByTestId("runtime-environment-pending").waitFor({ state: "hidden" });
        const after = (await calls()).slice(before);
        assert.ok(after.length > 0);
        assert.ok(after.every((call) => ["snapshot", "getCapabilities"].includes(call.method)));
      },
    );
    await t.test("scope-late diagnostic cannot append into another draft", async () => {
      await load("?remote");
      await invoke("chooseIdentity", "remote-b");
      await page.waitForFunction(
        () => document.querySelector('[data-testid="runtime-draft"]').value === "B原正文",
      );
      assert.equal(await invoke("lateHandoff"), false);
      assert.equal(await page.getByTestId("runtime-draft").inputValue(), "B原正文");
    });
    await t.test("legacy binding and missing capability never auto-upgrade", async () => {
      await load("?legacy&unsupported");
      await page.getByText("fixture: platform not verified").waitFor();
      assert.equal(await page.getByTestId("runtime-environment-upgrade").isDisabled(), true);
      assert.match(await page.getByTestId("runtime-environment-unmanaged").innerText(), /未托管/);
      assert.equal(
        (await calls()).some((call) => ["prepare", "startService", "list"].includes(call.method)),
        false,
      );
    });
    await t.test(
      "candidate explicit skip reaches validation and publication with owner receipt",
      async () => {
        await load("?candidate");
        const candidate = page.getByTestId("runtime-candidate");
        await candidate.getByTestId("worktree-approve-candidate").click();
        assert.equal(await candidate.getByTestId("worktree-validate").isDisabled(), true);
        await candidate.getByTestId("worktree-skip-validation").focus();
        await candidate.getByTestId("worktree-skip-validation").press("Space");
        await candidate.getByTestId("worktree-validate").click();
        await candidate.getByTestId("worktree-validation-receipt").waitFor();
        assert.match(
          await candidate.getByTestId("worktree-validation-receipt").innerText(),
          /明确跳过验证.*不代表测试通过/,
        );
        await candidate.getByTestId("worktree-publish").click();
        await page.waitForFunction(() =>
          globalThis.__runtimeFixture.calls.some((call) => call.method === "publishIntegration"),
        );
        const requests = (await calls()).filter((call) =>
          ["continueIntegration", "publishIntegration"].includes(call.method),
        );
        assert.deepEqual(
          requests.map((call) => call.params.skipValidation),
          [true, true],
        );
      },
    );
    await runRuntimeEnvironmentComposerCases({
      t,
      page,
      url: `http://127.0.0.1:${port}/test/fixtures/conversation-send.html`,
    });
    assert.deepEqual(errors, []);
  },
);
