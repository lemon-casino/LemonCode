interface CliCustomCommandContent {
  content: string;
  metadata: {
    name: string;
    scope: string;
    skills?: string[];
    source: string;
  };
}

interface CliCustomCommandExpansion {
  argumentCount: number;
  prompt: string;
  usedArgumentsPlaceholder: boolean;
}

const ALL_ARGUMENTS_TOKEN = "$ARGUMENTS";
const FENCED_SHELL_PATTERN = /```!\s*[\s\S]*?```/;
const INLINE_SHELL_PATTERN = /!`[^`]*`/;
const POSITIONAL_ARGUMENT_PATTERN = /\$(\d+)/g;

export function expandCliCustomCommandPrompt(input: {
  args: string;
  command: CliCustomCommandContent;
}): CliCustomCommandExpansion {
  if (usesUnsupportedDynamicShell(input.command.content)) {
    throw new Error(
      `Custom command /${input.command.metadata.name} uses unsupported shell expansion. Dynamic expansion is not available yet.`,
    );
  }

  const args = input.args.trim();
  const positional = splitCliCustomCommandArguments(args);
  let usedArgumentsPlaceholder = input.command.content.includes(ALL_ARGUMENTS_TOKEN);
  let body = input.command.content.replaceAll(ALL_ARGUMENTS_TOKEN, args);
  body = body.replace(POSITIONAL_ARGUMENT_PATTERN, (_match, index: string) => {
    usedArgumentsPlaceholder = true;
    return positional[Number(index) - 1] ?? "";
  });

  if (args.length > 0 && !usedArgumentsPlaceholder) {
    body = `${body.trimEnd()}\n\nUser arguments:\n${args}`;
  }

  return {
    argumentCount: positional.length,
    prompt: [
      `Run custom command /${input.command.metadata.name}.`,
      `Command source: ${input.command.metadata.scope}/${input.command.metadata.source}.`,
      ...formatCommandSkillInstructions(input.command.metadata.skills ?? []),
      "",
      body.trim(),
    ].join("\n"),
    usedArgumentsPlaceholder,
  };
}

function formatCommandSkillInstructions(skills: string[]): string[] {
  if (skills.length === 0) return [];
  const names = skills.map((skill) => `\`${skill}\``).join(", ");
  return [
    `Required skills: ${names}.`,
    `Before following the command body, call the Skill tool for ${names}.`,
  ];
}

function splitCliCustomCommandArguments(input: string): string[] {
  const args: string[] = [];
  let current = "";
  let escaping = false;
  let quote: "'" | '"' | null = null;

  for (const char of input) {
    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }
    if (char === "\\") {
      escaping = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }
    current += char;
  }

  if (escaping) current += "\\";
  if (current.length > 0) args.push(current);
  return args;
}

function usesUnsupportedDynamicShell(content: string): boolean {
  return INLINE_SHELL_PATTERN.test(content) || FENCED_SHELL_PATTERN.test(content);
}
