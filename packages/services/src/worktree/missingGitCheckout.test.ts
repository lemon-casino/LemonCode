import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createCheckoutCoordinator, createWorktreeService } from "./node.js";
import { createGitCommandProvider } from "../git/providers/gitCommandProvider.js";
import { handleWorktreeRequest } from "../lcode-agent/worktreeRequests.js";

async function fixture(t: TestContext) {
  const temporaryBase = resolve(tmpdir());
  const root = await mkdtemp(join(temporaryBase, "lcode-missing-git-"));
  t.after(async () => {
    assert.equal(dirname(resolve(root)), temporaryBase);
    assert.ok(basename(root).startsWith("lcode-missing-git-"));
    await rm(root, { recursive: true, force: true });
  });
  const workspacePath = join(root, "workspace");
  await mkdir(workspacePath);
  const git = createGitCommandProvider({
    environmentProvider: {
      resolveGitBinary: async () => null,
      createCommandEnv: () => assert.fail("cannot spawn without Git"),
    },
  });
  const options = { dataDir: join(root, "state"), git };
  return { root, workspacePath, options, service: createWorktreeService(options) };
}

test("无 Git 的真实 Host 请求仍可为普通对话获得并释放 writer", async (t) => {
  const f = await fixture(t);
  const workspace = { workspacePath: f.workspacePath, workspaceIdentity: "fixture-host" };
  for (const sessionId of ["first", "next"]) {
    const acquired = await handleWorktreeRequest(
      "checkout/acquireWriter",
      { ...workspace, sessionId, requestId: `${sessionId}:turn` },
      workspace,
      f.service,
    );
    assert.ok(acquired && typeof acquired === "object" && "permitId" in acquired);
    assert.equal(
      (
        (await handleWorktreeRequest(
          "checkout/releaseWriter",
          { permitId: acquired.permitId, sessionId },
          workspace,
          f.service,
        )) as { released: boolean }
      ).released,
      true,
    );
  }
  const capability = await f.service.getCapabilities(workspace);
  assert.equal(capability.create, false, "普通对话降级不能授予工作树创建能力");
});

for (const marker of ["directory", "file"] as const) {
  test(`无 Git 时 .git ${marker} 的根与子目录仍共享独占锁域`, async (t) => {
    const f = await fixture(t);
    const nested = join(f.workspacePath, "nested");
    await mkdir(nested);
    if (marker === "directory") await mkdir(join(f.workspacePath, ".git"));
    else await writeFile(join(f.workspacePath, ".git"), "gitdir: fixture-metadata\n");
    const first = createCheckoutCoordinator(f.options);
    const second = createCheckoutCoordinator(f.options);
    const lease = await first.acquire({ workspacePath: f.workspacePath, ownerId: "first" });
    try {
      await assert.rejects(
        second.acquire({ workspacePath: nested, ownerId: "second", waitMs: 1 }),
        { code: "LCODE_CHECKOUT_BUSY" },
      );
    } finally {
      await first.release(lease);
    }
    const next = await second.acquire({ workspacePath: nested, ownerId: "second" });
    assert.equal(next.workspacePath, await realpath(f.workspacePath));
    await second.release(next);
  });
}

test("未知 Git 失败与无效目录不能误判为未安装而绕过", async (t) => {
  const f = await fixture(t);
  const failure = Object.assign(new Error("fixture denied"), { code: "EACCES" });
  const coordinator = createCheckoutCoordinator({
    ...f.options,
    git: {
      run: async () => {
        throw failure;
      },
    },
  });
  await assert.rejects(
    coordinator.acquire({ workspacePath: f.workspacePath, ownerId: "owner" }),
    (error) => error === failure,
  );
  await assert.rejects(
    createCheckoutCoordinator(f.options).acquire({
      workspacePath: join(f.root, "absent"),
      ownerId: "owner",
    }),
    { code: "ENOENT" },
  );
});
