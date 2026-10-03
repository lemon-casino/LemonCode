import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { fixture } from "./testFixture.js";

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
