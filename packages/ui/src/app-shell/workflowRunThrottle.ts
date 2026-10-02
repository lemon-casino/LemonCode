/**
 * workflow run 详情页的自适应并发观察面：
 * run 头的并发/冷却读数，以及事件日志里 `node-waiting` / `node-executing` / `concurrency-changed` 三条
 * 事件的行。子代理徽标**不在**这里：它只有三态一个词，直接由协议 actor 状态渲染。
 *
 * 与 workflowRunPanel.ts 同族的纯规则（拆出来是为了守住 max-lines 门），加一件事：**收到时刻
 * 登记**。协议只带相对量（`cooldownMs`——引擎无时钟），deadline 只能由 UI 按
 * "第一次见到这份状态的时刻"推。登记按对象身份（WeakMap）：归约对未变的 `concurrency` 保留同一对象
 * 引用，一被新事件替换就是新对象、重新登记。不放进协议，是因为它是本地观察，不是引擎事实。
 */
import type { WorkflowRunConcurrency } from "@lcode/shared/lcode-protocol-v4";
import type { WorkflowRunEventItem, WorkflowRunEventLine } from "./workflowRunPanel.js";

const MS_PER_SECOND = 1_000;
const I18N_PREFIX = "chat.toolCall.workflow.run.";
const EVENT_KEY_PREFIX = `${I18N_PREFIX}event.`;

type FormatMessage = (descriptor: { id: string }, values?: Record<string, string>) => string;

/**
 * 等待原因 → 短标签的 i18n 键；断流、网络与服务错误要可区分。
 * 未知 provider 文本可能携带请求信息，只显示归一化通用原因，不透传原始错误。
 */
const REASON_LABEL_KEY: Readonly<Record<string, string>> = {
  rate_limited: "throttle.reason.rateLimited",
  provider_overloaded: "throttle.reason.overloaded",
  offpeak_queued: "throttle.reason.offpeak",
  server_error: "throttle.reason.server",
  network_error: "throttle.reason.network",
  timeout: "throttle.reason.timeout",
  stream_idle_timeout: "throttle.reason.stream",
  stale_connection: "throttle.reason.staleConnection",
  proxy_error: "throttle.reason.proxy",
};

export function throttleReasonLabel(reason: string, formatMessage: FormatMessage): string {
  const key = REASON_LABEL_KEY[reason];
  return formatMessage({ id: `${I18N_PREFIX}${key ?? "throttle.reason.transient"}` });
}

// ── 收到时刻登记 ──

const concurrencyReceivedAt = new WeakMap<WorkflowRunConcurrency, number>();

function stamp<T extends object>(registry: WeakMap<T, number>, subject: T, now: number): number {
  const seen = registry.get(subject);
  if (seen !== undefined) return seen;
  registry.set(subject, now);
  return now;
}

// ── run 头 ──

interface WorkflowRunConcurrencyView {
  /**
   * 芯片上那个数：**实际**并发 `min(cap, limit)`——共享桶的 cap 与本 run 自己的 limit 取小。用户看到的是这次 run
   * 此刻真能有几个子代理在飞，两条界里哪一条在起作用不是读数要回答的问题。
   */
  cap: number;
  ceiling: number;
  /** 冷却 deadline（epoch ms）；无冷却或已过期时缺席。 */
  cooldownUntil?: number;
}

/**
 * run 头的并发读数。只在**实际并发 < ceiling** 时在场：跑在天花板上的 run 没有可说的。
 * 冷却按收到时刻 + `cooldownMs` 推 deadline，过期即缺席——UI 不显示一个已经过去的时间。
 */
export function workflowRunConcurrencyView(
  concurrency: WorkflowRunConcurrency | undefined,
  now: number,
): WorkflowRunConcurrencyView | undefined {
  if (concurrency === undefined) return undefined;
  const effective = Math.min(concurrency.cap, concurrency.limit ?? concurrency.cap);
  if (effective >= concurrency.ceiling) return undefined;
  const view: WorkflowRunConcurrencyView = { cap: effective, ceiling: concurrency.ceiling };
  if (concurrency.cooldownMs !== undefined) {
    const until = stamp(concurrencyReceivedAt, concurrency, now) + concurrency.cooldownMs;
    if (until > now) view.cooldownUntil = until;
  }
  return view;
}

// ── 事件日志 ──

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function refText(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const { siteId, ordinal } = value;
  if (typeof siteId !== "string" || siteId.length === 0) return undefined;
  return typeof ordinal === "number" ? `${siteId}@${ordinal}` : siteId;
}

/**
 * 三条自适应并发事件（node-waiting / node-executing / concurrency-changed）→ 事件日志行；其余种类
 * 返回 undefined（交回主表的 default 兜底）。与 workflowRunEventLines 的其余分支同一条纪律：载荷
 * 防御性读取，一条读不动的事件绝不打挂整页。全部 tone default：等待不是失败，cap 变化也不是——
 * 它们是运行时在自我调节。
 */
export function workflowRunConcurrencyEventLine(
  event: WorkflowRunEventItem,
  formatMessage: FormatMessage,
): WorkflowRunEventLine | undefined {
  const { payload } = event;
  const base = {
    sequence: event.sequence,
    type: event.type,
    ...(event.truncated ? { truncated: event.truncated as true } : {}),
    tone: "default" as const,
  };
  const withDetail = (label: string, detail: string | undefined): WorkflowRunEventLine => ({
    ...base,
    label,
    ...(detail === undefined ? {} : { detail }),
  });
  switch (event.type) {
    case "node-admission": {
      // 调度等待与 provider slot 分属不同所有者；只有明确 cause 才显示具体队列原因。
      const kind = payload.cause === "actor-fifo" || payload.cause === "run-capacity"
        ? payload.cause
        : payload.cause === null ? "dispatched" : "queued";
      return withDetail(
        formatMessage({ id: `chat.toolCall.workflow.activity.${kind}` }),
        refText(payload.instance),
      );
    }
    // node-waiting：cause=slot 是在闸门前排队，没有别的可说；cause=backoff 带 runner 的
    // 退避原因与时长——徽标不显示这些细节，事件日志是它们唯一的落点。
    case "node-waiting": {
      if (payload.cause !== "backoff") {
        return withDetail(
          formatMessage({ id: `${EVENT_KEY_PREFIX}nodeWaitingSlot` }),
          refText(payload.instance),
        );
      }
      const reason =
        typeof payload.reason === "string"
          ? throttleReasonLabel(payload.reason, formatMessage)
          : "?";
      const seconds =
        typeof payload.delayMs === "number"
          ? String(Math.ceil(payload.delayMs / MS_PER_SECOND))
          : "?";
      return withDetail(
        formatMessage({ id: `${EVENT_KEY_PREFIX}nodeWaitingBackoff` }, { reason, seconds }),
        refText(payload.instance),
      );
    }
    case "node-executing":
      return withDetail(
        formatMessage({ id: `${EVENT_KEY_PREFIX}nodeExecuting` }),
        refText(payload.instance),
      );
    case "concurrency-changed": {
      const previous = typeof payload.previous === "number" ? String(payload.previous) : "?";
      const next = typeof payload.next === "number" ? String(payload.next) : "?";
      const key =
        typeof payload.key === "string" && payload.key.length > 0 ? payload.key : undefined;
      return withDetail(
        formatMessage({ id: `${EVENT_KEY_PREFIX}concurrencyChanged` }, { previous, next }),
        key,
      );
    }
    default:
      return undefined;
  }
}
