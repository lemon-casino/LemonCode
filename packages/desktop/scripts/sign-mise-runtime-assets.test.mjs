import assert from "node:assert/strict";
import { cp, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { digest, miseFixture } from "../../../scripts/mise-runtime-test-fixtures.mjs";
import {
  prepareMiseRuntimeAssets,
  resolveMiseTarget,
  validateMiseRuntimeAssets,
  validatePackagedMiseRuntimeAssets,
} from "./prepare-mise-runtime-assets.mjs";
import {
  resolveMiseSigningIdentity,
  signPackagedMiseRuntimeAssets,
} from "./sign-mise-runtime-assets.mjs";

async function macPackage(t) {
  const fixture = await miseFixture(t);
  const target = resolveMiseTarget({ os: "darwin", arch: "arm64", libc: "" });
  const prepared = await prepareMiseRuntimeAssets({
    desktopRoot: fixture.root,
    target,
    backendApi: fixture.api,
    cacheDir: fixture.cacheDir,
  });
  const resourcesDir = join(fixture.root, "LCode.app", "Contents", "Resources");
  await mkdir(join(resourcesDir, "tools"), { recursive: true });
  await cp(prepared.root, join(resourcesDir, "tools", "mise"), { recursive: true });
  return {
    ...fixture,
    target,
    prepared,
    resourcesDir,
    manifestPath: join(resourcesDir, "tools", "mise", "backend-manifest.json"),
    binaryPath: join(resourcesDir, "tools", "mise", "bin", "mise"),
  };
}

const signingOptions = (fixture) => ({
  ...fixture,
  backendApi: fixture.api,
  hostPlatform: "darwin",
  identity: "LCode Local Self Signed",
});

test("codesign and signature verification precede updating only binarySha256", async (t) => {
  const fixture = await macPackage(t);
  const before = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  const calls = [];
  const signed = Buffer.from("signed Mach-O fixture\n");
  const result = await signPackagedMiseRuntimeAssets({
    ...signingOptions(fixture),
    run: async (command, args) => {
      calls.push({ command, args });
      assert.deepEqual(JSON.parse(await readFile(fixture.manifestPath, "utf8")), before);
      assert.equal(command, "/usr/bin/codesign");
      assert.equal(args.at(-1), fixture.binaryPath);
      if (args.includes("--sign")) await writeFile(fixture.binaryPath, signed);
      else assert.ok(args.includes("--verify") && args.includes("--strict"));
    },
  });
  assert.equal(calls.length, 2);
  assert.ok(calls[0].args.includes("--timestamp=none"));
  assert.ok(calls[0].args.includes("runtime"));
  assert.ok(calls[0].args.includes(signingOptions(fixture).identity));
  assert.deepEqual(result.manifest, { ...before, binarySha256: digest(signed) });
  await validatePackagedMiseRuntimeAssets({
    resourcesDir: fixture.resourcesDir,
    target: fixture.target,
    backendApi: fixture.api,
  });
  await validateMiseRuntimeAssets({
    desktopRoot: fixture.root,
    target: fixture.target,
    backendApi: fixture.api,
    cacheDir: fixture.cacheDir,
  });
  assert.notEqual(result.manifest.binarySha256, fixture.prepared.manifest.binarySha256);
});

test("self-consistent tampered binary cannot become a signed fixed-release input", async (t) => {
  const fixture = await macPackage(t);
  const tampered = Buffer.from("not from the fixed archive\n");
  const manifest = JSON.parse(await readFile(fixture.manifestPath, "utf8"));
  await writeFile(fixture.binaryPath, tampered);
  await writeFile(
    fixture.manifestPath,
    JSON.stringify({ ...manifest, binarySha256: digest(tampered) }),
  );
  let called = false;
  await assert.rejects(
    signPackagedMiseRuntimeAssets({
      ...signingOptions(fixture),
      run: async () => {
        called = true;
      },
    }),
    /fixed archive|provenance/u,
  );
  assert.equal(called, false);
});

test("failed codesign verification does not bless the mutated binary in its manifest", async (t) => {
  const fixture = await macPackage(t);
  const before = await readFile(fixture.manifestPath, "utf8");
  await assert.rejects(
    signPackagedMiseRuntimeAssets({
      ...signingOptions(fixture),
      run: async (_command, args) => {
        if (args.includes("--sign")) await writeFile(fixture.binaryPath, "unverified signature\n");
        else throw new Error("codesign verify failed");
      },
    }),
    /codesign verify failed/u,
  );
  assert.equal(await readFile(fixture.manifestPath, "utf8"), before);
  await assert.rejects(
    validatePackagedMiseRuntimeAssets({
      resourcesDir: fixture.resourcesDir,
      target: fixture.target,
      backendApi: fixture.api,
    }),
    /binary digest/u,
  );
});

test("signing requires a macOS host, never hash-only success", async (t) => {
  const fixture = await macPackage(t);
  let calls = 0;
  const run = async () => {
    calls += 1;
  };
  await assert.rejects(
    signPackagedMiseRuntimeAssets({ ...signingOptions(fixture), hostPlatform: "win32", run }),
    /macOS/u,
  );
  assert.equal(calls, 0);
});

test("self-signed identities are reused and no identity uses real ad-hoc signing", async (t) => {
  assert.equal(resolveMiseSigningIdentity({}), "-");
  assert.equal(resolveMiseSigningIdentity({ CSC_NAME: "Local cert" }), "Local cert");
  assert.equal(
    resolveMiseSigningIdentity({ LCODE_CODESIGN_IDENTITY: "My signer", CSC_NAME: "Other" }),
    "My signer",
  );
  const fixture = await macPackage(t);
  const commands = [];
  await signPackagedMiseRuntimeAssets({
    ...signingOptions(fixture),
    identity: "",
    run: async (_command, args) => {
      commands.push(args);
      if (args.includes("--sign")) await writeFile(fixture.binaryPath, "ad-hoc signed fixture\n");
    },
  });
  assert.equal(commands[0][commands[0].indexOf("--sign") + 1], "-");
  assert.ok(commands[0].includes("--timestamp=none"));
  assert.ok(commands[1].includes("--verify"));
});

test("electron-builder explicitly signs mise before the parent app and verifies after signing", async () => {
  const source = await readFile(new URL("../electron-builder.config.js", import.meta.url), "utf8");
  assert.match(source, /afterPack:signPackagedMise/u);
  assert.match(source, /signPackagedMiseRuntimeAssets\(/u);
  assert.match(source, /afterSign:[\s\S]*verifySignedMiseRuntimeAssets\(/u);
});
