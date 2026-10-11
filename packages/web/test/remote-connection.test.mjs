import assert from "node:assert/strict";
import test from "node:test";
import { startWorkflowProgressBrowser } from "./workflow-execution-progress-browser.mjs";

test(
  "remote connection dialog rejects stale results across SSH, WSL and Docker",
  { timeout: 180_000 },
  async (t) => {
    const { browser, port, diagnostics } = await startWorkflowProgressBrowser(t);
    async function pageFor(width = 1280) {
      const page = await browser.newPage({ viewport: { width, height: 900 } });
      page.setDefaultTimeout(10_000);
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`http://127.0.0.1:${port}/test/fixtures/remote-connection.html`);
      await page.getByTestId("ssh-connect-trigger").waitFor();
      t.after(async () => {
        await page.close();
        assert.deepEqual(errors, [], diagnostics());
      });
      return page;
    }
    async function start(page, kind) {
      await page.getByTestId("ssh-connect-trigger").click();
      await page.getByTestId(`remote-kind-${kind}`).click();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      if (kind === "ssh") {
        await page.getByTestId("ssh-host-input").fill("example.invalid");
        await page.getByTestId("ssh-username-input").fill("tester");
        await page.getByTestId("ssh-password-input").fill("fixture-password");
      }
      if (kind === "docker")
        await page.getByPlaceholder(/container name or ID/i).fill("test-container");
      await page.getByRole("button", { name: "Start connection", exact: true }).click();
    }
    async function cancel(page) {
      await page
        .getByTestId("ssh-dialog")
        .getByRole("button", { name: "Close", exact: true })
        .click();
      await page.getByRole("button", { name: /^Stop connecting/ }).click();
      await page.getByTestId("ssh-dialog").waitFor({ state: "detached" });
    }
    async function settle(page, index, success) {
      await page.evaluate(
        async ({ index, success }) => {
          const fixture = window.remoteConnectionFixture;
          if (success) fixture.succeed(index);
          else fixture.fail(index);
          await new Promise((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(resolve)),
          );
        },
        { index, success },
      );
    }
    for (const kind of ["ssh", "wsl", "docker"]) {
      await t.test(
        `${kind}: cancelled failures stay closed and late sessions are released`,
        async () => {
          const page = await pageFor(kind === "docker" ? 390 : 1280);
          await start(page, kind);
          await cancel(page);
          await settle(page, 0, false);
          assert.equal(await page.getByTestId("fixture-open").innerText(), "false");
          await start(page, kind);
          await cancel(page);
          await settle(page, 1, true);
          assert.equal(await page.getByTestId("fixture-open").innerText(), "false");
          assert.deepEqual(await page.evaluate(() => window.remoteConnectionFixture.disposed), [
            "session-1",
          ]);
          assert.equal(
            await page.evaluate(() => window.remoteConnectionFixture.cancelled.length),
            2,
          );
        },
      );
    }
    await t.test(
      "an old SSH success cannot replace a new WSL connection; normal results still appear",
      async () => {
        const page = await pageFor();
        await start(page, "ssh");
        await cancel(page);
        await start(page, "wsl");
        await settle(page, 0, true);
        assert.equal(await page.getByTestId("ssh-success").count(), 0);
        assert.deepEqual(await page.evaluate(() => window.remoteConnectionFixture.disposed), [
          "session-0",
        ]);
        await settle(page, 1, false);
        await page.getByText("fixture failure 1", { exact: true }).waitFor();
        await page.getByRole("button", { name: "Retry connection", exact: true }).click();
        await settle(page, 2, true);
        await page.getByTestId("ssh-success").waitFor();
      },
    );
    await t.test(
      "closing confirmation releases a session that completed while confirmation was open",
      async () => {
        const page = await pageFor();
        await start(page, "ssh");
        await page
          .getByTestId("ssh-dialog")
          .getByRole("button", { name: "Close", exact: true })
          .click();
        await page.getByRole("button", { name: /^Stop connecting/ }).waitFor();
        await settle(page, 0, true);
        await page.getByRole("button", { name: /^Stop connecting/ }).click();
        await page.getByTestId("ssh-dialog").waitFor({ state: "detached" });
        assert.deepEqual(await page.evaluate(() => window.remoteConnectionFixture.disposed), [
          "session-0",
        ]);
      },
    );
    await t.test(
      "minimizing preserves the active connection and restores its successful result",
      async () => {
        const page = await pageFor();
        await start(page, "wsl");
        await page.getByRole("button", { name: "Minimize remote connection window" }).click();
        await page.getByTestId("ssh-dialog").waitFor({ state: "detached" });
        await settle(page, 0, true);
        await page.getByTestId("ssh-success").waitFor();
        assert.deepEqual(await page.evaluate(() => window.remoteConnectionFixture.cancelled), []);
        assert.deepEqual(await page.evaluate(() => window.remoteConnectionFixture.disposed), []);
      },
    );
  },
);
