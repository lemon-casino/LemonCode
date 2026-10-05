import type { WorktreeBinding } from "../contract.js";
import type { WorktreeContext } from "./ports.js";
import { assertPreparationActive, preparationProgress } from "./preparation.js";

export async function prepareWorktreeEnvironment(
  context: WorktreeContext,
  binding: WorktreeBinding,
  retry: boolean,
  /** 冻结上下文覆盖键值（spec §9.2）；spawn 时合并进宿主环境，不改 Host process.env。 */
  frozenEnv?: Record<string, string>,
) {
  if (!binding.setup || binding.setup.status === "completed") return binding;
  if (["running", "failed"].includes(binding.setup.status) && !retry)
    throw new Error("Worktree setup needs explicit retry after failure or interrupted execution");
  let value = binding;
  await assertPreparationActive(context, value);
  let setup = { ...binding.setup, status: "pending" as const };
  if (!setup.copied) {
    try {
      await context.copyIgnoredFiles(
        value.repositoryRoot,
        value.checkoutPath,
        setup.copyIgnoredPaths,
      );
    } catch (error) {
      await context.store.saveBinding({
        ...value,
        status: "failed",
        setup: { ...setup, status: "failed" },
        error: error instanceof Error ? error.message : String(error),
        updatedAt: new Date().toISOString(),
      });
      throw error;
    }
    setup = { ...setup, copied: true };
    value = { ...value, setup, updatedAt: new Date().toISOString() };
    await context.store.saveBinding(value);
  }
  for (let index = setup.nextCommand; index < setup.commands.length; index += 1) {
    await assertPreparationActive(context, value);
    const command = setup.commands[index]!;
    value = {
      ...value,
      setup: { ...setup, status: "running", nextCommand: index },
      updatedAt: new Date().toISOString(),
    };
    await context.store.saveBinding(value);
    value = await preparationProgress(context, value, "environment", `$ ${command}\n`);
    let result;
    let streamed = false;
    try {
      result = await context.runSetup(value.checkoutPath, command, async (output) => {
        streamed = true;
        value = await preparationProgress(context, value, "environment", output);
      }, frozenEnv);
    } catch (error) {
      result = { exitCode: 1, output: error instanceof Error ? error.message : String(error) };
    }
    const results = [...setup.results, { command, ...result }];
    value = await preparationProgress(
      context,
      value,
      "environment",
      `${streamed ? "" : result.output.slice(-65536)}\nExit code: ${result.exitCode}\n`,
    );
    await assertPreparationActive(context, value);
    if (result.exitCode !== 0) {
      await context.store.saveBinding({
        ...value,
        status: "failed",
        setup: { ...setup, status: "failed", nextCommand: index, results },
        error: "Worktree setup failed",
        updatedAt: new Date().toISOString(),
      });
      throw new Error(`Worktree setup failed: ${command}`);
    }
    setup = { ...setup, nextCommand: index + 1, results };
    value = { ...value, setup, updatedAt: new Date().toISOString() };
    await context.store.saveBinding(value);
  }
  if (!setup.commands.length)
    value = await preparationProgress(
      context,
      value,
      "environment",
      "No dependency setup selected; project preparation remains part of the task.\n",
    );
  return { ...value, setup: { ...setup, status: "completed" as const } };
}
