import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rm, cp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { test } from "node:test";

for (const managed of [true, false]) {
  for (const phase of ["", "--prepare-only", "--runtime-only"]) {
    test(`desktop launcher uses ${managed ? "managed" : "system"} tools and executes ${phase || "both phases"} once`, async () => {
      const root = await mkdtemp(join(tmpdir(), "lcode-dev-phases-"));
      try {
        await mkdir(join(root, "scripts"));
        await cp(
          new URL("./dev-desktop-env.mjs", import.meta.url),
          join(root, "scripts/dev-desktop-env.mjs"),
        );
        await writeFile(
          join(root, "scripts/mise-toolchain-env.mjs"),
          "export const withPinnedNodePath=(env)=>({...env,PINNED_NODE:'applied'});",
        );
        await writeFile(
          join(root, "scripts/runtime-development-env.mjs"),
          "export const assertRuntimeDevelopmentDataRoot=()=>{}; export const withDefaultDevelopmentDataRoot=(env)=>env;",
        );
        await writeFile(
          join(root, "scripts/spawn-command.mjs"),
          `import {EventEmitter} from 'node:events';import{appendFileSync}from'node:fs';export const resolveRunCommand=(_command,options)=>({command:options.env.npm_execpath,args:[]});export function spawnCommand(command,args,options){appendFileSync(${JSON.stringify(join(root, "calls.jsonl"))},JSON.stringify({command,args,env:{data:options.env.LCODE_DATA_BASE_DIR,id:options.env.LCODE_RUNTIME_ENVIRONMENT_ID,pinned:options.env.PINNED_NODE}})+'\\n');const child=new EventEmitter();queueMicrotask(()=>child.emit('exit',0));return child;}`,
        );
        const code = await new Promise((resolve, reject) => {
          const child = spawn(
            process.execPath,
            [join(root, "scripts/dev-desktop-env.mjs"), "production", ...(phase ? [phase] : [])],
            {
              env: {
                ...process.env,
                LCODE_DATA_BASE_DIR: join(root, "data"),
                LCODE_RUNTIME_ENVIRONMENT_ID: managed ? "fixture" : "",
                npm_execpath: join(root, "frozen-pnpm.exe"),
              },
              stdio: "pipe",
            },
          );
          child.once("error", reject);
          child.once("close", resolve);
        });
        assert.equal(code, 0);
        const calls = (await readFile(join(root, "calls.jsonl"), "utf8"))
          .trim()
          .split("\n")
          .map((line) => JSON.parse(line));
        assert.equal(
          calls.some((call) => call.args.includes("pre-dev")),
          phase !== "--runtime-only",
        );
        assert.equal(
          calls.some((call) =>
            call.args.some((value) => value.endsWith("build-desktop-agent-cli.mjs")),
          ),
          phase !== "--runtime-only",
        );
        assert.equal(
          calls.some((call) => call.args.includes("dev:runtime")),
          phase !== "--prepare-only",
        );
        for (const call of calls)
          assert.deepEqual(call.env, {
            data: join(root, "data"),
            id: managed ? "fixture" : "",
            ...(managed ? { pinned: "applied" } : {}),
          });
        for (const call of calls.filter((call) => call.args.includes("--filter")))
          assert.equal(
            call.command,
            managed
              ? join(root, "frozen-pnpm.exe")
              : process.platform === "win32"
                ? "pnpm.cmd"
                : "pnpm",
          );
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    });
  }
}
