const object = (v) => (v && typeof v === "object" && !Array.isArray(v) ? v : {});
const array = (v) => (Array.isArray(v) ? v.slice(0, 100) : []);
export function count(v, strings = false) {
  if (strings && typeof v === "string" && v.trim() && /^[+-]?\d+(?:\.\d+)?$/.test(v.trim()))
    v = Number(v);
  return typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
}
const ratio = (used, limit) =>
  used !== undefined && limit > 0 ? Math.min(100, (100 * used) / limit) : undefined;
const percent = (v, strings = false) => {
  const n = count(v, strings);
  return n === undefined ? undefined : Math.min(100, n);
};
const quantities = (amount, limit) => ({
  used: ratio(amount, limit),
  amount,
  limit,
  clearDisplay: amount === undefined || limit === undefined,
});
const sum = (values) =>
  values.length && values.every((v) => v !== undefined)
    ? values.reduce((a, b) => a + b, 0)
    : undefined;
function totalOf(values, pick) {
  if (!Array.isArray(values) || !values.length) return;
  let total = 0;
  // 窗口的展示数量上限不能截断计费包合计，否则完整额度会被低估。
  for (const value of values) {
    const n = count(pick(value), true);
    if (n === undefined) return;
    total += n;
  }
  return count(total);
}

export function endpoint(channel, input) {
  let url;
  try {
    url = new URL(input instanceof Request ? input.url : String(input));
  } catch {
    return;
  }
  if (url.protocol !== "https:") return;
  const host = url.hostname,
    path = url.pathname;
  if (
    channel === "factory" &&
    ["api.factory.ai", "api.eu.factory.ai"].includes(host) &&
    path === "/api/billing/limits"
  )
    return "factory";
  if (
    channel === "cline" &&
    host === "api.cline.bot" &&
    path === "/api/v1/users/me/plan/usage-limits"
  )
    return "cline";
  if (channel === "cursor" && host === "api2.cursor.sh") {
    if (path === "/aiserver.v1.DashboardService/GetCurrentPeriodUsage") return "cursor";
    if (path === "/aiserver.v1.DashboardService/GetHardLimit") return "cursor-hard";
  }
  if (
    channel === "grok" &&
    host === "cli-chat-proxy.grok.com" &&
    path === "/v1/billing" &&
    url.searchParams.get("format") === "credits"
  )
    return "grok";
  if (
    channel === "kiro" &&
    /^management\.[a-z]+-[a-z]+-\d+\.kiro\.dev$/.test(host) &&
    path === "/Get-Usage-Limits"
  )
    return "kiro";
  if (
    ["workbuddy", "workbuddy-ai"].includes(channel) &&
    host === (channel === "workbuddy" ? "copilot.tencent.com" : "www.workbuddy.ai") &&
    path === "/billing/meter/get-user-resource-summary"
  )
    return "workbuddy";
  if (
    ["bigmodel", "zai"].includes(channel) &&
    ["open.bigmodel.cn", "bigmodel.cn", "api.z.ai"].includes(host) &&
    path === "/api/monitor/usage/quota/limit"
  )
    return "zcode";
  if (
    channel === "trae-cn" &&
    host === "api.trae.cn" &&
    path === "/trae/api/v2/pay/ide_user_ent_usage"
  )
    return "trae-cn";
  if (
    channel === "trae-global" &&
    ["api-sg-central.trae.ai", "api-us-east.trae.ai"].includes(host) &&
    path === "/trae/api/v1/pay/user_current_entitlement_list"
  )
    return "trae-global";
}

function zcodeWindow(x) {
  const unit = Math.trunc(Number(x.unit) || 0);
  let n = Math.trunc(Number(x.number) || 0);
  if (unit === 3 && n <= 0) n = 5;
  const span = ({ 1: 60, 3: 3600, 4: 86400, 5: 2592000, 6: 604800 }[unit] || 0) * Math.max(n, 1);
  const name =
    String(x.type).toUpperCase() === "TIME_LIMIT"
      ? "MCP · Month"
      : !span
        ? "Credits"
        : span < 86400
          ? `${Math.trunc(span / 3600)} hours`
          : span === 604800
            ? "Weekly"
            : span >= 2419200
              ? "Monthly"
              : `${Math.trunc(span / 86400)} days`;
  const limit = count(x.usage),
    left = count(x.remaining),
    current = count(x.currentValue);
  const amount = limit > 0 && left !== undefined && left <= limit ? limit - left : current;
  const unlimited = limit === 0;
  // 固定插件把缺失值初始化为 0；仅同一额度响应的明确数量/百分比可以恢复该事实。
  const used = unlimited
    ? undefined
    : limit > 0 && left !== undefined && left <= limit
      ? ratio(amount, limit)
      : (percent(x.percentage) ?? ratio(amount, limit));
  return { name, ...quantities(amount, limit), used, unlimited };
}

