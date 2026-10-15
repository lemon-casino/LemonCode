import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { build } from "esbuild";
import {
  resolveBuildAliases,
  resolveBuildExternal,
  createZodDedupePlugin,
  readZodBuildVersion,
} from "../../../apps/lcode-cli/packages/cli/scripts/build.mjs";

test(
  "isolated Electron Host preserves live workflow and records explicit shutdown",
  { timeout: 90_000 },
  async (t) => {
    const root = fileURLToPath(new URL("../../../", import.meta.url));
    const artifacts = join(root, ".artifacts/workflow-interruption");
    await mkdir(artifacts, { recursive: true });
    const directory = await mkdtemp(join(artifacts, "electron-host-run-"));
    const backend = join(directory, "backend.cjs");
    const host = join(directory, "host.mjs");
    await build({
      entryPoints: [
        join(root, "apps/lcode-cli/packages/bootstrap/scripts/workflow-host-agent.fixture.ts"),
      ],
      outfile: backend,
      bundle: true,
      platform: "node",
      format: "cjs",
      target: "node24",
      logLevel: "silent",
      alias: resolveBuildAliases({
        cliDirectory: join(root, "apps/lcode-cli/packages/cli"),
        rootDirectory: join(root, "apps/lcode-cli"),
      }),
      external: resolveBuildExternal(),
      metafile: true,
      plugins: [createZodDedupePlugin({ expectedV4Version: await readZodBuildVersion() })],
    });
    await build({
      entryPoints: [
        fileURLToPath(new URL("./workflow-lifetime-host.fixture.mjs", import.meta.url)),
      ],
      outfile: host,
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node24",
      logLevel: "silent",
      external: ["electron", "koffi", "playwright-core"],
      banner: {
        js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
      },
    });
    const electron = createRequire(import.meta.url)("electron");
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE;
    const child = spawn(electron, [host, directory, process.execPath, backend], {
      windowsHide: true,
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let diagnostics = "";
    child.stdout.on("data", (chunk) => {
      diagnostics += chunk;
    });
    child.stderr.on("data", (chunk) => {
      diagnostics += chunk;
    });
    t.after(() => {
      if (child.exitCode === null) child.kill();
    });
    const [code] = await once(child, "exit");
    await writeFile(join(directory, "process.log"), diagnostics);
    const failure = await readFile(join(directory, "host-error.txt"), "utf8").catch(() => "");
    assert.equal(code, 0, failure || diagnostics.slice(-4000));
    const result = JSON.parse(await readFile(join(directory, "host-result.json"), "utf8"));
    assert.equal(result.passed, true);
    const bundleHash = createHash("sha256")
      .update(await readFile(backend))
      .digest("hex");
    await writeFile(
      join(directory, "evidence.json"),
      JSON.stringify({ ...result, bundleHash, source: "isolated fixture bundle" }, null, 2),
    );
    await writeFile(
      join(artifacts, "electron-host-latest.json"),
      JSON.stringify({ directory, ...result, bundleHash }, null, 2),
    );
    t.diagnostic(`Electron ${result.electron}, Node ${result.node}; fixture bundle ${bundleHash}`);
  },
);
