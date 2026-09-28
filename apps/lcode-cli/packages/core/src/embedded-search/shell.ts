import type { ExecutionShellSelection } from "@lcode/contracts";

// provider-visible embedded branch 已默认开启；执行层仅在明确支持 POSIX
// shell function 的 session shell 中注入 find()/grep() alias。
const ENABLE_EMBEDDED_SEARCH_BASH_PRELUDE = true;

export function shouldInjectEmbeddedSearchBashPrelude(): boolean {
  return ENABLE_EMBEDDED_SEARCH_BASH_PRELUDE;
}

export function supportsEmbeddedSearchShellSelection(
  selection: ExecutionShellSelection | undefined,
): boolean {
  return selection?.dialect === "posix" || selection?.dialect === "git-bash";
}
