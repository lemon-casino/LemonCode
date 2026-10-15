import assert from "node:assert/strict";
import { access, mkdir, mkdtemp, rm, unlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { tsImport } from "tsx/esm/api";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

const { createFsStorageCleaner } = await tsImport(
  "../../services/src/storage/adapters/fsCleaner.ts",
  import.meta.url,
);
const { runStorageScan } = await tsImport(
  "../../services/src/storage/adapters/inProcessScanRunner.ts",
  import.meta.url,
);
const { createStorageService } = await tsImport(
  "../../services/src/storage/app/storageService.ts",
  import.meta.url,
);

test(
  "storage categories and cleanup use real files through the production resource window",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    const screenshots = fileURLToPath(
      new URL("../../../.lcode/component-quality/resource-storage/", import.meta.url),
    );
    await mkdir(screenshots, { recursive: true });
    for (const [locale, theme, width, mediaTitle] of [
      ["zh-CN", "zai-dark", 1100, "媒体派生缓存"],
      ["en-US", "zai-light", 390, "Derived media cache"],
    ]) {
      await t.test(
        `${locale} ${theme} ${width}px: details, protected data, clean and refresh`,
        async (t) => {
          const directory = await mkdtemp(join(tmpdir(), "lcode-storage-browser-"));
          t.after(() => rm(directory, { recursive: true, force: true }));
          const roots = [{ id: "home", path: directory, hasCustomDataBaseDir: false }];
          const pnpmCachePath = "v2/runtime-environments/package-store/pnpm/v10/files/cache";
          const files = [
            "cli/video-cache/old/video.mp4",
            "cli/artifacts/old/source.json",
            "v2/worktrees/bindings/task.json",
            "v2/git-backup/repo.bundle",
            "v2/runtime-environments/runtime/node.exe",
            "agent/old/data",
            "tmp/paste-attachments/original.txt",
            "v2/unknown-a/data",
            "v2/unknown-b/data",
            pnpmCachePath,
            "project/node_modules/installed.js",
            "editor-icon/old/icon.png",
          ];
          for (const path of files) {
            const absolute = join(directory, path);
            await mkdir(dirname(absolute), { recursive: true });
            await writeFile(absolute, "fixture");
            const old = new Date(Date.now() - 10 * 86_400_000);
            await utimes(absolute, old, old);
          }
          let finishPnpmClean;
          const heldPnpmClean = new Promise((resolve) => {
            finishPnpmClean = resolve;
          });
          const service = createStorageService({
            roots: { resolveRoots: async () => roots },
            cleaner: createFsStorageCleaner(),
            scanRunner: { run: runStorageScan },
            packageCache: {
              clean: async (rootPath) => {
                assert.equal(rootPath, directory);
                await heldPnpmClean;
                await unlink(join(rootPath, pnpmCachePath));
                return { freedBytes: 7, deletedCount: 1, skippedCount: 0, failures: [] };
              },
            },
          });
          t.after(() => service.dispose());
          const page = await browser.newPage({ viewport: { width, height: 900 } });
          const errors = [];
          const requests = [];
          const revealed = [];
          page.setDefaultTimeout(15_000);
          page.on("pageerror", (error) => errors.push(error.message));
          t.after(async () => {
            await page.close();
            assert.deepEqual(errors, [], diagnostics());
          });
          await page.exposeFunction("storageScanFixture", async () =>
            runStorageScan({ roots, signal: new AbortController().signal, onProgress() {} }),
          );
          await page.exposeFunction("storageCleanFixture", async (request) => {
            requests.push(request);
            return service.clean(request);
          });
          await page.exposeFunction("storageRevealFixture", async (path) => {
            revealed.push(path);
          });
          await page.exposeFunction("finishPnpmCleanFixture", async () => {
            finishPnpmClean();
          });
          await page.addInitScript(
            ({ locale, theme }) => {
              localStorage.setItem("lcode-locale-preference", locale);
              localStorage.setItem("lcode-theme", theme);
              let latest = null;
              let jobCounter = 0;
              let currentJob = null;
              const listeners = new Set();
              window.resourceManager = {
                getSnapshot: async () => ({
                  sampledAt: Date.now(),
                  logicalCpuCount: 4,
                  processes: [],
                  app: { cpuPercent: 0, memoryBytes: 0 },
                  system: { cpuPercent: 0, memoryTotalBytes: 1, memoryUsedBytes: 0 },
                }),
                setSamplingActive() {},
                storage: {
                  getSnapshot: async () => latest,
                  startScan: async () => {
                    const jobId = `fixture-${++jobCounter}`;
                    currentJob = jobId;
                    // 桥接进度在命令应答后投递；文件扫描和删除都在 Node 端运行生产实现。
                    requestAnimationFrame(async () => {
                      const progress = await window.storageScanFixture();
                      if (currentJob !== jobId) return;
                      latest = {
                        ...progress,
                        jobId,
                        status: "complete",
                        startedAt: Date.now(),
                        finishedAt: Date.now(),
                      };
                      listeners.forEach((listener) => listener(latest));
                    });
                    return { jobId };
                  },
                  cancelScan: async (jobId) => {
                    if (currentJob === jobId) currentJob = null;
                  },
                  subscribeScanProgress: (listener) => {
                    listeners.add(listener);
                    return () => listeners.delete(listener);
                  },
                  clean: (request) => window.storageCleanFixture(request),
                  revealPath: async (path) => {
                    await window.storageRevealFixture(path);
                    document.body.dataset.storageRevealed = path;
                  },
                },
              };
            },
            { locale, theme },
          );
          // 生产窗口入口经 UI 公共入口加载，Vite 首次转换时间与现有主题回归一致。
          await page.goto(`http://127.0.0.1:${port}/test/fixtures/resource-theme.html`, {
            timeout: 60_000,
          });
          await page.getByTestId("resource-manager-tab-storage").click();
          const waitForScan = () =>
            page
              .locator('[data-testid="resource-manager-storage-status"][data-state="complete"]')
              .waitFor();
          await waitForScan();
          const row = (id) => page.getByTestId(`resource-manager-storage-category-row-${id}`);
          const clean = (id) => page.getByTestId(`resource-manager-storage-category-clean-${id}`);
          assert.ok((await row("mediaCache").innerText()).includes(mediaTitle));
          assert.ok(
            (await row("pnpmCache").innerText()).includes(
              locale === "zh-CN" ? "pnpm 包缓存" : "pnpm package cache",
            ),
          );
          assert.equal(
            await clean("pnpmCache").innerText(),
            locale === "zh-CN" ? "安全清理" : "Clean safely",
          );
          assert.equal(
            await page
              .locator("main > div")
              .evaluate((element) => element.scrollWidth > element.clientWidth + 1),
            false,
            "storage scroll container must fit the viewport",
          );
          const cleanBounds = await clean("mediaCache").boundingBox();
          assert.ok(
            cleanBounds && cleanBounds.x + cleanBounds.width <= width,
            "clean button must stay within the viewport",
          );
          for (const id of [
            "worktreeData",
            "gitBackups",
            "legacyData",
            "temporaryFiles",
            "runtimes",
            "other",
          ]) {
            assert.equal(await row(id).count(), 1);
            assert.equal(await clean(id).count(), 0);
          }
          await row("other").click();
          const detail = page.getByTestId("resource-manager-storage-detail");
          assert.ok((await detail.innerText()).includes("v2/unknown-a"));
          assert.ok((await detail.innerText()).includes("v2/unknown-b"));
          await detail
            .getByRole("button", {
              name: locale === "zh-CN" ? "在文件管理器中显示" : "Show in file manager",
            })
            .first()
            .click();
          await page.waitForFunction(() => Boolean(document.body.dataset.storageRevealed));
          assert.equal(revealed.length, 1);
          assert.ok(revealed[0].startsWith(directory));
          await page.getByTestId("resource-manager-storage-detail-back").click();
          await page.screenshot({
            path: join(screenshots, `${locale}-${width}-categories.png`),
            fullPage: true,
          });
          const before = await page.getByTestId("resource-manager-storage-total").innerText();
          await clean("mediaCache").click();
          await clean("mediaCache").waitFor({ state: "detached" });
          await waitForScan();
          assert.deepEqual(requests, [{ rootId: "home", categoryId: "mediaCache" }]);
          assert.notEqual(
            await page.getByTestId("resource-manager-storage-total").innerText(),
            before,
          );
          await assert.rejects(access(join(directory, files[0])), { code: "ENOENT" });
          await access(join(directory, files[1]));
          await clean("editorCache").click();
          await clean("editorCache").waitFor({ state: "detached" });
          await waitForScan();
          assert.equal(requests[1]?.categoryId, "editorCache");
          await row("pnpmCache").click();
          assert.ok(
            (await page.getByTestId("resource-manager-storage-detail").innerText()).includes(
              "Node",
            ),
          );
          await clean("pnpmCache").click();
          await page.waitForFunction(
            () =>
              document.querySelector(
                '[data-testid="resource-manager-storage-category-clean-pnpmCache"]',
              )?.disabled,
          );
          assert.equal(
            await page.getByTestId("resource-manager-storage-rescan").isDisabled(),
            true,
          );
          await page.evaluate(() => window.finishPnpmCleanFixture());
          await clean("pnpmCache").waitFor({ state: "detached" });
          await waitForScan();
          assert.equal(requests[2]?.categoryId, "pnpmCache");
          await assert.rejects(access(join(directory, pnpmCachePath)), { code: "ENOENT" });
          for (const path of files.slice(1, -1).filter((path) => path !== pnpmCachePath))
            await access(join(directory, path));
          await page.getByTestId("resource-manager-storage-detail-back").click();
          assert.equal(
            await page.getByTestId("resource-manager-storage-category-size-pnpmCache").innerText(),
            "0 B",
          );
          const overflow = await page.evaluate(
            () => document.documentElement.scrollWidth > innerWidth,
          );
          assert.equal(overflow, false);
        },
      );
    }
  },
);
