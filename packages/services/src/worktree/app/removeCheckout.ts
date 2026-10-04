import type { WorktreeContext } from "./ports.js";

/** 调用者持有 checkout lease，并已用绑定的删除记录或归档快照确认清理范围。 */
export async function removeManagedCheckout(
  { store, git }: WorktreeContext,
  checkout: { id: string; checkoutPath: string; repositoryRoot: string },
) {
  await store.assertManagedPath(checkout.checkoutPath);
  if (checkout.checkoutPath !== store.checkout(checkout.id))
    throw new Error("Managed worktree record path does not match its ID");
  if (await git.registered(checkout.repositoryRoot, checkout.checkoutPath)) {
    try {
      await git.command(checkout.repositoryRoot, [
        "worktree",
        "remove",
        "--force",
        checkout.checkoutPath,
      ]);
    } catch (error) {
      // 日志已确认 remove 失败也会解除登记；仍有登记时保留原错误，不能绕过 Git 删除保护。
      if (await git.registered(checkout.repositoryRoot, checkout.checkoutPath)) throw error;
    }
  }
  if (await git.registered(checkout.repositoryRoot, checkout.checkoutPath))
    throw new Error("Managed worktree registration still exists after removal");
  await store.removeCheckout(checkout.checkoutPath);
  if (await store.exists(checkout.checkoutPath))
    throw new Error("Managed worktree directory still exists after removal");
}
