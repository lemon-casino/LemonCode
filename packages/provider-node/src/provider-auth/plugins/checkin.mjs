const endpoints = {
  workbuddy: "https://copilot.tencent.com/v2/billing/meter",
  "trae-cn": "https://api.trae.cn/trae/api/v2/ug/checkin_credits",
  "minimax-code": "https://agent.minimax.cn/minimax-cloud/api/v1/signin",
  "minimax-code-global": "https://agent.minimax.io/minimax-cloud/api/v1/signin",
  qoder: "https://openapi.qoder.sh/sash/api/v1/me/campaigns",
  "qoder-cn": "https://openapi.qoder.com.cn/sash/api/v1/me/campaigns",
};
const number = (v) => {
  const n = typeof v === "string" && /^\d+(?:\.\d+)?$/.test(v) ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
};
const reward = (credit, streak) => ({
  ...(number(credit) !== undefined ? { credit: number(credit) } : {}),
  ...(Number.isSafeInteger(number(streak)) ? { streak: number(streak) } : {}),
});
const failure = (error = "request_failed") => ({ outcome: "failed", error });

/** 只暴露有限签到动作；厂商请求仍经过原 loader 的鉴权、代理、刷新和取消。 */
export async function checkinWithLoader(
  channel,
  loader,
  signal,
  { signMiniMax, now = Date.now() } = {},
) {
  signal.throwIfAborted();
  const base = endpoints[channel];
  if (!base || typeof loader?.fetch !== "function") return { outcome: "unsupported" };
  const ask = async (path, method = "POST", headers = {}, origin = base) => {
    signal.throwIfAborted();
    const request = new Request(origin + path, {
      method,
      signal,
      headers: { accept: "application/json", "content-type": "application/json", ...headers },
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    // MiniMax loader 会把 Request 的空正文转成 ""；GET 必须用 URL + init，避免非法 GET body。
    const response = await loader.fetch(request.url, {
      method,
      headers: request.headers,
      signal,
      ...(method === "POST" ? { body: "{}" } : {}),
    });
    // 厂商错误页也受相同上限约束，不能先无界读完再检查长度。
    let text = "";
    if (response.body) {
      const reader = response.body.getReader(),
        decoder = new TextDecoder();
      let bytes = 0;
      try {
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          bytes += chunk.value.byteLength;
          if (bytes > 1024 * 1024) {
            await reader.cancel();
            text = "";
            break;
          }
          text += decoder.decode(chunk.value, { stream: true });
        }
      } finally {
        reader.releaseLock();
      }
    }
    signal.throwIfAborted();
    let data;
    if (text.length <= 1024 * 1024)
      try {
        data = JSON.parse(text);
      } catch {
        /* 原生应用可返回 HTML 拒绝。 */
      }
    return { response, data };
  };
  const refused = ({ response, data }) => {
    if (response.headers.get("x-magpie-sign-in") === "expired" || response.status === 401)
      return failure("sign_in_required");
    if (response.status === 403 && /captcha|验证码/i.test(JSON.stringify(data ?? {})))
      return { outcome: "captcha" };
    if (
      channel.startsWith("qoder") &&
      response.status === 502 &&
      /device identity runtime not found/.test(String(data?.error?.message ?? ""))
    )
      return failure("dependency_required");
    return !response.ok ? failure() : undefined;
  };
  if (channel === "workbuddy") {
    const check = async (answer) => {
      if (answer.response.status === 401) {
        // 账号额度仍能读取时，401 仅表示签到需要原生应用，不能清空登录或反复领取。
        const quota = await ask(
          "/billing/meter/get-user-resource-summary",
          "POST",
          {},
          "https://copilot.tencent.com",
        );
        if (quota.response.ok && quota.data && Number(quota.data.code ?? 0) === 0)
          return { outcome: "own-app" };
      }
      const code = Number(answer.data?.code ?? 0);
      if (code === 1001) return { outcome: "done" };
      if (code === 1002) return { outcome: "ineligible" };
      if (code === 1003) return { outcome: "inactive" };
      return refused(answer) ?? (code ? failure() : undefined);
    };
    const status = await ask("/checkin-activity-status");
    const error = await check(status);
    if (error) return error;
    const data = status.data?.data;
    if (typeof data?.active !== "boolean") return failure();
    if (!data.active) return { outcome: "inactive" };
    if (data.today_checked_in)
      return { outcome: "done", ...reward(data.today_credit, data.streak_days) };
    const claim = await ask("/daily-checkin");
    const rejected = await check(claim);
    if (rejected) return rejected;
    return claim.data?.code === 0 &&
      claim.data?.data &&
      (number(claim.data.data.credit) !== undefined || claim.data.data.credit_delayed === true)
      ? { outcome: "claimed", ...reward(claim.data.data.credit, claim.data.data.streak_days) }
      : failure();
  }
  if (channel === "trae-cn") {
    const check = (answer, claiming = false) => {
      const code = Number(answer.data?.code ?? 0);
      if (code === 9074 && claiming) return { outcome: "own-app" };
      if (code === 9095) return { outcome: "ineligible" };
      if (code === 1001) return failure("sign_in_required");
      return refused(answer) ?? (code ? failure() : undefined);
    };
    const status = await ask("/status");
    const error = check(status);
    if (error) return error;
    if (typeof status.data?.enable !== "boolean") return failure();
    if (!status.data.enable) return { outcome: "inactive" };
    if (status.data.checked_in) return { outcome: "done", ...reward(status.data.credits) };
    const claim = await ask("/claim");
    const rejected = check(claim, true);
    if (rejected) return rejected;
    if (claim.data?.code !== 0) return failure();
    const credit = number(claim.data.credits) ?? number(status.data.credits);
    return {
      outcome: "claimed",
      ...reward(
        credit === undefined ? undefined : credit + (number(claim.data.extra_credits) ?? 0),
      ),
    };
  }
  if (channel.startsWith("minimax")) {
    if (!signMiniMax) return failure();
    const status = await ask(
      "/status?timezone_id=Asia%2FShanghai",
      "GET",
      signMiniMax(channel, "GET", now),
    );
    const error = refused(status);
    if (error) return error;
    if (Number(status.data?.base_resp?.status_code ?? 0)) return failure();
    const days = status.data?.data?.days;
    if (!Array.isArray(days)) return failure();
    const today = days.find((d) => d.is_today === true);
    if (!today) return { outcome: "inactive" };
    if (today.status === 3) return { outcome: "done", ...reward(today.points, today.day_no) };
    if (today.status === 4) return { outcome: "ineligible" };
    if (today.status !== 2) return { outcome: "inactive" };
    const claim = await ask(
      "/claim?timezone_id=Asia%2FShanghai",
      "POST",
      signMiniMax(channel, "POST", now),
    );
    const rejected = refused(claim);
    if (rejected) return rejected;
    if (Number(claim.data?.base_resp?.status_code ?? 0)) return failure();
    const data = claim.data?.data;
    if (![1, 2].includes(data?.claim_result)) return failure();
    return {
      outcome: data.claim_result === 1 ? "claimed" : "done",
      ...reward(data.points ?? today.points, data.day_no ?? today.day_no),
    };
  }
  const status = await ask("", "GET");
  const error = refused(status);
  if (error) return error;
  if (!Array.isArray(status.data?.campaigns)) return failure();
  const campaigns = status.data.campaigns.filter((c) => c.actionType === "CLAIM_BENEFIT");
  let credit = 0,
    claims = 0,
    failed = 0;
  const when = (n) =>
    number(n) === undefined ? undefined : number(n) > 1e12 ? number(n) : number(n) * 1000;
  const active = (c) =>
    when(c.startAt) !== undefined && when(c.endAt) > now && when(c.startAt) <= now;
  const ends = campaigns.filter(active).map((c) => when(c.endAt));
  const expiry = ends.length ? { validUntil: new Date(Math.min(...ends)).toISOString() } : {};
  for (const campaign of campaigns) {
    // CLAIMABLE 是服务端权威；不能仅凭本地午夜或客户端时间猜测可领取。
    if (campaign.claimStatus !== "CLAIMABLE" || !campaign.campaignId) continue;
    const claim = await ask(`/${encodeURIComponent(campaign.campaignId)}/claim`);
    const data = claim.data?.data ?? claim.data;
    if (refused(claim) || data?.status !== "CLAIMED") {
      failed++;
      continue;
    }
    claims++;
    credit += number(data.benefit?.amount) ?? number(campaign.benefit?.amount) ?? 0;
  }
  if (failed) return { ...failure("partial"), ...(claims ? { credit } : {}), ...expiry };
  if (claims) return { outcome: "claimed", credit, ...expiry };
  if (!campaigns.length) return { outcome: "inactive" };
  const done = campaigns.find((c) => c.claimStatus === "CLAIMED" && active(c));
  return done ? { outcome: "done", ...reward(done.benefit?.amount), ...expiry } : failure();
}
