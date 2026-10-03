import { createGitCommandProvider } from "./providers/gitCommandProvider.js";
import type { WorktreeGitPort } from "../worktree/node.js";

/** Git provider is injected across the managed module boundary. */
export function createWorktreeGitPort(): WorktreeGitPort {
  return createGitCommandProvider();
}
