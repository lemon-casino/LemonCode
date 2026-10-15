/** 目录操作独占的促销时间投影；只观察插件实际读取的正文，不克隆/缓存凭据。 */
export function createCatalogFacts(channel, signal, now = Date.now()) {
  if (!["workbuddy", "workbuddy-ai"].includes(channel)) return null;
  const expiry = new Map();
  let closed = false;
  const remember = (body) => {
    if (closed || signal.aborted || body?.code) return;
    expiry.clear();
    for (const p of (Array.isArray(body?.data?.modelPromotions)
      ? body.data.modelPromotions
      : []
    ).slice(0, 2000)) {
      const from = Date.parse(p.schedule?.validFrom ?? ""),
        until = Date.parse(p.schedule?.validUntil ?? "");
      if (
        p.kind !== "discount" ||
        p.enabled === false ||
        !p.discount ||
        from > now ||
        !(until > now) ||
        p.schedule?.daily?.length ||
        !Array.isArray(p.modelIds)
      )
        continue;
      for (const id of p.modelIds.slice(0, 2000)) {
        if (typeof id === "string") expiry.set(id, Math.min(until, expiry.get(id) ?? Infinity));
      }
    }
  };
  return {
    observe(input, response) {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.pathname !== "/v3/config" || !response.ok || closed) return response;
      const decorate = (res) => {
        const json = res.json.bind(res),
          text = res.text.bind(res),
          clone = res.clone.bind(res);
        res.json = async () => {
          const body = await json();
          remember(body);
          return body;
        };
        res.text = async () => {
          const body = await text();
          if (body.length <= 2 * 1024 * 1024)
            try {
              remember(JSON.parse(body));
            } catch {
              /* 原插件报告解析错误。 */
            }
          return body;
        };
        res.clone = () => decorate(clone());
        return res;
      };
      return decorate(response);
    },
    apply(models) {
      closed = true;
      return models.map((model) =>
        model.billing?.kind === "multiplier" && expiry.has(model.id)
          ? {
              ...model,
              billing: {
                ...model.billing,
                validUntil: new Date(expiry.get(model.id)).toISOString(),
              },
            }
          : model,
      );
    },
  };
}
