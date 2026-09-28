// In-process serialization of plugin storage mutations (install/update/uninstall/
// restore). The desktop talks to a single app-server process, so a per-storageRoot
// promise chain is sufficient to prevent interleaved read-modify-write on
// installed_plugins.json / cache dirs / user config. Cross-process locking is a
// non-goal for this iteration.
const chains = new Map<string, Promise<unknown>>();

export async function withPluginStorageLock<T>(
  storageRoot: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(storageRoot) ?? Promise.resolve();
  // Chain regardless of previous outcome; swallow prior errors for the gate only.
  const gate = previous.then(
    () => undefined,
    () => undefined,
  );
  const run = gate.then(() => operation());
  // Keep the chain alive but never let a rejection break future gating.
  chains.set(
    storageRoot,
    run.then(
      () => undefined,
      () => undefined,
    ),
  );
  return run;
}
