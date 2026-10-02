import { Buffer } from "node:buffer";
import type { WorkflowRunState, WorkflowRunsState } from "@lcode/shared/lcode-protocol-v4";

// 只登记 ProductProjection 从唯一 shared reducer 得到的不可变结果；外部 JSON/fixture
// 不能仅凭形状命中缓存。弱键与数字值不保活历史 run、节点、reservation 或订阅。
const projectedWorkflows = new WeakSet<object>();
const workflowBytes = new WeakMap<WorkflowRunsState, number>();
const branchBytes = new WeakMap<object, number>();

export function trackWorkflowProjectionBytes(
  state: WorkflowRunsState,
  previous: WorkflowRunsState | undefined,
): void {
  // 外部 seed/fixture 的旧树即使被 reducer 浅拷贝也不是 owner 构造的不可变 DTO；
  // provenance 断开后继续完整测量，不能把其可变分支递归当成可信缓存。
  if (previous === undefined || projectedWorkflows.has(previous)) projectedWorkflows.add(state);
}

function jsonBytes(value: unknown): number {
  const json = JSON.stringify(value);
  return json === undefined ? 0 : Buffer.byteLength(json, "utf8");
}

function arrayBytes(items: readonly object[]): number {
  const cached = branchBytes.get(items);
  if (cached !== undefined) return cached;
  let bytes = 2 + Math.max(0, items.length - 1);
  for (const item of items) {
    let itemBytes = branchBytes.get(item);
    if (itemBytes === undefined) {
      itemBytes = jsonBytes(item);
      branchBytes.set(item, itemBytes);
    }
    bytes += itemBytes;
  }
  branchBytes.set(items, bytes);
  return bytes;
}

function runBytes(run: WorkflowRunState): number {
  const cached = branchBytes.get(run);
  if (cached !== undefined) return cached;
  // 活动只换一个 node；复用其余纯 DTO 的精确长度，而不是每次为 256 个节点再造 JSON。
  // null 是 4 个 ASCII 字节；只替换测量副本，不改快照、delta 或已预留的帧。
  const bytes =
    jsonBytes({ ...run, actors: null, nodes: null }) +
    arrayBytes(run.actors) +
    arrayBytes(run.nodes) -
    8;
  branchBytes.set(run, bytes);
  return bytes;
}

function projectedBytes(state: WorkflowRunsState): number | undefined {
  const cached = workflowBytes.get(state);
  if (cached !== undefined) return cached;
  // 这些身份字段由 bridge 搬运，不像 node/activity DTO 那样逐字段重建。
  // 非字符串的未知输入仍交给原 JSON 路径，不能缓存用户对象的可变/toJSON 语义。
  if (
    state.runs.some(
      (run) =>
        typeof run.runId !== "string" ||
        (run.toolCallId !== undefined && typeof run.toolCallId !== "string") ||
        run.actors.some(
          (actor) => actor.sessionId !== undefined && typeof actor.sessionId !== "string",
        ),
    )
  )
    return undefined;
  let runsBytes = 2 + Math.max(0, state.runs.length - 1);
  for (const run of state.runs) runsBytes += runBytes(run);
  const bytes = jsonBytes({ ...state, runs: null }) + runsBytes - 4;
  workflowBytes.set(state, bytes);
  return bytes;
}

/** 保留 native JSON 的 key/toJSON/undefined/循环/BigInt 语义，只复用 owner 已登记的子树。 */
export function conversationJsonByteLength(value: unknown): number {
  let replacedBytes = 0;
  const json = JSON.stringify(value, (_key, item: unknown) => {
    if (typeof item !== "object" || item === null || !projectedWorkflows.has(item)) return item;
    const bytes = projectedBytes(item as WorkflowRunsState);
    if (bytes === undefined) return item;
    // 每一次出现都补回，包括一个 state 被多处引用；不是按对象去重后的传输大小。
    replacedBytes += bytes - 4;
    return null;
  });
  return (json === undefined ? 0 : Buffer.byteLength(json, "utf8")) + replacedBytes;
}
