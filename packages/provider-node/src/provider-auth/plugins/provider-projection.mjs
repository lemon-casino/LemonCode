/** 原 worker 的 listing 投影；缓存仍只由调用方持有。 */
export async function buildPluginProvider(hooks) {
  const config = { provider: {} };
  await hooks.config?.(config);
  const source = config.provider[hooks.auth.provider];
  if (!source) throw new Error("Plugin gave no provider configuration");
  return {
    ...source,
    id: hooks.auth.provider,
    models: Object.fromEntries(
      Object.entries(source.models ?? {}).map(([id, m]) => [
        id,
        { ...m, id, providerID: hooks.auth.provider },
      ]),
    ),
  };
}
