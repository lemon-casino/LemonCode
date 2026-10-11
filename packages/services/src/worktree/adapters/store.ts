import { createHash } from "node:crypto";
import { access, lstat, mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";
import type { WorktreeBinding, WorktreeIntegration } from "../contract.js";
import type { WorktreeStore } from "../app/ports.js";
import { bindingRecord, operationRecord } from "./records.js";
import { createWorktreeAliases } from "./aliases.js";
import { isOwnedCheckoutScope } from "./checkoutScope.js";
import { createWorktreeManagementSettings } from "./managementSettings.js";
import { ignoreNestedCheckoutRoot } from "./checkoutIgnore.js";

export function createWorktreeStore(
  dataDir: string,
  removeDirectory: (path: string) => Promise<void> = (path) =>
    rm(path, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }),
): WorktreeStore {
  const root = resolve(dataDir);
  const checkouts = join(root, "checkouts");
  const settings = createWorktreeManagementSettings(root);
  function recordPath(kind: string, id: string) {
    if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid worktree record id");
    return join(root, kind, `${id}.json`);
  }
  async function read(kind: string, id: string): Promise<unknown | null> {
    try {
      return JSON.parse(await readFile(recordPath(kind, id), "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }
  async function write(kind: string, id: string, value: unknown) {
    await atomicWritePrivateTextFile(recordPath(kind, id), `${JSON.stringify(value)}\n`);
  }
  async function assertManagedPath(path: string) {
    const normalized = resolve(path);
    let managedRoot = checkouts;
    if (dirname(normalized) !== checkouts) {
      const id = basename(normalized);
      const value = await read("bindings", id);
      const binding = value === null ? null : bindingRecord.parse(value);
      // 自定义根目录只能由已落盘的 owner 记录授权，不能按传入路径放宽删除范围。
      if (
        !binding?.checkoutRoot ||
        binding.id !== id ||
        binding.checkoutPath !== normalized ||
        join(resolve(binding.checkoutRoot), id) !== normalized
      )
        throw new Error("Worktree path is outside the managed checkout root");
      managedRoot = resolve(binding.checkoutRoot);
    }
    const child = relative(managedRoot, normalized);
    if (
      !child ||
      child.startsWith(`..${sep}`) ||
      child === ".." ||
      isAbsolute(child) ||
      child.includes(sep)
    ) {
      throw new Error("Worktree path is outside the managed checkout root");
    }
    await mkdir(managedRoot, { recursive: true });
    if (
      (await lstat(managedRoot)).isSymbolicLink() ||
      resolve(await realpath(managedRoot)) !== managedRoot
    ) {
      throw new Error("Managed checkout root has been redirected");
    }
    try {
      if (
        (await lstat(normalized)).isSymbolicLink() ||
        resolve(await realpath(normalized)) !== normalized
      ) {
        throw new Error("Managed checkout has been redirected");
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return {
    ...settings,
    ...createWorktreeAliases(root),
    key: (value) => createHash("sha256").update(value).digest("hex").slice(0, 32),
    checkout: (id, checkoutRoot) => {
      recordPath("bindings", id);
      return join(checkoutRoot ? resolve(checkoutRoot) : checkouts, id);
    },
    async allocateCheckout(id, repositoryRoot, commonDirectory) {
      recordPath("bindings", id);
      const config = await settings.getManagementSettings();
      const checkoutRoot =
        config.rootLocation === "project"
          ? join(repositoryRoot, ".lcode", "worktrees", "checkouts")
          : config.rootLocation === "custom" && config.rootDirectory
            ? resolve(config.rootDirectory)
            : undefined;
      const selectedRoot = checkoutRoot ?? checkouts;
      await ignoreNestedCheckoutRoot(
        repositoryRoot,
        commonDirectory,
        resolve(selectedRoot) === resolve(repositoryRoot) ? join(selectedRoot, id) : selectedRoot,
      );
      return {
        checkoutPath: join(checkoutRoot ?? checkouts, id),
        ...(checkoutRoot ? { checkoutRoot } : {}),
      };
    },
    lock: (key, action) =>
      withFileLock(recordPath("locks", key), action, { lockMaxWaitMs: 30_000 }),
    async readBinding(id) {
      const value = await read("bindings", id);
      if (value === null) return null;
      const binding = bindingRecord.parse(value);
      if (binding.id !== id) throw new Error("Worktree record ID does not match its filename");
      return binding;
    },
    async saveBinding(binding: WorktreeBinding) {
      await write("bindings", binding.id, bindingRecord.parse(binding));
    },
    async readPreparationRequest(scope, requestId) {
      const id = createHash("sha256")
        .update(JSON.stringify([scope, requestId]))
        .digest("hex")
        .slice(0, 32);
      const value = await read("requests", id);
      if (value === null) return null;
      if (typeof value !== "string" || !/^[a-f0-9]{32}$/.test(value))
        throw new Error("Invalid preparation request record");
      return value;
    },
    async savePreparationRequest(scope, requestId, bindingId) {
      const id = createHash("sha256")
        .update(JSON.stringify([scope, requestId]))
        .digest("hex")
        .slice(0, 32);
      await write("requests", id, bindingId);
    },
    async isPreparationCancelled(id) {
      return (await read("cancellations", id)) === true;
    },
    async cancelPreparation(id) {
      await write("cancellations", id, true);
    },
    async listBindings() {
      let files: string[];
      try {
        files = await readdir(join(root, "bindings"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
        throw error;
      }
      const values = await Promise.all(
        files
          .filter((file) => /^[a-f0-9]{32}\.json$/.test(file))
          .map(async (file) => {
            const value = bindingRecord.parse(await read("bindings", file.slice(0, -5)));
            if (`${value.id}.json` !== file)
              throw new Error("Worktree record ID does not match its filename");
            return value;
          }),
      );
      return values;
    },
    async findExecutionBinding(scope, resource) {
      // 文件监听只有物理路径；只在可信 Host 的资源检查中使用绑定身份，执行查询仍严格匹配传入身份。
      const matches = (binding: WorktreeBinding) =>
        isOwnedCheckoutScope(
          binding,
          resource === "file-watch"
            ? { workspacePath: scope.workspacePath, workspaceIdentity: binding.workspaceIdentity }
            : scope,
        );
      // 从受管路径直接定位一条记录；spawn 不扫描目录树或全部工作树，避免删除时放大 IO/CPU。
      const target = resolve(scope.workspacePath);
      // macOS 卷可能忽略大小写；文本候选只放宽大小写，随后仍由 realpath 核对实际归属。
      const path =
        process.platform === "darwin"
          ? relative(checkouts.toLowerCase(), target.toLowerCase())
          : relative(checkouts, target);
      // 新根目录不在默认根下；从不透明目录 id 读取私有记录后仍核对 canonical scope，
      // 保留删除 fence，不能因位置设置改变而把已有树当普通本地目录放行。
      if (isAbsolute(path) || path.startsWith(`..${sep}`)) {
        for (const component of target.split(sep).reverse()) {
          if (!/^[a-f0-9]{32}$/i.test(component)) continue;
          const binding = await this.readBinding(component.toLowerCase());
          if (binding && (await matches(binding))) return binding;
        }
        return null;
      }
      const component = path.split(sep)[0] ?? "";
      const id =
        process.platform === "win32" || process.platform === "darwin"
          ? component.toLowerCase()
          : component;
      if (!/^[a-f0-9]{32}$/.test(id)) return null;
      const binding = await this.readBinding(id);
      return binding && (await matches(binding)) ? binding : null;
    },
    async readOperation(id) {
      const value = await read("operations", id);
      if (value === null) return null;
      const operation = operationRecord.parse(value);
      if (operation.id !== id) throw new Error("Integration record ID does not match its filename");
      return operation;
    },
    async saveOperation(operation: WorktreeIntegration) {
      await write("operations", operation.id, operationRecord.parse(operation));
    },
    assertManagedPath,
    async removeCheckout(path) {
      // Git 可能已经解除登记但留下依赖目录；仅清理未重定向、没有新仓库标记的受管残留。
      await assertManagedPath(path);
      try {
        await lstat(join(path, ".git"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        // Electron 的 fs 将 .asar 当虚拟目录，递归删除可能永不返回；由宿主注入物理 fs。
        await removeDirectory(path);
        return;
      }
      throw new Error("Residual worktree contains a Git marker; preserve the existing directory");
    },
    async exists(path) {
      try {
        await access(path);
        return true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
      }
    },
  };
}
