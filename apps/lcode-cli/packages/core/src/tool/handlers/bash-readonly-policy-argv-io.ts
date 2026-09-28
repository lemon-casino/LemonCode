import type { BashCommandInvocation } from "./bash-command-parser.js";

const SAFE_ENV_ASSIGNMENTS = new Set([
  "ANTHROPIC_API_KEY",
  "BLOCK_SIZE",
  "BLOCKSIZE",
  "CGO_ENABLED",
  "CHARSET",
  "CI",
  "CLICOLOR",
  "CLICOLOR_FORCE",
  "COLORTERM",
  "COLUMNS",
  "DEBIAN_FRONTEND",
  "FORCE_COLOR",
  "GCC_COLORS",
  "GIT_TERMINAL_PROMPT",
  "GO111MODULE",
  "GOARCH",
  "GOEXPERIMENT",
  "GOOS",
  "GREP_COLOR",
  "GREP_COLORS",
  "LANG",
  "LANGUAGE",
  "LC_ALL",
  "LC_CTYPE",
  "LC_TIME",
  "LINES",
  "LSCOLORS",
  "LS_COLORS",
  "NO_COLOR",
  "NODE_ENV",
  "PYTEST_DEBUG",
  "PYTEST_DISABLE_PLUGIN_AUTOLOAD",
  "PYTHONDONTWRITEBYTECODE",
  "PYTHONUNBUFFERED",
  "RUST_BACKTRACE",
  "RUST_LOG",
  "TERM",
  "TIME_STYLE",
  "TZ",
]);

export function areEnvAssignmentsAllowed(commandPart: BashCommandInvocation): boolean {
  return commandPart.envAssignments.every((assignment) => {
    return assignment.name !== undefined && SAFE_ENV_ASSIGNMENTS.has(assignment.name);
  });
}

const SAFE_INPUT_REDIRECTS = new Set(["<", "<<", "<&", "<<<"]);

export function areRedirectsAllowed(commandPart: BashCommandInvocation): boolean {
  for (const redirect of commandPart.redirects) {
    if (isUnsafeDeviceRedirectTarget(redirect.target)) return false;
    if (redirect.operator === ">&" && /^\d+$/.test(redirect.target)) continue;
    if (redirect.target === "/dev/null") continue;
    if (SAFE_INPUT_REDIRECTS.has(redirect.operator)) {
      if (isUnsafeWindowsUncPath(redirect.target)) return false;
      continue;
    }
    return false;
  }
  return true;
}

function isUnsafeDeviceRedirectTarget(target: string): boolean {
  return /^\/dev\/(?:tcp|udp)\//.test(target);
}

export function isUnsafeWindowsUncPath(value: string): boolean {
  return /^(?:\/\/|\\\\)[^/\\]/.test(value);
}

export function stripSafeCommandWrappers(argv: readonly string[]): readonly string[] {
  let stripped = [...argv];
  for (;;) {
    if (stripped[0] === "command") {
      let index = 1;
      while (stripped[index] !== undefined && /^-p+$/.test(stripped[index] ?? "")) index += 1;
      if (stripped[index] === "--") index += 1;
      if (index >= stripped.length || stripped[index]?.startsWith("-")) return stripped;
      stripped = stripped.slice(index);
      continue;
    }
    if (stripped[0] === "builtin") {
      const index = stripped[1] === "--" ? 2 : 1;
      if (index >= stripped.length) return stripped;
      stripped = stripped.slice(index);
      continue;
    }
    if (stripped[0] === "noglob") {
      if (stripped.length <= 1) return stripped;
      stripped = stripped.slice(1);
      continue;
    }
    return stripped;
  }
}
