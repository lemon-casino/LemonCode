import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { withPinnedNodePath } from "./mise-toolchain-env.mjs";
import * as commands from "./spawn-command.mjs";

const runner = fileURLToPath(new URL("./mise-run.mjs", import.meta.url));
const windowsOnly = { skip: process.platform !== "win32" };
const argumentsToPreserve = [
  "",
  "two words",
  "中文参数",
  'before=>kept; /stack"/; after=>probe-created',
  'if(start<0||text.indexOf(marker,start+1)>=0)throw new Error("boundary")',
  "(s,x)=>s+x.metrics.backoff.scheduled.length",
  'x\\"y',
  'x\\\\"y',
  "C:\\folder with spaces\\",
  "%LCODE_ARGV_PROBE%",
  "!LCODE_ARGV_PROBE!",
  "a&b|c>d<e^f(g)",
  "tab\there",
  "*.ts",
];

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "lcode argv test "));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const reporter = join(directory, "argv reporter.mjs");
  await writeFile(reporter, "console.log(JSON.stringify(process.argv.slice(2)));\n");
  return { directory, reporter };
}

async function batchShim(directory, reporter, name = "probe.cmd") {
  const file = join(directory, name);
  await writeFile(file, `@echo off\r\n"${process.execPath}" "${reporter}" %*\r\n`);
  return file;
}

async function capture(child, input) {
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => (stdout += chunk));
  child.stderr.on("data", (chunk) => (stderr += chunk));
  const result = new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
  child.stdin.end(input);
  return result;
}

function options(directory) {
  return {
    cwd: directory,
    env: withPinnedNodePath(
      { ...process.env, LCODE_ARGV_PROBE: "must-not-expand" },
      process.execPath,
    ),
    windowsHide: true,
    stdio: "pipe",
    timeout: 30_000,
  };
}

async function assertNoExtraFiles(directory, expected) {
  assert.deepEqual((await readdir(directory)).sort(), [...expected].sort());
}

test("native executable argv remains data, including multiline source", async (t) => {
  const { directory, reporter } = await fixture(t);
  const args = [...argumentsToPreserve, "first line\nsecond line"];
  const stdout = commands.runCommandAndReadStdout(
    process.execPath,
    [reporter, ...args],
    options(directory),
  );
  assert.deepEqual(JSON.parse(stdout), args);
  await assertNoExtraFiles(directory, ["argv reporter.mjs"]);
});

for (const extension of ["cmd", "bat"]) {
  test(`Windows .${extension} argv survives both CMD parsing passes`, windowsOnly, async (t) => {
    const { directory, reporter } = await fixture(t);
    const shim = await batchShim(directory, reporter, `probe.${extension}`);
    const stdout = commands.runCommandAndReadStdout(shim, argumentsToPreserve, options(directory));
    assert.deepEqual(JSON.parse(stdout), argumentsToPreserve);
    await assertNoExtraFiles(directory, ["argv reporter.mjs", `probe.${extension}`]);
  });
}

test("sync command runner preserves batch argv and nonzero exit codes", windowsOnly, async (t) => {
  const { directory, reporter } = await fixture(t);
  const shim = await batchShim(directory, reporter);
  const result = commands.runCommand(shim, argumentsToPreserve, {
    ...options(directory),
    encoding: "utf8",
  });
  assert.deepEqual(JSON.parse(result.stdout), argumentsToPreserve);
  await writeFile(shim, "@exit /b 7\r\n");
  assert.throws(() => commands.runCommand(shim, [], options(directory)), /failed with code 7/);
  await assertNoExtraFiles(directory, ["argv reporter.mjs", "probe.cmd"]);
});

test("async command runner preserves batch argv", windowsOnly, async (t) => {
  const { directory, reporter } = await fixture(t);
  const shim = await batchShim(directory, reporter);
  const result = await capture(
    commands.spawnCommand(shim, argumentsToPreserve, options(directory)),
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), argumentsToPreserve);
  await assertNoExtraFiles(directory, ["argv reporter.mjs", "probe.cmd"]);
});

