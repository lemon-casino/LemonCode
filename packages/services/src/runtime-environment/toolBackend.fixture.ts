import childProcess, { type ChildProcess, type ExecFileOptions } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { MISE_BACKEND_VERSION, MISE_ASSET_DIGESTS } from "./adapters/backendArchive.js";
import {
  backendExecutableName,
  backendPlatformKey,
  type BackendPlatform,
} from "./adapters/backendPlatform.js";
import type { createToolBackend } from "./adapters/toolBackend.js";

export const WINDOWS_X64: BackendPlatform = { platform: "win32", arch: "x64" };

export async function withTempDir<T>(action: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), "lcode-tool-backend-"));
  try {
    return await action(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

export interface CommandInvocation {
  executable: string;
  args: string[];
  options: ExecFileOptions;
  child: ChildProcess;
  complete(error?: Error | null, stdout?: string, stderr?: string): void;
  close(code?: number | null): void;
}

interface FakeBackendFixture {
  root: string;
  dataDir: string;
  backendPath: string;
  nodePath: string;
  pnpmRoot: string;
  commands: CommandInvocation[];
  backend: ReturnType<typeof createToolBackend>;
  commandHandler?: (command: CommandInvocation) => boolean;
}

export async function writeFixtureFile(path: string, content: string | Buffer): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
  await chmod(path, 0o755);
}

export async function withFakeBackend(
  platform: BackendPlatform,
  action: (fixture: FakeBackendFixture) => Promise<void>,
): Promise<void> {
  await withTempDir(async (root) => {
    const platformKey = backendPlatformKey(platform);
    const bundleRoot = join(root, "bundled mise");
    const backendPath = join(bundleRoot, "bin", backendExecutableName(platform));
    const bytes = Buffer.from("test-only backend; subprocess execution is mocked");
    await writeFixtureFile(backendPath, bytes);
    if (platform.platform === "win32") await writeFixtureFile(join(bundleRoot, "bin/mise-shim.exe"), "shim");
    await writeFixtureFile(join(bundleRoot, "LICENSE"), "test fixture");
    await writeFixtureFile(join(bundleRoot, "README.md"), "test fixture");
    await writeFile(join(bundleRoot, "backend-manifest.json"), JSON.stringify({
      version: MISE_BACKEND_VERSION,
      platform: platformKey,
      archiveSha256: MISE_ASSET_DIGESTS[platformKey],
      binarySha256: createHash("sha256").update(bytes).digest("hex"),
    }));
    const dataDir = join(root, "data with spaces", "运行环境");
    const installs = join(dataDir, "tool-store", "mise", MISE_BACKEND_VERSION, platformKey, "data", "installs");
    const nodePath = join(installs, "node", "24.14.0", platform.platform === "win32" ? "node.exe" : "bin/node");
    const pnpmRoot = join(installs, "pnpm", "10.33.2");
    await writeFixtureFile(nodePath, "managed node fixture");
    await mkdir(pnpmRoot, { recursive: true });
    const originalExecFile = childProcess.execFile;
    const commands: CommandInvocation[] = [];
    let fixture: FakeBackendFixture;
    const fakeExecFile = ((
      executable: string,
      args: string[],
      options: ExecFileOptions,
      callback: (error: Error | null, stdout: string, stderr: string) => void,
    ) => {
      const child = new EventEmitter() as ChildProcess;
      Object.defineProperties(child, {
        pid: { value: 12345 },
        exitCode: { value: null, writable: true },
        signalCode: { value: null },
      });
      child.kill = () => true;
      const invocation: CommandInvocation = {
        executable, args, options, child,
        complete(error = null, stdout = "", stderr = "") { callback(error, stdout, stderr); },
        close(code = 0) { Object.defineProperty(child, "exitCode", { value: code }); child.emit("close", code, null); },
      };
      commands.push(invocation);
      queueMicrotask(() => {
        if (fixture.commandHandler?.(invocation)) return;
        let stdout = "";
        if (args[1] === "version") stdout = `${MISE_BACKEND_VERSION.slice(1)} ${platformKey}\n`;
        else if (args[1] === "where") {
          const [key, version] = args[2]!.split("@");
          stdout = `${join(installs, key!, version!)}\n`;
        } else if (args[1] === "ls-remote") {
          stdout = JSON.stringify(["24.14.0", "24.14.1", "22.20.0", "26.0.0-beta.1", "invalid"]);
        } else if (args.at(-1) === "--version") {
          stdout = executable === nodePath && args.length === 1 ? "v24.14.0\n" : "10.33.2\n";
        }
        invocation.complete(null, stdout);
        invocation.close();
      });
      return child;
    }) as typeof childProcess.execFile;
    Object.defineProperty(fakeExecFile, promisify.custom, {
      value: (executable: string, args: string[], options: ExecFileOptions) => new Promise((resolve, reject) => {
        fakeExecFile(executable, args, options, (error, stdout, stderr) => {
          if (error) reject(error);
          else resolve({ stdout, stderr });
        });
      }),
    });
    childProcess.execFile = fakeExecFile;
    syncBuiltinESMExports();
    try {
      const module = await import(`./adapters/toolBackend.js?regression=${randomUUID()}`) as typeof import("./adapters/toolBackend.js");
      fixture = {
        root, dataDir, backendPath, nodePath, pnpmRoot, commands,
        backend: module.createToolBackend({
          dataDir, backendPath, platform,
          resolveEnv: async () => ({
            Path: join(root, "arbitrary host tools"),
            NODE_OPTIONS: "--require arbitrary-host-hook",
            NODE_PATH: join(root, "host modules"),
            MISE_DATA_DIR: join(root, "untrusted global mise"),
            mIsE_CONFIG_DIR: join(root, "untrusted mixed case mise"),
          }),
        }),
      };
      await action(fixture);
    } finally {
      childProcess.execFile = originalExecFile;
      syncBuiltinESMExports();
    }
  });
}
