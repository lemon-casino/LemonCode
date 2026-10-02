import { copyFile, lstat, mkdtemp, open, readFile, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import { ensureGitCommandSucceeded } from "./gitCliHelpers.js";

async function hasUpstream(command: GitCommandProvider, cwd: string, branch: string) {
  let found = false;
  for (const field of ["remote", "merge"]) {
    const result = await command.run({
      cwd,
      args: ["config", "--includes", "--get-all", `branch.${branch}.${field}`],
    });
    ensureGitCommandSucceeded("git effective upstream", result, [0, 1]);
    // 中文依据：空值、半配置、多值及 include/global 的任意值均属于用户配置，绝不能以无 tracking ref 为由覆盖。
    if (result.exitCode === 0) found = true;
  }
  return found;
}

export async function configureFirstUpstream(
  command: GitCommandProvider,
  cwd: string,
  branch: string,
  remote: string,
  assertCurrent: () => Promise<void>,
): Promise<boolean> {
  if (await hasUpstream(command, cwd, branch)) return false;
  const common = await command.run({ cwd, args: ["rev-parse", "--git-common-dir"] });
  ensureGitCommandSucceeded("git common config", common);
  const config = resolve(cwd, common.stdout.trim(), "config");
  const info = await lstat(config);
  if (!info.isFile() || info.isSymbolicLink() || info.size > 8 * 1024 * 1024)
    throw new Error("无法安全锁定上游配置文件。");
  const lockPath = `${config}.lock`;
  const lock = await open(lockPath, "wx", info.mode);
  let closed = false;
  let published = false;
  let temp: string | undefined;
  try {
    if (await hasUpstream(command, cwd, branch)) return false;
    const original = await readFile(config);
    temp = await mkdtemp(join(tmpdir(), "lcode-upstream-"));
    const candidate = join(temp, "config");
    await copyFile(config, candidate);
    for (const [field, value] of [
      ["remote", remote],
      ["merge", `refs/heads/${branch}`],
    ]) {
      const result = await command.run({
        cwd,
        args: ["config", "--file", candidate, "--add", `branch.${branch}.${field}`, value!],
      });
      ensureGitCommandSucceeded("git prepare upstream", result);
    }
    await assertCurrent();
    if (await hasUpstream(command, cwd, branch)) return false;
    if (!(await readFile(config)).equals(original))
      throw new Error("Git 配置已并发变化，保留现有上游。");
    // 中文依据：remote/merge 必须在同一个 config.lock 中发布；两条 git config 或 --set-upstream 会留下半配置/覆盖用户配置。
    await lock.writeFile(await readFile(candidate));
    await lock.sync();
    await lock.close();
    closed = true;
    await rename(lockPath, config);
    published = true;
    return true;
  } finally {
    if (!closed) await lock.close();
    // 中文依据：rename 后 config.lock 已不是我们的锁；不能删除紧接着由其它 Git 进程新建的锁。
    if (!published) await rm(lockPath, { force: true }).catch(() => {});
    if (temp) await rm(temp, { recursive: true, force: true }).catch(() => {});
  }
}
