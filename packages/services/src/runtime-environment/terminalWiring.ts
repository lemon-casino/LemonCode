import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { RuntimeTerminalEnvironmentPort } from "../terminal/terminal.js";
import type { IWorktreeService } from "../worktree/contract.js";
import type {
  IRuntimeEnvironmentHostService,
  RuntimeEnvironmentConsumerAuthority,
} from "./contract.js";

export function createRuntimeTerminalEnvironment(options: {
  worktrees: IWorktreeService;
  environments: IRuntimeEnvironmentHostService;
  consumers: RuntimeEnvironmentConsumerAuthority;
}): RuntimeTerminalEnvironmentPort {
  const ownerId = `terminal:${randomUUID()}`;
  const samePath = (a: string, b: string) =>
    process.platform === "win32"
      ? resolve(a).toLowerCase() === resolve(b).toLowerCase()
      : resolve(a) === resolve(b);
  return {
    async acquire(request) {
      const candidates = await options.worktrees.list({
        workspacePath: request.workspacePath,
        workspaceIdentity: request.workspaceIdentity,
      });
      const binding = request.sessionId
        ? await options.worktrees.getBinding({
            workspacePath: request.workspacePath,
            workspaceIdentity: request.workspaceIdentity,
            taskId: request.sessionId,
          })
        : candidates.find((item) =>
            request.executionBindingId
              ? item.id === request.executionBindingId
              : samePath(item.workspacePath, request.workspacePath),
          );
      if (!binding) {
        if (
          request.environmentRef ||
          request.executionBindingId ||
          candidates.some((item) => samePath(item.workspacePath, request.workspacePath))
        )
          throw new Error("scope-mismatch: terminal runtime binding is missing");
        return null;
      }
      const scopeMatches = (scope: { workspacePath: string; workspaceIdentity?: string }) =>
        samePath(scope.workspacePath, request.workspacePath) &&
        (scope.workspaceIdentity?.trim() ?? "") === (request.workspaceIdentity?.trim() ?? "");
      if (
        !scopeMatches(binding) &&
        !scopeMatches({
          workspacePath: binding.originalWorkspacePath,
          workspaceIdentity: binding.originalWorkspaceIdentity,
        })
      )
        throw new Error("scope-mismatch: terminal workspace does not own the binding");
      if (request.executionBindingId && request.executionBindingId !== binding.id)
        throw new Error("scope-mismatch: terminal binding differs");
      if (binding.status !== "ready") throw new Error("resource-busy: terminal worktree is fenced");
      const ref = binding.environmentRef;
      if (!ref) {
        if (request.environmentRef || binding.environmentPolicy === "managed")
          throw new Error("stale-reference: terminal environment is unavailable");
        const cwd = request.cwd ?? binding.workspacePath;
        const [root, target] = await Promise.all([realpath(binding.checkoutPath), realpath(cwd)]);
        const suffix = relative(root, target);
        if (!isAbsolute(cwd) || suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
          throw new Error("scope-mismatch: terminal cwd leaves its checkout");
        return { executionScope: { workspacePath: binding.checkoutPath, workspaceIdentity: binding.workspaceIdentity },
          cwd, envOverlay: {}, release: async () => {} };
      }
      if (
        ref.revision < 1 ||
        (request.environmentRef &&
          (request.environmentRef.environmentId !== ref.environmentId ||
            request.environmentRef.revision !== ref.revision ||
            (request.environmentRef.manifestDigest !== undefined &&
              request.environmentRef.manifestDigest !== ref.manifestDigest)))
      )
        throw new Error("stale-reference: terminal environment changed");
      const cwd = request.cwd ?? binding.workspacePath;
      if (!isAbsolute(cwd)) throw new Error("scope-mismatch: terminal cwd must be absolute");
      const [root, child] = await Promise.all([realpath(binding.checkoutPath), realpath(cwd)]);
      const suffix = relative(
        process.platform === "win32" ? root.toLowerCase() : root,
        process.platform === "win32" ? child.toLowerCase() : child,
      );
      if (suffix === ".." || suffix.startsWith(`..${sep}`) || isAbsolute(suffix))
        throw new Error("scope-mismatch: terminal cwd leaves its checkout");
      const scope = { workspacePath: binding.checkoutPath };
      const consumer = await options.consumers.acquire({
        ...scope,
        ...ref,
        kind: "terminal",
        id: request.terminalId,
        ownerId,
      });
      const release = async () => {
        await options.consumers.release({
          ...scope,
          environmentId: consumer.environmentId,
          kind: consumer.kind,
          id: consumer.id,
          ownerId: consumer.ownerId,
          ownerGeneration: consumer.ownerGeneration,
          lease: consumer.lease,
        });
      };
      try {
        const context = await options.environments.resolveContext({
          ...scope,
          environmentId: ref.environmentId,
          expectedRevision: ref.revision,
          expectedManifestDigest: ref.manifestDigest,
          bindingId: binding.id,
          cwd,
          consumer: `terminal:${request.terminalId}`,
        });
        return {
          envOverlay: context.envOverlay,
          cwd: context.cwd,
          executionScope: {
            workspacePath: binding.checkoutPath,
            workspaceIdentity: binding.workspaceIdentity,
          },
          release,
        };
      } catch (error) {
        await release();
        throw error;
      }
    },
  };
}
