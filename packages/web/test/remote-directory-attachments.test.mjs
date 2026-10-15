import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { createRemotePromptAttachmentTransferService } from "../../desktop/src/host/promptAttachmentTransferService.ts";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "Composer folder drop stages actual files, sends a remote directory ref and cancels pending uploads",
  { timeout: 90_000 },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), "lcode-folder-browser-"));
    t.after(() => rm(root, { recursive: true, force: true }));
    await mkdir(join(root, "nested"));
    await mkdir(join(root, "empty"));
    await writeFile(join(root, "nested", "hello.txt"), "folder contents");
    const { browser, port } = await startWorkflowProgressBrowser(t);
    const page = await browser.newPage();
    page.setDefaultTimeout(10_000);
    page.setDefaultNavigationTimeout(30_000);
    const uploaded = [];
    const commands = [];
    const canceled = [];
    let hold = false;
    let fail = false;
    const backend = {
      async exec(command) {
        commands.push(command);
        const stdout = new PassThrough();
        return {
          stdin: new PassThrough(),
          stdout,
          stderr: new PassThrough(),
          onClose(listener) {
            setImmediate(() => {
              stdout.end(command === 'printf %s "$HOME"' ? "/home/fixture" : "");
              listener(0);
            });
            return { dispose() {} };
          },
        };
      },
      async upload(local, remote, options) {
        if (hold)
          await new Promise((_, reject) => {
            const cancel = () =>
              reject(Object.assign(new Error("canceled"), { name: "AbortError" }));
            if (options.signal.aborted) cancel();
            else options.signal.addEventListener("abort", cancel, { once: true });
          });
        if (fail) throw new Error("fixture upload failure");
        const content = await readFile(local);
        uploaded.push({ remote, content: content.toString() });
        options.onProgress?.({ uploadedBytes: content.length, totalBytes: content.length });
      },
    };
    const service = createRemotePromptAttachmentTransferService(backend);
    await page.exposeFunction("__folderStage", async (params) => {
      const subscription = service.onDynamicProgress(params.operationId)((progress) => {
        void page.evaluate((p) => globalThis.__folderProgress(p), progress).catch(() => {});
      });
      try {
        return await service.stage(params);
      } finally {
        subscription.dispose();
      }
    });
    await page.exposeFunction("__folderCancel", async (id) => {
      canceled.push(id);
      await service.cancel(id);
    });
    await page.exposeFunction("__folderAdopt", (id) => service.adopt(id));
    await page.addInitScript((path) => {
      globalThis.__folderLocalPath = path;
    }, root);
    const url = `http://127.0.0.1:${port}/test/fixtures/conversation-send.html?existing&remoteAttachments`;
    async function dropFolder() {
      await page.getByTestId("v4-composer-input").evaluate((element) => {
        const transfer = new DataTransfer();
        transfer.items.add(new File([], "folder.png", { type: "image/png" }));
        element.dispatchEvent(
          new DragEvent("drop", { dataTransfer: transfer, bubbles: true, cancelable: true }),
        );
      });
    }
    for (const width of [1280, 390]) {
      await page.setViewportSize({ width, height: 844 });
      await page.goto(url);
      await page.getByTestId("v4-composer-input").fill("Inspect this folder");
      await dropFolder();
      await page.waitForFunction(
        () => !document.querySelector('[data-testid="v4-composer-send"]').disabled,
      );
      await page.getByTestId("v4-composer-send").click();
      await page.waitForFunction(() => globalThis.__sendFixture.calls.length === 1);
      const [ref] = await page.evaluate(
        () => globalThis.__sendFixture.calls[0].options.attachments,
      );
      assert.match(ref.ref, /^\/home\/fixture\/\.lcode\/tmp\/prompt-attachments\//);
      assert.equal(ref.mime, "inode/directory");
      assert.equal(ref.bytes, 15);
      assert.ok(
        uploaded.some(
          (entry) =>
            entry.remote === `${ref.ref}/nested/hello.txt` && entry.content === "folder contents",
        ),
      );
      assert.ok(commands.some((command) => command.includes(`${ref.ref}/empty`)));
    }
    hold = true;
    await page.goto(url);
    await page.getByTestId("v4-composer-input").fill("Pending folder");
    await dropFolder();
    await page.locator("[data-composer-attachment-remove]").waitFor();
    assert.equal(await page.getByTestId("v4-composer-send").isDisabled(), true);
    await page.getByRole("button", { name: /移除附件|Remove attachment/ }).click();
    await page.waitForFunction(
      () => !document.querySelector('[data-testid="v4-composer-send"]').disabled,
    );
    assert.ok(canceled.length > 0);
    hold = false;
    fail = true;
    await page.goto(url);
    await dropFolder();
    await page.locator('[data-upload-status="failed"]').waitFor();
    assert.ok(
      (await page
        .locator('[aria-label*="远端附件上传失败"], [title*="远端附件上传失败"]')
        .count()) > 0,
    );
    assert.equal(await page.getByTestId("v4-composer-send").isDisabled(), true);
  },
);
