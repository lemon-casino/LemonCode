export function gitRevisionFormatCommandIsDangerous(
  _commandText: string,
  args: readonly string[],
): boolean {
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const value = arg.includes("=") ? arg.slice(arg.indexOf("=") + 1) : args[index + 1];
    if (
      (arg === "--format" ||
        arg === "--pretty" ||
        arg.startsWith("--format=") ||
        arg.startsWith("--pretty=")) &&
      value
    ) {
      if (/%[-+ ]?G|%\(\*?signature/.test(value)) return true;
    }
  }
  return false;
}

export function gitReflogCommandIsDangerous(
  _commandText: string,
  args: readonly string[],
): boolean {
  const allowedSubcommands = new Set(["show", "list"]);
  const dangerousSubcommands = new Set(["expire", "delete", "exists", "drop", "write"]);
  const firstPositional = args.find((arg) => arg && !arg.startsWith("-"));
  if (firstPositional && !allowedSubcommands.has(firstPositional)) return true;
  return args.some((arg) => dangerousSubcommands.has(arg));
}

export function gitLsRemoteCommandIsDangerous(
  _commandText: string,
  args: readonly string[],
): boolean {
  let afterDoubleDash = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!afterDoubleDash && arg === "--") {
      afterDoubleDash = true;
      continue;
    }
    if (!afterDoubleDash && (arg.startsWith("-") || !arg)) {
      if (arg === "--sort") index += 1;
      continue;
    }
    return true;
  }
  return false;
}

export function gitRemoteShowCommandIsDangerous(
  _commandText: string,
  args: readonly string[],
): boolean {
  const doubleDashIndex = args.indexOf("--");
  const optionArgs = doubleDashIndex === -1 ? args : args.slice(0, doubleDashIndex);
  const positionalArgs = (doubleDashIndex === -1 ? [] : args.slice(doubleDashIndex + 1)).concat(
    optionArgs.filter((arg) => arg !== "-n"),
  );
  if (!optionArgs.includes("-n")) return true;
  if (positionalArgs.length !== 1) return true;
  return !/^[a-zA-Z0-9_][a-zA-Z0-9_-]*$/.test(positionalArgs[0] ?? "");
}

export function gitTagCommandIsDangerous(_commandText: string, args: readonly string[]): boolean {
  return gitListLikeCommandIsDangerous(
    args,
    new Set([
      "--contains",
      "--no-contains",
      "--merged",
      "--no-merged",
      "--points-at",
      "--sort",
      "--format",
      "-n",
    ]),
  );
}

export function gitBranchCommandIsDangerous(
  _commandText: string,
  args: readonly string[],
): boolean {
  return gitListLikeCommandIsDangerous(
    args,
    new Set(["--contains", "--no-contains", "--points-at", "--sort"]),
  );
}

function gitListLikeCommandIsDangerous(
  args: readonly string[],
  valueFlags: ReadonlySet<string>,
): boolean {
  let hasList = false;
  let afterDoubleDash = false;
  let previousFlag = "";
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg) continue;
    if (arg === "--" && !afterDoubleDash) {
      afterDoubleDash = true;
      previousFlag = "";
      continue;
    }
    if (!afterDoubleDash && arg.startsWith("-")) {
      if (
        arg === "--list" ||
        arg === "-l" ||
        (arg[0] === "-" && arg[1] !== "-" && arg.slice(1).includes("l"))
      )
        hasList = true;
      previousFlag = arg.includes("=") ? arg.slice(0, arg.indexOf("=")) : arg;
      if (!arg.includes("=") && valueFlags.has(previousFlag)) index += 1;
      continue;
    }
    if (!hasList && previousFlag !== "--merged" && previousFlag !== "--no-merged") return true;
  }
  return false;
}