export function extract(key, raw) {
  raw = object(raw);
  if (key === "factory")
    return ["standard", "core"].flatMap((pool) =>
      [
        ["fiveHour", "5 hours"],
        ["weekly", "7 days"],
        ["monthly", "30 days"],
      ].flatMap(([id, name]) => {
        const window = raw.limits?.[pool]?.[id];
        return window && typeof window === "object"
          ? [
              {
                name: (pool === "core" ? "Droid Core · " : "") + name,
                used: percent(window.usedPercent),
              },
            ]
          : [];
      }),
    );
  if (key === "cline") {
    const data = "success" in raw ? (raw.success === true ? object(raw.data) : {}) : raw;
    const names = { five_hour: "5 hours", weekly: "Weekly", monthly: "Month" };
    return array(data.limits)
      .filter((v) => names[v?.type])
      .map((v) => ({ name: names[v.type], used: percent(v.percentUsed, true) }));
  }
  if (key === "cursor-hard")
    return { limit: count(raw.hardLimit, true), disabled: raw.noUsageBasedAllowed === true };
  if (key === "cursor") {
    const spend = object(raw.spendLimitUsage);
    return {
      windows: [
        ["Cursor Models", "autoPercentUsed"],
        ["Other Models", "apiPercentUsed"],
        ["Total", "totalPercentUsed"],
      ].map(([name, field]) => ({ name, used: percent(raw.planUsage?.[field]) })),
      amount: count(spend.individualUsed, true),
      ownLimit: count(spend.individualLimit, true),
      pooledLimit: count(spend.pooledLimit, true),
      team: spend.limitType === "team",
    };
  }
  if (key === "grok") {
    const cfg = object(raw.config);
    const name =
      { DAILY: "1 day", WEEKLY: "7 days", MONTHLY: "Month" }[
        String(cfg.currentPeriod?.type).replace(/^USAGE_PERIOD_TYPE_/, "")
      ] || "Allowance";
    return [
      { name, used: percent(cfg.creditUsagePercent) },
      { name: "On-demand", used: ratio(count(cfg.onDemandUsed?.val), count(cfg.onDemandCap?.val)) },
    ];
  }
  if (key === "kiro") {
    const out = [];
    for (const v of array(raw.usageBreakdownList)) {
      const trial = v?.freeTrialInfo;
      if (
        String(trial?.freeTrialStatus).toUpperCase() === "ACTIVE" &&
        count(trial.usageLimitWithPrecision) > 0
      )
        out.push(
          quantities(count(trial.currentUsageWithPrecision), count(trial.usageLimitWithPrecision)),
        );
      if (count(v?.usageLimitWithPrecision) > 0)
        out.push(quantities(count(v.currentUsageWithPrecision), count(v.usageLimitWithPrecision)));
    }
    return out.map((v, index) => ({ ...v, index }));
  }
  if (key === "workbuddy") {
    const packages = raw.data?.Packages;
    return [
      {
        name: "Credits",
        ...quantities(
          totalOf(packages, (v) => v?.CycleUsedCapacity),
          totalOf(packages, (v) => v?.CycleTotalCapacity),
        ),
      },
    ];
  }
  if (key === "zcode")
    return array(raw.data?.limits ?? raw.limits).map((v) => zcodeWindow(object(v)));
  if (key === "trae-cn") {
    const packs = raw.user_entitlement_pack_list;
    return [
      {
        name: "Credits",
        ...quantities(
          totalOf(packs, (v) => v?.usage?.credits_amount),
          totalOf(packs, (v) => v?.entitlement_base_info?.quota?.credits_limit),
        ),
      },
    ];
  }
  if (key === "trae-global") {
    const pack = array(raw.user_entitlement_pack_list).find(
      (v) => v?.usage || v?.entitlement_base_info?.quota,
    );
    const q = object(pack?.entitlement_base_info?.quota),
      u = object(pack?.usage);
    return [
      {
        name: "Dollar Usage",
        ...quantities(
          sum([count(u.basic_usage_amount, true), count(u.bonus_usage_amount, true)]),
          sum([count(q.basic_usage_limit, true), count(q.bonus_usage_limit, true)]),
        ),
      },
    ];
  }
  return [];
}

export function patches(observed) {
  const rows = [...observed]
    .filter(([key]) => key !== "cursor" && key !== "cursor-hard")
    .flatMap(([, v]) => v);
  const cursor = observed.get("cursor");
  if (!cursor) return rows;
  rows.push(...cursor.windows);
  const hard = observed.get("cursor-hard");
  const own = cursor.ownLimit;
  const unlimited = cursor.team
    ? own === undefined && (hard ? !hard.disabled && hard.limit > 0 : cursor.pooledLimit > 0)
    : !!hard && !hard.disabled && hard.limit >= 2147483647;
  const limit = unlimited
    ? undefined
    : cursor.team || !hard
      ? own === undefined
        ? undefined
        : own / 100
      : hard.limit;
  const amount = cursor.amount === undefined ? undefined : cursor.amount / 100;
  rows.push({
    name: "On-demand",
    ...quantities(amount, limit),
    unlimited,
    unit: "usd",
    clearDisplay: amount === undefined || (!unlimited && limit === undefined),
  });
  return rows;
}
