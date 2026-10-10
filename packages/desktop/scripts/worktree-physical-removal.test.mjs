import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test(
  "actual Electron utility Host removes checkout and private ASAR trees without following links or changing global fs mode",
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
      const resourceHelper = join(root, "resources.cjs");
      await build({
        entryPoints: [
          fileURLToPath(
            new URL(
              "../../services/src/runtime-environment/adapters/resources.ts",
              import.meta.url,
            ),
          ),
        ],
        outfile: resourceHelper,
        bundle: true,
        platform: "node",
        format: "cjs",
        define: { "import.meta.url": JSON.stringify(pathToFileURL(resourceHelper).href) },
      });
      const managed = join(root, "managed");
      const environmentId = "a".repeat(32);
      const cache = join(managed, "resources", environmentId, "cache");
      const data = join(managed, "resources", environmentId, "data");
      const outside = join(root, "outside");
      await mkdir(cache, { recursive: true });
      await mkdir(data);
      await mkdir(outside);
      await writeFile(join(data, "database"), "private");
      await cp(
        join(dirname(electron), "resources", "default_app.asar"),
        join(data, "private.asar"),
      );
      await writeFile(join(outside, "keep"), "outside");
      await cp(
        join(dirname(electron), "resources", "default_app.asar"),
        join(cache, "payload.asar"),
      );
      await symlink(
        outside,
        join(cache, "linked"),
        process.platform === "win32" ? "junction" : "dir",
      );
      const child = join(root, "child.cjs");
      await writeFile(
        child,
        `const {removePhysicalWorktreeDirectory}=require(${JSON.stringify(helper)}); const {createRuntimeResources}=require(${JSON.stringify(resourceHelper)}); const fs=require('node:fs/promises'); (async()=>{const before=process.noAsar; await removePhysicalWorktreeDirectory(${JSON.stringify(tree)}); const resources=createRuntimeResources(${JSON.stringify(managed)},removePhysicalWorktreeDirectory); await resources.ensure(${JSON.stringify(environmentId)}); await resources.clearRebuildable(${JSON.stringify(environmentId)}); let absent=false,cacheAbsent=false; try{await fs.access(${JSON.stringify(tree)});}catch(e){absent=e.code==='ENOENT';}try{await fs.access(${JSON.stringify(cache)});}catch(e){cacheAbsent=e.code==='ENOENT';} const dataKept=await fs.readFile(${JSON.stringify(join(data, "database"))},'utf8')==='private'; await resources.discard(${JSON.stringify(environmentId)}); let privateAbsent=false;try{await fs.access(${JSON.stringify(join(managed, "resources", environmentId))});}catch(e){privateAbsent=e.code==='ENOENT';} const outsideKept=await fs.readFile(${JSON.stringify(join(outside, "keep"))},'utf8')==='outside';process.parentPort.postMessage({absent,cacheAbsent,dataKept,privateAbsent,outsideKept,globalUnchanged:before===process.noAsar});})().catch(e=>process.parentPort.postMessage({error:String(e)}));`,
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
      assert.match(output, /"cacheAbsent":true/);
      assert.match(output, /"dataKept":true/);
      assert.match(output, /"privateAbsent":true/);
      assert.match(output, /"outsideKept":true/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
