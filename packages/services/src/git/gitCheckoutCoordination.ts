import { randomUUID } from "node:crypto";
import type { GitRepositoryRequest } from "@lcode/shared";
import type { CheckoutCoordinator } from "../worktree/node.js";
import type { IGitService } from "./git.js";

const mutations = new Set<keyof IGitService>([
  "switchBranch",
  "createBranchAndSwitch",
  "stagePaths",
  "unstagePaths",
  "discardPaths",
  "commit",
  "push",
  "createTag",
]);

/** 应用 Git mutation 与 Agent 整轮写入共用 checkout owner，读操作保持可并行。 */
export function coordinateGitCheckoutWrites(
  service: IGitService,
  coordinator: CheckoutCoordinator,
): IGitService {
  return new Proxy(service, {
    get(target, property, receiver) {
      const method = Reflect.get(target, property, receiver);
      if (!mutations.has(property as keyof IGitService) || typeof method !== "function")
        return method;
      return async (params: GitRepositoryRequest) => {
        const lease = await coordinator.acquire({ ...params, ownerId: `git:${randomUUID()}` });
        try {
          return await Reflect.apply(method, target, [params]);
        } finally {
          await coordinator.release(lease);
        }
      };
    },
  });
}
