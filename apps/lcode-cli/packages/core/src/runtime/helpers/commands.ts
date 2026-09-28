import { RewindScope } from "../deps.js";
import type { MessageId } from "../deps.js";
import type { ParsedRewindCommand } from "../types.js";

export function parseCompactCommand(input: string): string | undefined | null {
  const trimmed = input.trim();
  if (trimmed === "/compact") {
    return undefined;
  }
  if (trimmed.startsWith("/compact ")) {
    const instructions = trimmed.slice("/compact ".length).trim();
    return instructions.length > 0 ? instructions : undefined;
  }
  return null;
}

export function parseRewindCommand(input: string): ParsedRewindCommand | null {
  const trimmed = input.trim();
  if (trimmed === "/fork") {
    return { action: "fork" };
  }
  if (trimmed.startsWith("/fork ")) {
    const args = trimmed.slice("/fork ".length).trim();
    return parseForkCommandArgs(args);
  }
  if (trimmed === "/rewind") {
    return { action: "status" };
  }
  if (!trimmed.startsWith("/rewind ")) {
    return null;
  }

  const args = trimmed.slice("/rewind ".length).trim();
  if (args.length === 0 || args === "status" || args === "help" || args === "-h") {
    return { action: "status" };
  }
  if (args === "fork") {
    return { action: "fork" };
  }
  if (args.startsWith("fork ")) {
    return parseForkCommandArgs(args.slice("fork ".length).trim());
  }
  if (args.startsWith("cascade ")) {
    const cascadeCommand = parseMessageRewindArgs(args.slice("cascade ".length).trim());
    if (cascadeCommand?.action === "message") {
      return {
        ...cascadeCommand,
        action: "cascade-message",
      };
    }
  }
  const messageCommand = parseMessageRewindArgs(args);
  if (messageCommand) {
    return messageCommand;
  }
  if (args === "latest") {
    return { action: "apply" };
  }

  return {
    action: "apply",
    targetCheckpointId: args,
  };
}

function parseMessageRewindArgs(args: string): ParsedRewindCommand | null {
  const parts = args.split(/\s+/).filter(Boolean);
  if (parts.length !== 2) return null;

  const scope = rewindScopeFromCommand(parts[0]!);
  if (!scope) return null;

  return {
    action: "message",
    scope,
    targetMessageId: parts[1]! as MessageId,
  };
}

function rewindScopeFromCommand(value: string): RewindScope | undefined {
  switch (value) {
    case "conversation":
    case "message":
      return RewindScope.Conversation;
    case "code":
    case "workspace":
      return RewindScope.Workspace;
    case "both":
      return RewindScope.Both;
    default:
      return undefined;
  }
}

function parseForkCommandArgs(args: string): ParsedRewindCommand {
  if (args.length === 0 || args === "latest") {
    return { action: "fork" };
  }
  return {
    action: "fork",
    targetCheckpointId: args,
  };
}
