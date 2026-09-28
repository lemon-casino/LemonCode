export function groupByAssistantStartedRounds<T>(
  items: readonly T[],
  roleOf: (item: T) => string | undefined,
  assistantIdOf?: (item: T) => string | undefined,
): T[][] {
  const groups: T[][] = [];
  let current: T[] = [];
  let lastAssistantId: string | undefined;

  for (const item of items) {
    const role = roleOf(item);
    const assistantId = role === "assistant" ? assistantIdOf?.(item) : undefined;
    const startsNewAssistantRound =
      role === "assistant" &&
      current.length > 0 &&
      (assistantId === undefined || assistantId !== lastAssistantId);

    if (startsNewAssistantRound) {
      groups.push(current);
      current = [item];
    } else {
      current.push(item);
    }

    if (role === "assistant") {
      lastAssistantId = assistantId;
    }
  }

  if (current.length > 0) {
    groups.push(current);
  }

  return groups;
}
