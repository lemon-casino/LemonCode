import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test(
  "actual Electron utility Host removes physical ASAR dependencies without changing global fs mode",
  { timeout: 25_000 },
  async () => {
    const require = createRequire(new URL("../package.json", import.meta.url));
    const electron = require("electron");
    const root = await mkdtemp(join(tmpdir(), "lcode-worktree-removal-"));
    try {
      const tree = join(root, "tree");
      await mkdir(join(tree, "node_modules", "electron", "dist", "resources"), { recursive: true });
      await cp(
        join(dirname(electron), "resources", "default_app.asar"),
        join(tree, "node_modules", "electron", "dist", "resources", "default_app.asar"),
      );
      const helper = join(root, "remove.cjs");
      // Only the deletion helper is transpiled for the test; no desktop application build.
      await build({
        entryPoints: [
          fileURLToPath(new URL("../src/host/physicalWorktreeRemoval.ts", import.meta.url)),
        ],
        outfile: helper,
        platform: "node",
        format: "cjs",
        define: { "import.meta.url": JSON.stringify(pathToFileURL(helper).href) },
      });
      const child = join(root, "child.cjs");
      await writeFile(
        child,
        `const {removePhysicalWorktreeDirectory}=require(${JSON.stringify(helper)}); const fs=require('node:fs/promises'); (async()=>{const before=process.noAsar; await removePhysicalWorktreeDirectory(${JSON.stringify(tree)}); let absent=false; try{await fs.access(${JSON.stringify(tree)});}catch(e){absent=e.code==='ENOENT';}process.parentPort.postMessage({absent,globalUnchanged:before===process.noAsar});})().catch(e=>process.parentPort.postMessage({error:String(e)}));`,
      );
      const main = join(root, "main.cjs");
      await writeFile(
        main,
        `const {app,utilityProcess}=require('electron'); app.setPath('userData',${JSON.stringify(join(root, "profile"))}); app.whenReady().then(()=>{const c=utilityProcess.fork(${JSON.stringify(child)}); const timer=setTimeout(()=>{c.kill();app.exit(2);},10000); c.on('message',m=>{console.log(JSON.stringify(m));clearTimeout(timer);c.kill();app.exit(m.error?1:0);});});`,
      );
      const env = { ...process.env };
      delete env.ELECTRON_RUN_AS_NODE;
      const processChild = spawn(electron, [main], { env, windowsHide: true, stdio: "pipe" });
      let output = "";
      processChild.stdout.on("data", (data) => {
        output += data;
      });
      processChild.stderr.on("data", (data) => {
        output += data;
      });
      const code = await new Promise((resolve, reject) => {
        processChild.once("error", reject);
        processChild.once("exit", resolve);
      });
      assert.equal(code, 0, output);
      assert.match(output, /"absent":true/);
      assert.match(output, /"globalUnchanged":true/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
