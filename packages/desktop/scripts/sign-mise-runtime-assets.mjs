import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile, rename, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { validateMiseBuildProvenance } from "../../../scripts/mise-build-provenance.mjs";
import {
  loadBackendArchiveApi,
  validatePackagedMiseRuntimeAssets,
} from "./prepare-mise-runtime-assets.mjs";

const execFileAsync = promisify(execFile);
const runCodesign = (command, args) => execFileAsync(command, args, { timeout: 120_000 });

export function resolveMiseSigningIdentity(env = process.env) {
  return (
    env.LCODE_CODESIGN_IDENTITY?.trim() ||
    env.APPLE_SIGNING_IDENTITY?.trim() ||
    env.CSC_NAME?.trim() ||
    "-"
  );
}

export async function verifySignedMiseRuntimeAssets({
  resourcesDir,
  target,
  backendApi,
  hostPlatform = process.platform,
  run = runCodesign,
}) {
  if (target.os !== "darwin" || hostPlatform !== "darwin") {
    throw new Error("mise codesign verification requires a macOS host and target");
  }
  const validated = await validatePackagedMiseRuntimeAssets({ resourcesDir, target, backendApi });
  // 修复：摘要一致不等于签名有效；这里只验证本地代码签名完整性，不声称 Developer ID 或公证。
  await run("/usr/bin/codesign", ["--verify", "--strict", validated.backendPath]);
  return validated;
}

export async function signPackagedMiseRuntimeAssets({
  resourcesDir,
  target,
  identity = resolveMiseSigningIdentity(),
  cacheDir,
  backendApi,
  hostPlatform = process.platform,
  run = runCodesign,
}) {
  if (target.os !== "darwin" || hostPlatform !== "darwin") {
    throw new Error("mise codesign requires a macOS host and target");
  }
  const api = backendApi ?? (await loadBackendArchiveApi());
  const input = await validatePackagedMiseRuntimeAssets({ resourcesDir, target, backendApi: api });
  await validateMiseBuildProvenance({ root: input.root, target, backendApi: api, cacheDir });
  const manifestBytes = await readFile(input.manifestPath, "utf8");
  // 修复：tools 被 signIgnore 排除，必须在主 app 签名前单独签 mise。默认 ad-hoc，已有自签身份直接复用。
  await run("/usr/bin/codesign", [
    "--force",
    "--sign",
    identity?.trim() || "-",
    "--timestamp=none",
    "--options",
    "runtime",
    input.backendPath,
  ]);
  await run("/usr/bin/codesign", ["--verify", "--strict", input.backendPath]);
  if ((await readFile(input.manifestPath, "utf8")) !== manifestBytes) {
    throw new Error("mise manifest changed during codesign");
  }
  // 签名改变 Mach-O 字节。保留固定上游 archiveSha256，只在 codesign 成功且验签后更新包内二进制摘要。
  const manifest = {
    ...JSON.parse(manifestBytes),
    binarySha256: await api.sha256File(input.backendPath),
  };
  const temporary = `${input.manifestPath}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    await rename(temporary, input.manifestPath);
  } finally {
    await rm(temporary, { force: true });
  }
  return validatePackagedMiseRuntimeAssets({ resourcesDir, target, backendApi: api });
}
