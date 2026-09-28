export function updateErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createRollbackFailure(original: unknown, rollback: unknown): Error {
  const originalMessage = updateErrorMessage(original);
  const rollbackMessage = updateErrorMessage(rollback);
  return new Error(
    `Update failed: ${originalMessage}; rollback pointer restore failed: ${rollbackMessage}`,
    { cause: rollback },
  );
}
