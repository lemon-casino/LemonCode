import type { Message } from "./app-model.js";

const ERROR_MESSAGE_PREFIX = "Error:";
const UNKNOWN_ERROR_MESSAGE = "Unknown error";

export function appendSystemErrorMessage(messages: Message[], message: string): Message[] {
  const content = formatSystemErrorMessage(message);
  const last = messages.at(-1);
  // runtime error events often arrive before the rejected prompt promise;
  // dedupe the catch-path render so the transcript shows one clear failure.
  if (last?.role === "system" && last.content === content) return messages;
  return [...messages, { content, role: "system" }];
}

function formatSystemErrorMessage(message: string): string {
  const trimmed = message.trim() || UNKNOWN_ERROR_MESSAGE;
  return trimmed.startsWith(ERROR_MESSAGE_PREFIX) ? trimmed : `${ERROR_MESSAGE_PREFIX} ${trimmed}`;
}
