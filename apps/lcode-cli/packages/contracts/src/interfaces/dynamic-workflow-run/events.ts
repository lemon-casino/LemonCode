/** 事件日志的分页参数；cursor = journal sequence（appendEvent 单调分配）。 */
export interface DynamicWorkflowRunEventPage {
  /** 只取 sequence 严格大于该值的事件；缺省从头取。 */
  afterSequence?: number;
  limit?: number;
}

/**
 * 一条 run 事件的**协议形态**：sequence + 事件种类 + JSON 载荷。
 *
 * 刻意不复用引擎的 `RunEvent`：那是领域包（@lcode/dynamic-workflow）的词汇表，把它
 * import 进 contracts 会让每一个持有端口的层都编译期依赖引擎内部类型。端口只承载
 * JSON 形状，`type` 是不透明字符串，`payload` 由读端按需解释。
 */
export interface DynamicWorkflowRunEvent {
  sequence: number;
  type: string;
  payload: Record<string, unknown>;
  /** 载荷经 {@link boundDynamicWorkflowRunEventPayload} 裁剪过（原始事实仍在 journal）。 */
  truncated?: boolean;
}

/**
 * run 事件载荷的界。**协议边界上的所有载荷有界**，而引擎的事件
 * 里有两个天然无界的字段：`actor-created` 的 `persona.system`（整段 system prompt）与
 * node 级错误的 `finalText`（一整轮模型输出）。它们不该按「大概不会很长」放行。
 *
 * 界是**结构性的**（字符串长度 / 数组条数 / 键数 / 深度）而不是字节总量：结构界可以
 * 逐字段就地施加，不需要先序列化一遍再回退，也不会因为一个巨大字段把其余字段一起丢掉。
 */
export const DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS = {
  maxStringLength: 2_048,
  maxArrayItems: 32,
  maxKeys: 32,
  maxDepth: 6,
} as const;

/**
 * 把一条 run 事件的载荷裁到 {@link DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS} 之内，
 * 并顺带规范成**可 JSON 序列化**的形状。
 *
 * 两个消费者共用这一次序列化：
 *   1. `listEvents` 返回的事件页（详情页的事件日志）；
 *   2. 追加到父会话的 `dynamic_workflow_run_progress` 会话事件（→ `workflowRuns` 投影）。
 *
 * 规范化不是可选的顺带工作，而是必需的：任何非有限数（`Infinity` / `NaN`）经 `JSON.stringify`
 * 都会变成 `null`——那意味着「同一个载荷，落库前后不等」。与其让每个读端各自面对这个不一致，
 * 这里一次性把它折叠成 `null`，使返回值满足 `JSON.parse(JSON.stringify(x)) === x` 的结构等价。
 */
export function boundDynamicWorkflowRunEventPayload(payload: Record<string, unknown>): {
  payload: Record<string, unknown>;
  truncated: boolean;
} {
  let truncated = false;
  const markTruncated = (): void => {
    truncated = true;
  };
  const bounded = boundJsonValue(payload, 0, markTruncated);
  return {
    payload: isJsonRecord(bounded) ? bounded : {},
    truncated,
  };
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 递归裁剪。返回 `undefined` 表示该值不可承载（调用方从对象/数组里省略它）。 */
function boundJsonValue(value: unknown, depth: number, markTruncated: () => void): unknown {
  const limits = DYNAMIC_WORKFLOW_RUN_EVENT_PAYLOAD_LIMITS;

  if (value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    // Infinity / NaN 不是合法 JSON 数字；折叠成 null 而不是让 JSON.stringify 偷偷做这件事。
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    if (value.length <= limits.maxStringLength) return value;
    markTruncated();
    return truncateSurrogateSafe(value, limits.maxStringLength);
  }
  if (typeof value !== "object") {
    // undefined / function / symbol / bigint：省略（bigint 亦不可 JSON 序列化）。
    return undefined;
  }

  if (depth >= limits.maxDepth) {
    markTruncated();
    return undefined;
  }

  if (Array.isArray(value)) {
    const items =
      value.length > limits.maxArrayItems ? value.slice(0, limits.maxArrayItems) : value;
    if (items.length < value.length) markTruncated();
    const out: unknown[] = [];
    for (const item of items) {
      const boundedItem = boundJsonValue(item, depth + 1, markTruncated);
      // 数组里的空洞会改变下标语义，所以不可承载的元素落成 null 而不是被跳过。
      out.push(boundedItem === undefined ? null : boundedItem);
    }
    return out;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  const kept = entries.length > limits.maxKeys ? entries.slice(0, limits.maxKeys) : entries;
  if (kept.length < entries.length) markTruncated();
  const out: Record<string, unknown> = {};
  for (const [key, item] of kept) {
    const boundedItem = boundJsonValue(item, depth + 1, markTruncated);
    if (boundedItem !== undefined) out[key] = boundedItem;
  }
  return out;
}

/**
 * 按 UTF-16 码元截断，但绝不留下孤立代理项（lone surrogate）——那既不是合法文本，
 * 也会让下游 JSON 编解码在某些运行时上报错。落在代理对中间时宁可少一个码元。
 */
function truncateSurrogateSafe(value: string, maxLength: number): string {
  const cut = value.slice(0, maxLength);
  const lastCode = cut.charCodeAt(cut.length - 1);
  const isHighSurrogate = lastCode >= 0xd800 && lastCode <= 0xdbff;
  return isHighSurrogate ? cut.slice(0, -1) : cut;
}
