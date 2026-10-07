import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { access, chmod, copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { TestContext } from "node:test";
import type { IRemoteBackend, RemoteEnvironment, StdioStream } from "./backend.js";
import { REMOTE_BASE } from "./deployShared.js";
import { quotePosixShellArg } from "./posixShell.js";
import { createTarGzArchive } from "./localTarGz.js";
import type { RemoteAssetManifestRef } from "./remoteAssetCache.js";

export const MISE_TEST_VERSION = "v2026.10.2";
export const MISE_TEST_MEMBERS = ["bin/mise", "LICENSE", "README.md", "backend-manifest.json"];
export const miseTestLoggers = { log() {}, logWarn() {} };

/** 仅将远端文件/命令映射到本机临时 HOME，不建立 SSH、WSL、Docker 或网络连接。 */
export class LocalFixtureRemoteBackend implements IRemoteBackend {
  readonly commands: string[] = [];
  readonly uploads: string[] = [];

  constructor(
    readonly home: string,
    readonly environment: RemoteEnvironment,
  ) {}

  localPath(path: string): string {
    return path.startsWith("~/") ? join(this.home, path.slice(2)) : path;
  }

  async detect(): Promise<RemoteEnvironment> {
    return this.environment;
  }
  dispose(): void {}

  async exists(path: string): Promise<boolean> {
    try {
      await access(this.localPath(path));
      return true;
    } catch {
      return false;
    }
  }

  async readFile(path: string): Promise<string> {
    return readFile(this.localPath(path), "utf8");
  }

  async upload(source: string, destination: string): Promise<void> {
    this.uploads.push(destination);
    await mkdir(dirname(this.localPath(destination)), { recursive: true });
    await copyFile(source, this.localPath(destination));
  }

  async exec(command: string): Promise<StdioStream> {
    this.commands.push(command);
    const child = spawn("bash", ["--noprofile", "--norc", "-c", command], {
      env: { ...process.env, HOME: this.home.replaceAll("\\", "/") },
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      onClose(listener) {
        const onClose = (code: number | null) => listener(code ?? 1);
        child.once("close", onClose);
        return {
          dispose() {
            child.off("close", onClose);
          },
        };
      },
    };
  }
}

export async function createMiseDeployFixture(t: TestContext, platformArch = "linux-x64") {
  const root = await mkdtemp(join(tmpdir(), "lcode-mise-deploy-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const [platform, arch] = platformArch.split("-");
  const backend = new LocalFixtureRemoteBackend(join(root, "home"), {
    platform: platform!,
    arch: arch!,
  });
  const releaseDir = join(root, "release");
  const sourceRelativePath = `tools/${platformArch}/mise`;
  const sourceDir = join(releaseDir, sourceRelativePath);
  const backendPlatform = platformArch.replace(/^darwin-/u, "macos-");
  const binary = `#!/bin/sh\n[ "$1" = "--no-config" ] && [ "$2" = "--version" ] || exit 42\nprintf '%s\\n' '2026.10.2 ${backendPlatform} (fixture)'\n`;
  await mkdir(join(sourceDir, "bin"), { recursive: true });
  await writeFile(join(sourceDir, "bin/mise"), binary);
  await writeFile(join(sourceDir, "LICENSE"), "fixture license\n");
  await writeFile(join(sourceDir, "README.md"), "fixture readme\n");
  const manifest = {
    version: MISE_TEST_VERSION,
    platform: backendPlatform,
    archiveSha256: "a".repeat(64),
    binarySha256: createHash("sha256").update(binary).digest("hex"),
  };
  await writeFile(join(sourceDir, "backend-manifest.json"), JSON.stringify(manifest));
  // 用真实 Node 执行生成的只读校验脚本；mise 本身是明确标注的 POSIX 假程序。
  const nodePath = backend.localPath(`${REMOTE_BASE}/node`);
  await mkdir(dirname(nodePath), { recursive: true });
  await writeFile(
    nodePath,
    `#!/bin/sh\nexec ${quotePosixShellArg(process.execPath.replaceAll("\\", "/"))} "$@"\n`,
  );
  await chmod(nodePath, 0o755);
  const archivePath = join(root, "component.tar.gz");
  await createTarGzArchive(
    archivePath,
    ["bin", "LICENSE", "README.md", "backend-manifest.json"].map((name) => ({
      sourcePath: join(sourceDir, name),
      archivePath: name,
    })),
  );
  const sha256 = createHash("sha256")
    .update(await readFile(archivePath))
    .digest("hex");
  const version = `${MISE_TEST_VERSION}+${sha256.slice(0, 12)}`;
  const manifestRef: RemoteAssetManifestRef = {
    manifest: {
      schemaVersion: 1,
      appVersion: "fixture-app",
      platformArch,
      components: [
        {
          id: "mise",
          version,
          sha256,
          mount: sourceRelativePath,
          artifactPath: `components/${platformArch}/mise/${version}.tar.gz`,
        },
      ],
    },
    releaseBaseCandidatesForComponents: ["https://fixture.invalid/releases/fixture-app"],
  };
  await writeFile(
    join(releaseDir, `manifest-${platformArch}.json`),
    JSON.stringify(manifestRef.manifest),
  );
  return {
    root,
    backend,
    releaseDir,
    sourceDir,
    sourceRelativePath,
    archivePath,
    manifestRef,
    manifest,
    platformArch,
  };
}
