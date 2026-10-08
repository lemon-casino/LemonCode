import assert from "node:assert/strict";

export async function runRuntimeEnvironmentScopeCases({
  t,
  page,
  load,
  calls,
  configure,
  invoke,
  state,
}) {
  for (const remote of [false, true]) {
    for (const width of [1280, 390]) {
      await t.test(
        `subdirectory environment reads and remount retry keep ${remote ? "remote" : "local"} execution scope at ${width}px`,
        async () => {
          await page.setViewportSize({ width, height: 900 });
          await load(`?subdirectory${remote ? "&remote" : ""}`);
          await state("环境已就绪");
          const binding = await page.evaluate(() => globalThis.__runtimeFixture.bindingFacts());
          assert.notEqual(binding.workspacePath, binding.checkoutPath);
          await page.getByRole("button", { name: "刷新环境", exact: true }).click();
          await page.getByTestId("runtime-environment-pending").waitFor({ state: "hidden" });
          const reads = (await calls()).filter(({ method }) =>
            ["snapshot", "getCapabilities"].includes(method),
          );
          assert.ok(reads.length >= 4);
          assert.ok(reads.every(({ params }) => params.workspacePath === binding.workspacePath));
          assert.ok(
            reads.every(
              ({ params }) => params.workspaceIdentity === (remote ? "remote-a" : undefined),
            ),
          );
          await configure({ failPrepare: true });
          await page.getByTestId("runtime-environment-upgrade").click();
          await state("环境准备失败");
          await invoke("remountDetails");
          await page.getByTestId("runtime-environment-pending").waitFor({ state: "hidden" });
          await configure({ failPrepare: false });
          await page.getByTestId("runtime-environment-retry").click();
          await state("环境已就绪");
          const requests = (await calls()).filter(({ method }) => method === "prepare");
          assert.equal(requests.length, 2);
          assert.deepEqual(requests[1].params, requests[0].params);
          assert.equal(requests[0].params.workspacePath, binding.workspacePath);
          assert.equal(requests[0].params.workspaceIdentity, remote ? "remote-a" : undefined);
          const row = page.locator('[data-service-id="dev:web"]');
          await row.getByRole("button", { name: "启动", exact: true }).click();
          await row.getByTestId("runtime-service-state").filter({ hasText: "运行中" }).waitFor();
          await row.getByRole("button", { name: "停止", exact: true }).click();
          await row.getByTestId("runtime-service-state").filter({ hasText: "已停止" }).waitFor();
          await page.getByTestId("runtime-environment-scan").click();
          await page.getByText("fixture budget reached").waitFor();
          const actions = (await calls()).filter(({ method }) =>
            ["startService", "stopService", "resourceSummary"].includes(method),
          );
          assert.equal(actions.length, 3);
          assert.ok(actions.every(({ params }) => params.workspacePath === binding.workspacePath));
          assert.ok(
            actions.every(
              ({ params }) => params.workspaceIdentity === (remote ? "remote-a" : undefined),
            ),
          );
        },
      );
    }
  }
}
