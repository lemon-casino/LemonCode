import { z } from "zod";
import { bindingOwnerRefSchema, runtimeEnvironmentPolicySchema } from "@lcode/shared";
import type {
  WorktreeOwnedBindings,
  WorktreeOwnedPrepareRequest,
  WorktreePreparationRequest,
} from "../ownedBindingContract.js";
import type { WorktreeBinding } from "../contract.js";
import type { WorktreeContext } from "./ports.js";
import { bindingKey } from "./bindingLookup.js";
import { relative, sep } from "node:path";
const text = z.string().trim().min(1);
const setOwner = bindingOwnerRefSchema.options[1];
const prepareSchema = z.strictObject({
  workspacePath: text,
  workspaceIdentity: text.optional(),
  requestId: text,
  ownerRef: setOwner,
  taskName: text.max(256).optional(),
  environmentPolicy: runtimeEnvironmentPolicySchema.optional(),
  forkSource: z
    .strictObject({ workspacePath: text, workspaceIdentity: text.optional() })
    .optional(),
  projectId: text.optional(),
  baseRef: text.optional(),
  sourceFolderPaths: z.array(text).max(20).optional(),
  setupCommands: z.array(text).max(64).optional(),
  copyIgnoredPaths: z.array(text).optional(),
  retrySetup: z.boolean().optional(),
  cancel: z.boolean().optional(),
});
const consumerSchema = z.strictObject({
  bindingId: text,
  owner: bindingOwnerRefSchema,
  operationId: text,
});
const ownerKey = (owner: z.infer<typeof bindingOwnerRefSchema>) => JSON.stringify(owner);

export function createOwnedBindings(
  context: WorktreeContext,
  prepare: (params: WorktreePreparationRequest) => Promise<WorktreeBinding>,
  ready: (binding: WorktreeBinding) => Promise<void>,
): WorktreeOwnedBindings {
  const { store } = context;
  const update = async (bindingId: string, action: (binding: WorktreeBinding) => WorktreeBinding) =>
    store.lock(bindingId, async () => {
      const binding = await store.readBinding(bindingId);
      if (!binding) throw new Error("Worktree binding not found");
      const next = action(binding);
      await store.saveBinding(next);
      return next;
    });
  return {
    async inspectOwnedRepository(request) {
      const input = z
        .strictObject({
          workspacePath: text,
          workspaceIdentity: text.optional(),
          baseRef: text.optional(),
          requireDirectoryAtRef: z.literal(true).optional(),
        })
        .parse(request);
      const info = await context.git.inspect(input.workspacePath);
      if (!context.git.canonicalDirectory)
        throw new Error("Collaboration requires canonical directory inspection");
      const canonicalPath = await context.git.canonicalDirectory(input.workspacePath);
      if (await context.git.command(info.root, ["rev-parse", "--show-superproject-working-tree"]))
        throw new Error("Submodule collaboration worktrees are not supported");
      let head = info.head;
      if (input.baseRef) {
        if (input.baseRef.startsWith("-") || /\s/.test(input.baseRef))
          throw new Error("Invalid collaboration base ref");
        head = await context.git.command(info.root, [
          "rev-parse",
          "--verify",
          `${input.baseRef}^{commit}`,
        ]);
      }
      const child = relative(info.root, canonicalPath).split(sep).join("/");
      if (input.requireDirectoryAtRef && child) {
        // 中文依据：Git 不保存空目录，源路径存在并不证明 checkout 含该成员；必须核对冻结 commit，不能先报 ready 再到 admission 失败。
        const found = await context.git.run({
          cwd: info.root,
          args: ["cat-file", "-t", `${head}:${child}`],
          maxOutputBytes: 4096,
        });
        if (found.exitCode !== 0 || found.stdout.trim() !== "tree")
          throw new Error(
            `${input.workspacePath}: folder is absent from the selected Git base; commit its contents or choose another base`,
          );
      }
      return { ...info, head, canonicalPath };
    },
    prepareOwnedBinding: (request: WorktreeOwnedPrepareRequest) =>
      prepare(prepareSchema.parse(request)),
    async getOwnedBinding(request) {
      const input = z
        .strictObject({
          workspacePath: text,
          workspaceIdentity: text.optional(),
          ownerRef: setOwner,
        })
        .parse(request);
      const binding = await store.readBinding(bindingKey(context, input));
      if (!binding) return null;
      if (!binding.ownerRef || ownerKey(binding.ownerRef) !== ownerKey(input.ownerRef))
        throw new Error("Worktree binding owner differs");
      if (binding.status === "ready") await ready(binding);
      return binding;
    },
    async attachBindingConsumer(request) {
      const input = consumerSchema.parse(request);
      return update(input.bindingId, (binding) => {
        if (binding.status !== "ready")
          throw new Error("Cannot attach a consumer to an unavailable worktree");
        const consumers = binding.consumers ?? [];
        if (consumers.some((consumer) => ownerKey(consumer.owner) === ownerKey(input.owner)))
          return binding;
        return {
          ...binding,
          consumers: [...consumers, { owner: input.owner, operationId: input.operationId }],
        };
      });
    },
    async detachBindingConsumer(request) {
      const input = consumerSchema
        .extend({ stopReceipt: z.strictObject({ stopped: z.literal(true), operationId: text }) })
        .parse(request);
      if (input.stopReceipt.operationId !== input.operationId)
        throw new Error("Consumer release requires the matching stop receipt");
      return update(input.bindingId, (binding) => ({
        ...binding,
        consumers:
          binding.consumers?.filter(
            (consumer) => ownerKey(consumer.owner) !== ownerKey(input.owner),
          ) ?? [],
      }));
    },
  };
}
