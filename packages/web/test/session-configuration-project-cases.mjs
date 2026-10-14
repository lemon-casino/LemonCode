import assert from "node:assert/strict";

export async function runSessionConfigurationProjectCases({ t, page, load, probe }) {
  await t.test(
    "real project switches isolate new defaults, text, manual choices and existing sessions",
    async () => {
      await load();
      await page.evaluate(() => {
        const fixture = window.__sessionConfiguration;
        fixture.settings.local.projectExecutionPreferences["/fixture/repo"] = {
          defaultSessionModelSelection: {
            providerId: "api-provider",
            modelId: "api-model",
            options: { reasoningLevel: "low", speed: "standard" },
          },
          defaultSessionApprovalMode: "build",
        };
        fixture.settings.local.projectExecutionPreferences["/fixture/other"] = {
          defaultSessionModelSelection: {
            providerId: "host-fallback",
            modelId: "fallback-model",
            options: { reasoningLevel: "high", speed: "fast" },
          },
          defaultSessionApprovalMode: "edit",
        };
        fixture.notifySettings();
      });
      await page.getByTestId("show-probe").click();
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).submission
            ?.modelSelection.providerId === "api-provider",
      );
      assert.deepEqual((await probe()).submission, {
        mode: "build",
        planEnabled: false,
        modelSelection: {
          providerId: "api-provider",
          modelId: "api-model",
          options: { reasoningLevel: "low", speed: "standard" },
        },
      });
      await page.evaluate(() => {
        window.__sessionConfiguration.typeDraft("Project A text");
        window.__sessionConfiguration.switchProject("/fixture/other");
      });
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).submission
            ?.modelSelection.providerId === "host-fallback",
      );
      assert.equal((await probe()).submission.mode, "edit");
      assert.equal((await probe()).composer.text, "");
      await page.evaluate(() => {
        window.__sessionConfiguration.selectManual("low");
        window.__sessionConfiguration.switchProject("/fixture/repo");
      });
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).submission
            ?.modelSelection.providerId === "api-provider",
      );
      assert.equal((await probe()).composer.text, "Project A text");
      await page.evaluate(() => window.__sessionConfiguration.switchProject("/fixture/other"));
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).scope
            .workspacePath === "/fixture/other",
      );
      assert.equal((await probe()).draft.thought, "low");
      await page.evaluate(() => window.__sessionConfiguration.existing());
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).scope
            .sessionId === "existing",
      );
      const existing = (await probe()).draft;
      const revision = (await probe()).catalogRevision;
      await page.evaluate(() => {
        window.__sessionConfiguration.settings.local.projectExecutionPreferences[
          "/fixture/other"
        ].defaultSessionApprovalMode = "yolo";
        window.__sessionConfiguration.notifySettings();
        window.__sessionConfiguration.removeProvider();
      });
      await page.waitForFunction(
        (revision) =>
          JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent)
            .catalogRevision > revision,
        revision,
      );
      assert.deepEqual((await probe()).draft, existing);
      await page.evaluate(() => window.__sessionConfiguration.switchProject("/fixture/repo"));
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).scope
            .workspacePath === "/fixture/repo",
      );
      assert.equal((await probe()).composer.text, "Project A text");
    },
  );
  await t.test(
    "cold Host settings cannot upgrade restored drafts before their project defaults arrive",
    async () => {
      await load();
      await page.getByTestId("show-probe").click();
      await page.evaluate(() => {
        window.__sessionConfiguration.holdRemoteRead();
        window.__sessionConfiguration.switchProject("/fixture/repo", "remote-a");
      });
      await page.waitForFunction(() =>
        window.__sessionConfiguration.pendingReads.has("remote-cold"),
      );
      const pending = await probe();
      assert.equal(pending.scope.workspaceIdentity, "remote-a");
      assert.equal(pending.draft.thought, "low");
      assert.equal(pending.draft.modelSelection.options.speed, "standard");
      await page.evaluate(() => {
        window.__sessionConfiguration.typeDraft("Typed during settings read");
        window.__sessionConfiguration.heldReads.delete("remote-cold");
        window.__sessionConfiguration.releaseReads.get("remote-cold")();
      });
      await page.waitForFunction(
        () => !window.__sessionConfiguration.pendingReads.has("remote-cold"),
      );
      assert.equal((await probe()).draft.thought, "low");
      assert.equal((await probe()).composer.text, "Typed during settings read");
      await page.evaluate(() => window.__sessionConfiguration.switchProject("/fixture/repo"));
      await page.waitForFunction(
        () =>
          !JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).scope
            .workspaceIdentity,
      );
      assert.equal((await probe()).composer.text, "");
    },
  );
  await t.test(
    "deleted automatic defaults use the recent supplier without an explicit settings default",
    async () => {
      await load();
      await page.getByTestId("show-probe").click();
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).submission
            ?.modelSelection.providerId === "oauth-provider",
      );
      await page.evaluate(() => {
        window.__sessionConfiguration.seedRecent();
        window.__sessionConfiguration.removeDefault();
      });
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).submission
            ?.modelSelection.providerId === "api-provider",
      );
      assert.equal((await probe()).submission.modelSelection.modelId, "api-model");
      assert.equal(
        await page.evaluate(
          () => window.__sessionConfiguration.settings.local.defaultSessionModelSelection,
        ),
        undefined,
      );
    },
  );

  await t.test(
    "manual selection before the first settings response survives initialization",
    async () => {
      await load();
      await page.getByTestId("show-probe").click();
      await page.evaluate(() => {
        window.__sessionConfiguration.holdRemoteRead(false);
        window.__sessionConfiguration.switchProject("/fixture/repo", "remote-a");
      });
      await page.waitForFunction(() =>
        window.__sessionConfiguration.pendingReads.has("remote-cold"),
      );
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent)
            .catalogRevision !== undefined,
      );
      await page.evaluate(() => {
        const fixture = window.__sessionConfiguration;
        fixture.selectModelManually("oauth-provider", "oauth-model");
        fixture.typeDraft("Manual model during initialization");
        fixture.heldReads.delete("remote-cold");
        fixture.releaseReads.get("remote-cold")();
      });
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).submission
            ?.mode === "edit",
      );
      assert.equal((await probe()).submission.modelSelection.providerId, "oauth-provider");
      assert.equal((await probe()).draft.thought, "high");
      assert.equal((await probe()).composer.modelSelectionEdited, true);
    },
  );

  await t.test(
    "late remote settings cannot replace a newly selected local project's defaults",
    async () => {
      await load();
      await page.getByTestId("show-probe").click();
      await page.evaluate(() => {
        const fixture = window.__sessionConfiguration;
        fixture.settings.local.projectExecutionPreferences["/fixture/other"] = {
          defaultSessionModelSelection: {
            providerId: "host-fallback",
            modelId: "fallback-model",
            options: { reasoningLevel: "low", speed: "standard" },
          },
          defaultSessionApprovalMode: "build",
        };
        fixture.notifySettings();
        fixture.holdRemoteRead();
        fixture.switchProject("/fixture/repo", "remote-a");
      });
      await page.waitForFunction(() =>
        window.__sessionConfiguration.pendingReads.has("remote-cold"),
      );
      await page.evaluate(() => window.__sessionConfiguration.switchProject("/fixture/other"));
      await page.waitForFunction(
        () =>
          JSON.parse(document.querySelector('[data-testid="draft-probe"]').textContent).submission
            ?.modelSelection.providerId === "host-fallback",
      );
      const expected = (await probe()).submission;
      await page.evaluate(() => {
        window.__sessionConfiguration.heldReads.delete("remote-cold");
        window.__sessionConfiguration.releaseReads.get("remote-cold")();
      });
      await page.waitForFunction(
        () => !window.__sessionConfiguration.pendingReads.has("remote-cold"),
      );
      assert.equal((await probe()).scope.workspacePath, "/fixture/other");
      assert.deepEqual((await probe()).submission, expected);
    },
  );
}
