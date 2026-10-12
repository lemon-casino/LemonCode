import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { providerNetworkRuntimeModules } from "./provider-network-runtime.mjs";
import { collectRuntimeModuleClosureEntries } from "./runtime-dependency-closure.mjs";

const desktopRoot = resolve(import.meta.dirname, "..");
const requireFromDesktop = createRequire(import.meta.url);
const { build } = createRequire(requireFromDesktop.resolve("tsup"))("esbuild");

test("Desktop ESM can load the SOCKS5 adapter with its packaged runtime dependencies", async (t) => {
  const cache = join(desktopRoot, "node_modules/.cache");
  await mkdir(cache, { recursive: true });
  const directory = await mkdtemp(join(cache, "proxy-esm-test-"));
  t.after(async () => {
    const [root, target] = await Promise.all([realpath(cache), realpath(directory)]);
    const child = relative(root, target);
    if (!child || isAbsolute(child) || child.split(sep)[0] === "..")
      throw new Error("Proxy fixture cleanup escaped its cache");
    await rm(target, { recursive: true, force: true });
  });
  const output = join(directory, "proxy.mjs");
  await build({
    entryPoints: [resolve(desktopRoot, "../provider-node/src/socks-network-dispatcher.ts")],
    outfile: output,
    bundle: true,
    platform: "node",
    format: "esm",
    external: providerNetworkRuntimeModules,
    logLevel: "silent",
  });
  const { createSocksNetworkDispatcher } = await import(pathToFileURL(output).href);
  const dispatcher = createSocksNetworkDispatcher("socks5://127.0.0.1:1080");
  await dispatcher.close();
  const closure = collectRuntimeModuleClosureEntries(providerNetworkRuntimeModules, [
    desktopRoot,
    resolve(desktopRoot, "../.."),
    resolve(desktopRoot, "../../node_modules/.pnpm/node_modules"),
  ]);
  for (const name of ["undici", "socks", "ip-address", "smart-buffer"]) {
    assert.ok(closure.find((entry) => entry.moduleName === name)?.sourceModulePath, name);
  }
});
