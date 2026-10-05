import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fixture } from "./testFixture.js";

async function childPermit(
  dataDir: string,
  path: string,
  mode: "shared" | "exclusive",
  abandon = false,
) {
  const script = `
    const { createCheckoutCoordinator } = await import(${JSON.stringify(new URL("./adapters/coordinator.ts", import.meta.url).href)});
    const { createWorktreeGitPort } = await import(${JSON.stringify(new URL("../git/worktreeGitPort.ts", import.meta.url).href)});
    const params = JSON.parse(process.argv[1]);
    const coordinator = createCheckoutCoordinator({dataDir: params.dataDir, git: createWorktreeGitPort()});
    try {
      const permit = await coordinator.acquire({workspacePath:params.path,ownerId:'child',mode:params.mode,waitMs:100});
      if (!params.abandon) await coordinator.release(permit);
      process.stdout.write('granted');
    } catch (error) {process.stdout.write(error.code ?? error.message);}
  `;
  return (
    await promisify(execFile)(
      process.execPath,
      [
        "--import",
        "tsx",
        "--input-type=module",
        "-e",
        script,
        "--",
        JSON.stringify({ path, dataDir, mode, abandon }),
      ],
      { cwd: process.cwd(), windowsHide: true },
    )
  ).stdout;
}

test("different Host sessions share execution but management waits for all live owners", async (t) => {
  const f = await fixture(t);
  const first = await f.service.acquireCheckout({
    workspacePath: f.repo,
    ownerId: "A",
    mode: "shared",
  });
  const second = await f.service.acquireCheckout({
    workspacePath: f.repo,
    ownerId: "B",
    mode: "shared",
  });
  const release = (lease: typeof first) =>
    f.service.releaseCheckout({ token: lease.token, ownerId: lease.ownerId });
  t.after(() => release(first));
  t.after(() => release(second));
  assert.equal(await childPermit(f.options.dataDir, f.repo, "shared"), "granted");
  assert.equal(await childPermit(f.options.dataDir, f.repo, "exclusive"), "LCODE_CHECKOUT_BUSY");
  await release(first);
  assert.equal(await childPermit(f.options.dataDir, f.repo, "exclusive"), "LCODE_CHECKOUT_BUSY");
  await release(second);
  assert.equal(await childPermit(f.options.dataDir, f.repo, "exclusive"), "granted");
  // 退出后的共享 owner 使用原文件锁 PID 对账，不用时间到期伪造 writer 已结束。
  assert.equal(await childPermit(f.options.dataDir, f.repo, "shared", true), "granted");
  assert.equal(await childPermit(f.options.dataDir, f.repo, "exclusive"), "granted");
});

test("separate Host processes share canonical checkout permits, while task worktrees run independently", async (t) => {
  const f = await fixture(t);
  const binding = await f.service.prepare({ workspacePath: f.repo, taskId: "A", requestId: "A" });
  const nested = join(f.repo, "nested");
  await mkdir(nested);
  const lease = await f.service.acquireCheckout({ workspacePath: f.repo, ownerId: "parent" });
  const script = `
    const { createCheckoutCoordinator } = await import(${JSON.stringify(new URL("./adapters/coordinator.ts", import.meta.url).href)});
    const { createWorktreeGitPort } = await import(${JSON.stringify(new URL("../git/worktreeGitPort.ts", import.meta.url).href)});
    const params = JSON.parse(process.argv[1]);
    const coordinator = createCheckoutCoordinator({dataDir: params.dataDir, git: createWorktreeGitPort()});
    try {
      const permit = await coordinator.acquire({workspacePath:params.path,ownerId:'child',waitMs:100});
      await coordinator.release(permit);
      process.stdout.write('granted');
    } catch (error) {process.stdout.write(error.code ?? error.message);}
  `;
  const child = async (path: string) =>
    (
      await promisify(execFile)(
        process.execPath,
        [
          "--import",
          "tsx",
          "--input-type=module",
          "-e",
          script,
          "--",
          JSON.stringify({ path, dataDir: f.options.dataDir }),
        ],
        { cwd: process.cwd(), windowsHide: true },
      )
    ).stdout;
  assert.equal(await child(nested), "LCODE_CHECKOUT_BUSY");
  assert.equal(await child(binding.workspacePath), "granted");
  await f.service.releaseCheckout({ token: lease.token, ownerId: lease.ownerId });
  assert.equal(await child(nested), "granted");
});
