import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { resolve } from "node:path";
import { readdir } from "node:fs/promises";
import { readStartupMediaAssets, startupMediaDirectory } from "./startup-media-assets.mjs";

export async function assertStartupMediaPackaging(
  desktopRoot,
  rendererDirectory = resolve(desktopRoot, "out/renderer"),
) {
  const [expected, output] = await Promise.all([
    readStartupMediaAssets(startupMediaDirectory(desktopRoot)),
    readStartupMediaAssets(resolve(rendererDirectory, "startup-media")),
  ]);
  // 旧构建可能残留已删除素材；仅校验必需文件会把它再次带入安装包。
  for (const name of await readdir(resolve(rendererDirectory, "startup-media"))) {
    if (!Object.hasOwn(expected, name)) throw new Error(`Unexpected startup media: ${name}`);
  }
  for (const [name, data] of Object.entries(expected)) {
    if (!output[name]?.equals(data))
      throw new Error(`Packaged startup media differs from repository: ${name}`);
  }
}

// 官方 ASAR 读取 API 是同步的；放在异步子进程内执行，避免阻塞打包调度，也不另写 ASAR 解析器。
const verifyArchive = `
  const {createRequire}=require('node:module');
  const {join}=require('node:path');
  const {createHash}=require('node:crypto');
  const [archive,raw,resolver]=process.argv.slice(1);
  const asar=createRequire(resolver)('@electron/asar');
  const expected=JSON.parse(raw);
  const prefix='/out/renderer/startup-media/';
  for (const path of asar.listPackage(archive)) {
    const normalized=path.replaceAll('\\\\','/');
    if(normalized.startsWith(prefix) && !Object.hasOwn(expected,normalized.slice(prefix.length)))
      throw new Error('Unexpected startup media: '+normalized);
  }
  for (const [name,hash] of Object.entries(expected)) {
    const data=asar.extractFile(archive,join('out','renderer','startup-media',name));
    if(createHash('sha256').update(data).digest('hex')!==hash)
      throw new Error('Packaged startup media checksum mismatch: '+name);
  }
  process.stdout.write(JSON.stringify({files:Object.keys(expected)}));
`;

export async function assertPackagedStartupMedia(desktopRoot, archivePath) {
  const assets = await readStartupMediaAssets(startupMediaDirectory(desktopRoot));
  const hashes = Object.fromEntries(
    Object.entries(assets).map(([name, data]) => [
      name,
      createHash("sha256").update(data).digest("hex"),
    ]),
  );
  const { stdout } = await promisify(execFile)(
    process.execPath,
    [
      "-e",
      verifyArchive,
      archivePath,
      JSON.stringify(hashes),
      resolve(import.meta.dirname, "../package.json"),
    ],
    {
      cwd: desktopRoot,
      maxBuffer: 1024 * 1024,
    },
  );
  return JSON.parse(stdout);
}
