import assert from "node:assert/strict";
import { access, mkdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { _electron } from "playwright-core";

export async function runElectronQualityCase({ t, origin, artifacts, visibleBounds }) {
  const executablePath = fileURLToPath(
    new URL("../../../node_modules/electron/dist/electron.exe", import.meta.url),
  );
  const available =
    process.platform === "win32" &&
    (await access(executablePath).then(
      () => true,
      () => false,
    ));
  await t.test(
    "isolated Windows Electron renderer keeps modal bounds and native no-drag",
    { skip: !available },
    async () => {
      await mkdir(`${artifacts}/electron-data`, { recursive: true });
      const env = Object.fromEntries(
        Object.entries(process.env).filter(
          ([key]) => key !== "ELECTRON_RUN_AS_NODE" && key !== "NODE_OPTIONS",
        ),
      );
      const electron = await _electron.launch({
        executablePath,
        args: [
          fileURLToPath(new URL("./fixtures/electron-quality.cjs", import.meta.url)),
          `--quality-url=${origin}/test/fixtures/theme-quality.html?controls&platform=windows&font=20`,
          `--quality-user-data=${artifacts}/electron-data`,
        ],
        env,
      });
      try {
        const page = await electron.firstWindow();
        await page.getByTestId("quality-input-group").waitFor();
        await page.emulateMedia({ reducedMotion: "reduce" });
        await page.getByRole("button", { name: "Long dialog", exact: true }).click();
        await visibleBounds(page.getByRole("dialog"), 1280, 720);
        assert.equal(
          await page
            .getByRole("dialog")
            .evaluate((el) => getComputedStyle(el).getPropertyValue("app-region")),
          "no-drag",
        );
        await page.screenshot({ path: `${artifacts}/windows-electron.png` });
        await page.keyboard.press("Escape");
        await page.getByRole("dialog").waitFor({ state: "hidden" });
      } finally {
        await electron.close();
      }
    },
  );
}
