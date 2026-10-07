export function createBashProviderDescription(input: {
  defaultTimeoutMs: number;
  embeddedSearchEnabled?: boolean;
  maxTimeoutMs: number;
}): string {
  const avoidCommands = input.embeddedSearchEnabled
    ? "`cat`, `head`, `tail`, `sed`, `awk`, or `echo`"
    : "`find`, `grep`, `cat`, `head`, `tail`, `sed`, `awk`, or `echo`";

  return [
    "Executes a bash command and returns its output.",
    "",
    "- Working directory persists between calls, but prefer absolute paths — `cd` in a compound command can trigger a permission prompt. Shell state (env vars, functions) does not persist; the shell is initialized from the user's profile.",
    "- On Windows, Node/package-manager shims can reparse arguments through CMD even when this tool uses Git Bash. Avoid complex `node -e` / `tsx -e` code arguments: quotes, `=>`, and `>` can create unintended files. In Git Bash, use a quoted heredoc to feed `node --input-type=module -` via stdin; under CMD, use a script file. Do not use the Browser/Computer Node REPL for general scripting.",
    `- IMPORTANT: Avoid using this tool to run ${avoidCommands} commands, unless explicitly instructed or after you have verified that a dedicated tool cannot accomplish your task. Instead, use the appropriate dedicated tool as this will provide a much better experience for the user.`,
    `- \`timeout\` is in milliseconds: default ${input.defaultTimeoutMs}, max ${input.maxTimeoutMs}.`,
    "- `run_in_background` runs the command detached. No `&` needed. Finite commands (builds, tests, installs) use `background_kind: task` by default: this turn waits for their real result, then continues so you can finish validation and remaining work. A text reply saying you will wait is not task completion; do not report success before consuming the result.",
    "- For temporary preview/dev/verification servers, set `background_kind: service` and omit `keep_alive_after_task` or set `keep_alive_after_task: false`; they are stopped when this turn ends. Services do not block turn completion. Do not retain a server just to leave a preview link in the final answer.",
    "- Only when the user explicitly asks to keep a server running after task completion, request both `run_in_background: true` and `keep_alive_after_task: true`. This always needs one-time user approval, even in full-access mode. If denied, stop and follow the user's instructions; do not bypass the rejection by silently restarting without retention. An approved retained preview never delays the Git commit-message dialog.",
    "",
    "# Git",
    "- Interactive flags (`-i`, e.g. `git rebase -i`, `git add -i`) are not supported in this environment.",
    "- Use the `gh` CLI for GitHub operations (PRs, issues, API).",
    "- Commit or push only when the user asks. If on the default branch, branch first.",
  ].join("\n");
}
