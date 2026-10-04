import type { WorktreeBinding } from "../contract.js";
import { taskBranchName } from "../domain/taskBranchName.js";
import type { WorktreeContext } from "./ports.js";

export async function reserveTaskBranch(
  context: WorktreeContext,
  binding: WorktreeBinding,
  taskName?: string,
): Promise<WorktreeBinding> {
  const { store, git } = context;
  const normalize = (value: string) => (process.platform === "win32" ? value.toLowerCase() : value);
  return store.lock(store.key(`task-branch:${normalize(binding.commonDirectory)}`), async () => {
    const refs = await git.command(binding.repositoryRoot, [
      "for-each-ref",
      "--format=%(refname:short)",
      "refs/heads/",
    ]);
    const occupied = new Set(refs.split(/\r?\n/u).map(normalize));
    for (const reserved of await store.listBindings()) {
      // 已删除绑定只保留防回退墓碑，不再保留名称；新任务可以复用已释放的中文分支名。
      if (
        reserved.status !== "deleted" &&
        normalize(reserved.commonDirectory) === normalize(binding.commonDirectory)
      )
        occupied.add(normalize(reserved.branch));
    }
    const base = taskBranchName(taskName);
    let branch = base;
    let suffix = 2;
    while (occupied.has(normalize(branch))) branch = `${base}-${suffix++}`;
    await git.command(binding.repositoryRoot, ["check-ref-format", "--branch", branch]);
    const named = { ...binding, branch };
    // 原因：只查 Git 再创建存在并发窗口。命名锁内先保存绑定保留名称，
    // 即使检出失败或进程重启，下一任务也不能占用同名，重试继续用原 ref。
    await store.saveBinding(named);
    return named;
  });
}
