import { modelList } from "./compatibility.mjs";
import { createCatalogFacts } from "./catalog-facts.mjs";

/** 保留插件原始目录供请求映射，安全展示事实只进入公开结果。 */
export async function discoverCatalog({
  hooks,
  provider,
  scope,
  channel,
  currentGrant,
  check,
  operation,
}) {
  scope.listing = { tried: false, lastOk: false };
  scope.catalogFacts = createCatalogFacts(channel, scope.controller.signal);
  const models = hooks.provider?.models
    ? await hooks.provider.models(provider, { auth: await currentGrant() })
    : provider.models;
  check();
  const fallback =
    models?.[Symbol.for("magpie.fellBack")] === true ||
    (models === provider.models && scope.listing.tried && !scope.listing.lastOk);
  scope.listing = null;
  let list = modelList(provider, models);
  if (scope.catalogFacts) list = scope.catalogFacts.apply(list);
  return {
    discovered: models,
    value:
      operation === "modelCatalog"
        ? { models: list, ...(fallback ? { fallback: true } : {}) }
        : list,
  };
}
