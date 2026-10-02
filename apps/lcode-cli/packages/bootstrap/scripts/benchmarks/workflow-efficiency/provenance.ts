import { readFile, readdir } from "node:fs/promises";
import { availableParallelism } from "node:os";
import { sha256 } from "./fixtures.js";

async function treeDigest(directory: URL): Promise<string> {
  const files: { name: string; digest: string }[] = [];
  async function visit(url: URL, prefix: string): Promise<void> {
    for (const entry of await readdir(url, { withFileTypes: true })) {
      const name = `${prefix}${entry.name}`;
      const next = new URL(entry.name + (entry.isDirectory() ? "/" : ""), url);
      if (entry.isDirectory()) await visit(next, `${name}/`);
      else if (entry.name.endsWith(".js"))
        files.push({ name, digest: sha256(await readFile(next)) });
    }
  }
  await visit(directory, "");
  files.sort((a, b) => a.name.localeCompare(b.name, "en"));
  return sha256(JSON.stringify(files));
}

export async function runtimeProvenance() {
  const fileTargets = {
    adapterPublicEntry: new URL("../../../../adapters/dist/model/index.js", import.meta.url),
    enginePublicEntry: new URL("../../../../dynamic-workflow/dist/index.js", import.meta.url),
    governorSource: new URL("../../../src/app/workflow-concurrency-governor.ts", import.meta.url),
    governorCeilingSource: new URL(
      "../../../src/app/workflow-concurrency-ceiling.ts",
      import.meta.url,
    ),
    productionRetryBindingSource: new URL(
      "../../../../core/src/runtime/methods/model-request-session-type.ts",
      import.meta.url,
    ),
  };
  const fileHashes = Object.fromEntries(
    await Promise.all(
      Object.entries(fileTargets).map(async ([id, path]) => [id, sha256(await readFile(path))]),
    ),
  );
  const own = (await readdir(new URL("./", import.meta.url)))
    .filter((name) => /\.(?:ts|mjs)$/.test(name))
    .sort();
  const benchmarkCodeSha256 = sha256(
    JSON.stringify(
      await Promise.all(
        own.map(async (name) => ({
          id: name,
          sha256: sha256(await readFile(new URL(name, import.meta.url))),
        })),
      ),
    ),
  );
  return {
    node: process.version,
    platform: process.platform,
    arch: process.arch,
    availableParallelism: availableParallelism(),
    implementation: "public-dist-WorkflowEngine-with-app-free-synthetic-driver",
    subprocessHarness: "benchmark-worker-no-app-session",
    hashes: {
      ...fileHashes,
      adapterModelTree: await treeDigest(
        new URL("../../../../adapters/dist/model/", import.meta.url),
      ),
      engineTree: await treeDigest(
        new URL("../../../../dynamic-workflow/dist/engine/", import.meta.url),
      ),
      contractsModelTree: await treeDigest(
        new URL("../../../../contracts/dist/model/", import.meta.url),
      ),
      benchmarkCodeSha256,
    },
  };
}
