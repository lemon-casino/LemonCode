import assert from "node:assert/strict";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { createRuntimeEnvironmentHost } from "./node.js";
import { createRuntimeEnvironmentStore } from "./adapters/store.js";

const mise = process.env.LCODE_RUNTIME_TEST_MISE;
const cachedStore = process.env.LCODE_RUNTIME_TEST_TOOL_STORE;
const hasFixture = Boolean(mise && cachedStore);
const lock =
  "lockfileVersion: '9.0'\n\nsettings:\n  autoInstallPeers: true\n  excludeLinksFromLockfile: false\n\nimporters:\n\n  .: {}\n";
async function project(root: string, name: string) {
  const path = join(root, name);
  await mkdir(path, { recursive: true });
  await writeFile(
    join(path, "package.json"),
    JSON.stringify({
      name: "runtime-fixture",
      version: "1.0.0",
      packageManager: "pnpm@10.33.2",
      scripts: { dev: "node server.cjs" },
    }),
  );
  await writeFile(join(path, ".node-version"), "24.14.0\n");
  await writeFile(join(path, "pnpm-lock.yaml"), lock);
  await writeFile(
    join(path, "server.cjs"),
    "const http=require('node:http'); const s=http.createServer((q,r)=>{r.setHeader('content-type','application/json');r.end(JSON.stringify({node:process.version,environment:process.env.LCODE_RUNTIME_ENVIRONMENT_ID,data:process.env.LCODE_DATA_BASE_DIR,temp:process.env.TEMP}));});s.listen(0,'127.0.0.1',()=>console.log('http://127.0.0.1:'+s.address().port));\n",
  );
  return path;
}

test(
  "production owner prepares two isolated projects, starts actual services, stops, upgrades and preserves immutable manifests",
  {
    timeout: 120_000,
    skip: hasFixture ? false : "requires verified fixed mise and tool-store fixtures",
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), "lcode-真实环境 空格-"));
    const data = join(root, "host-data");
    const target = join(data, "tool-store", "mise", "v2026.10.2", "windows-x64");
    await mkdir(dirname(target), { recursive: true });
    await cp(cachedStore!, target, { recursive: true });
    const host = createRuntimeEnvironmentHost(data, {
      backendPath: mise!,
      resolveEnv: async () => ({
        ...process.env,
        HTTP_PROXY: "http://127.0.0.1:1",
        HTTPS_PROXY: "http://127.0.0.1:1",
        ALL_PROXY: "http://127.0.0.1:1",
        CI: "true",
        npm_config_update_notifier: "false",
      }),
    });
    const store = createRuntimeEnvironmentStore(data);
    try {
      const left = await project(root, "工作树甲");
      const right = await project(root, "工作树乙");
      const capabilities = await host.service.getCapabilities({ workspacePath: left });
      assert.equal(capabilities.managedEnvironments, true);
      const [a, b] = await Promise.all(
        [left, right].map((workspacePath, index) =>
          host.service.prepare({
            workspacePath,
            bindingId: `binding-${index}`,
            purpose: "worktree",
            requestId: `prepare-${index}`,
          }),
        ),
      );
      assert.ok(a && b);
      assert.equal(a.status, "succeeded", JSON.stringify(a.error));
      assert.equal(b.status, "succeeded", JSON.stringify(b.error));
      assert.notEqual(a.environmentId, b.environmentId);
      const manifest = await store.readManifest(a.environmentId, 1);
      assert.ok(manifest?.manifestDigest);
      const receipt = await store.readDependencyReceipt(a.environmentId);
      assert.equal(receipt?.exitCode, 0);
      assert.equal(receipt?.nodeVersion, "24.14.0");
      assert.equal(receipt?.managerVersion, "10.33.2");
      assert.equal(receipt?.manifestDigest, manifest.manifestDigest);
      const results = await Promise.all(
        [
          [a, left],
          [b, right],
        ].map(async ([operation, path]) => {
          const op = operation as typeof a;
          const workspacePath = path as string;
          return host.service.startService({
            workspacePath,
            environmentId: op.environmentId,
            requestId: "start",
            serviceId: "dev",
            expectedRevision: 1,
          });
        }),
      );
      for (const result of results) assert.equal(result.status, "started", JSON.stringify(result));
      const urls = results.map((result) => result.receipt!.urls[0]!);
      assert.notEqual(urls[0], urls[1]);
      const responses = await Promise.all(
        urls.map(
          async (url) =>
            (await fetch(url)).json() as Promise<{
              node: string;
              environment: string;
              data: string;
              temp: string;
            }>,
        ),
      );
      assert.deepEqual(
        responses.map((value) => value.node),
        ["v24.14.0", "v24.14.0"],
      );
      assert.equal(responses[0]!.environment, a.environmentId);
      assert.equal(responses[1]!.environment, b.environmentId);
      assert.notEqual(responses[0]!.data, responses[1]!.data);
      assert.notEqual(responses[0]!.temp, responses[1]!.temp);
      const repeated = await host.service.startService({
        workspacePath: left,
        environmentId: a.environmentId,
        requestId: "start",
        serviceId: "dev",
        expectedRevision: 1,
      });
      assert.equal(repeated.status, "reused");
      assert.equal(repeated.receipt?.generation, results[0]!.receipt!.generation);
      await writeFile(
        join(left, "pnpm-lock.yaml"),
        lock.replace("autoInstallPeers: true", "autoInstallPeers: false"),
      );
      await writeFile(join(left, ".npmrc"), "auto-install-peers=false\n");
      assert.equal(
        (await host.service.get({ workspacePath: left, environmentId: a.environmentId }))?.status,
        "needsUpdate",
      );
      const busy = await host.service.prepare({
        workspacePath: left,
        environmentId: a.environmentId,
        bindingId: "binding-0",
        requestId: "upgrade",
        purpose: "worktree",
        operation: "upgrade",
        expectedRevision: 1,
      });
      assert.equal(busy.error?.code, "resource-busy");
      for (const [index, operation, workspacePath] of [
        [0, a, left],
        [1, b, right],
      ] as const) {
        const stopped = await host.service.stopService({
          workspacePath,
          environmentId: operation.environmentId,
          requestId: "stop",
          serviceId: "dev",
          expectedRevision: 1,
          expectedGeneration: results[index]!.receipt!.generation,
        });
        assert.equal(stopped.status, "stopped", JSON.stringify(stopped));
        assert.deepEqual(stopped.receipt?.urls, []);
        await assert.rejects(fetch(urls[index]!, { signal: AbortSignal.timeout(1000) }));
      }
      const upgraded = await host.service.prepare({
        workspacePath: left,
        environmentId: a.environmentId,
        bindingId: "binding-0",
        requestId: "upgrade",
        purpose: "worktree",
        operation: "upgrade",
        expectedRevision: 1,
      });
      assert.equal(upgraded.status, "succeeded", JSON.stringify(upgraded.error));
      assert.equal((await store.readEnvironment(a.environmentId))?.currentRevision, 2);
      assert.deepEqual(await store.readManifest(a.environmentId, 1), manifest);
      assert.equal((await store.readDependencyReceipt(a.environmentId))?.exitCode, 0);
      const snapshot = await host.service.snapshot({
        workspacePath: left,
        environmentId: a.environmentId,
      });
      assert.equal(snapshot.environment?.currentRevision, 2);
      assert.ok(snapshot.stateRevision > 1);
      assert.equal(
        (await readFile(join(left, "pnpm-lock.yaml"), "utf8")).includes("autoInstallPeers: false"),
        true,
      );
    } finally {
      await host.disposeAndWait();
      await rm(root, { recursive: true, force: true });
    }
  },
);