test("batch newline input is rejected before any process starts", windowsOnly, async (t) => {
  const { directory, reporter } = await fixture(t);
  const shim = await batchShim(directory, reporter);
  for (const newline of ["\n", "\r", "\r\n"]) {
    assert.throws(
      () => commands.runCommand(shim, [`first${newline}second`], options(directory)),
      /script file or stdin/,
    );
    assert.throws(
      () => commands.spawnCommand(`${shim}${newline}`, [], options(directory)),
      /script file or stdin/,
    );
  }
  await assertNoExtraFiles(directory, ["argv reporter.mjs", "probe.cmd"]);
});

test("mise-run bypasses PATH Node shims and preserves native inline code", async (t) => {
  const { directory } = await fixture(t);
  const bin = join(directory, "bin");
  await mkdir(bin);
  if (process.platform === "win32") {
    await writeFile(join(bin, "node.cmd"), "@exit /b 98\r\n");
  } else {
    await writeFile(join(bin, "node"), "#!/bin/sh\nexit 98\n", { mode: 0o755 });
  }
  const source = "const value = [1].map(x=>x+1);\nconsole.log(JSON.stringify(value));";
  const childOptions = options(directory);
  const pathKey = typeof childOptions.env.PATH === "string" ? "PATH" : "Path";
  childOptions.env[pathKey] =
    `${bin}${process.platform === "win32" ? ";" : ":"}${childOptions.env[pathKey]}`;
  const result = await capture(
    spawn(process.execPath, [runner, "node", "-e", source], childOptions),
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), [2]);
  await assertNoExtraFiles(directory, ["argv reporter.mjs", "bin"]);
});

test("mise-run preserves native stdin, cwd and exit status", async (t) => {
  const { directory } = await fixture(t);
  const source = "console.log(JSON.stringify({ cwd: process.cwd(), values: [1].map(x=>x+1) }));";
  const result = await capture(
    spawn(process.execPath, [runner, "node", "-"], options(directory)),
    source,
  );
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { cwd: directory, values: [2] });
  const failure = await capture(
    spawn(
      process.execPath,
      [runner, process.execPath, "-e", "process.exit(7)"],
      options(directory),
    ),
  );
  assert.equal(failure.code, 7, failure.stderr);
  await assertNoExtraFiles(directory, ["argv reporter.mjs"]);
});

test(
  "mise-run executes a real pnpm exec chain without reinterpreting argv",
  windowsOnly,
  async (t) => {
    const { directory, reporter } = await fixture(t);
    await writeFile(
      join(directory, "package.json"),
      JSON.stringify({ name: "lcode-argv-probe", private: true }),
    );
    const env = options(directory).env;
    const resolved = commands.resolveRunCommand("pnpm", {
      env,
      nodeExecutablePath: process.execPath,
    });
    const realPnpm = resolved.args[0] ?? "";
    const result = await capture(
      spawn(
        process.execPath,
        [runner, "pnpm", "exec", process.execPath, reporter, ...argumentsToPreserve],
        options(directory),
      ),
    );
    assert.equal(result.code, 0, result.stderr);
    // pnpm 自身可能先输出链接状态行，报告器 JSON 始终是最后一行。
    const lastLine = result.stdout.trim().split(/\r?\n/).at(-1);
    assert.deepEqual(JSON.parse(lastLine), argumentsToPreserve);
    assert.equal(
      resolved.command,
      process.execPath,
      "real pnpm must run through the launcher runtime",
    );
    assert.match(
      realPnpm,
      /\.cjs$/i,
      "runner should bypass the CMD shim and use the real pnpm entry",
    );
    // pnpm 会在临时项目里链接依赖并生成 lockfile；只要求不出现被截断参数产生的文件。
    await assertNoExtraFiles(directory, [
      "argv reporter.mjs",
      "package.json",
      "node_modules",
      "pnpm-lock.yaml",
    ]);
  },
);

test("missing executable is reported instead of retried through a shell", async (t) => {
  const { directory } = await fixture(t);
  const command = join(directory, "missing-executable");
  assert.throws(() => commands.runCommand(command, [], options(directory)), { code: "ENOENT" });
  const result = await capture(spawn(process.execPath, [runner, command], options(directory)));
  assert.equal(result.code, 1);
  assert.match(result.stderr, /failed to start.*ENOENT/);
  await assertNoExtraFiles(directory, ["argv reporter.mjs"]);
});
