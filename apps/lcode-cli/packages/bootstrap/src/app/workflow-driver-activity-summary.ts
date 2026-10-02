import type {
  ModelNetworkStatusEvent,
  ModelStreamingPayload,
  SessionEvent,
} from "@lcode/contracts";
import type { AskActivity, InstanceRef } from "@lcode/dynamic-workflow";
import type { WorkflowClock } from "./workflow-driver-concurrency.js";
import type { ActorToolObservation } from "./workflow-driver-tool-activity.js";
import { createActivityEmitter } from "./workflow-driver-activity-emitter.js";
import { activitySourceTime } from "./workflow-driver-activity-scope.js";

const REQUEST_ID_MAX_CHARS = 256;
const RECENT_REQUESTS_MAX = 256;
const PRIMARY_QUERY_SOURCES: ReadonlySet<string> = new Set([
  "workflow_child",
  "subagent",
  "main_turn",
]);

type RequestPhase = "queued" | "admitted" | "started" | "failed" | "backoff" | "completed";
interface RequestActivity {
  id: string;
  chain: string;
  phase: RequestPhase;
  started: boolean;
  primary: boolean;
  since: number;
  observedAt: number;
  kind: "model" | "text" | "reasoning";
  order: number;
}
interface ToolActivity {
  name?: string;
  since: number;
  order: number;
}
export interface RequestObservation {
  /** 旧物理请求完成可补成功计数，但不能结束同链的新请求或改变其等待相位。 */
  current: boolean;
  completed: boolean;
}

export function activityRequestChain(status: ModelNetworkStatusEvent): string {
  const parts = [status.querySource, status.queryId, status.toolCallId].map((part) => part ?? "");
  return parts.some((part) => part.length > 0) ? JSON.stringify(parts) : status.requestId;
}

/** 请求与工具的在飞集合只服务于观察摘要；副作用/世界触碰计数仍从 toolActivity 读取。 */
export function createAskActivitySummary(input: {
  live: () => InstanceRef | undefined;
  instance: () => InstanceRef | undefined;
  toolCalls: () => number;
  clock?: WorkflowClock;
  emit: (instance: InstanceRef, activity: AskActivity) => void;
}) {
  const emitter = createActivityEmitter(input);
  const requests = new Map<string, RequestActivity>();
  const latestByChain = new Map<string, RequestActivity>();
  const tools = new Map<string, ToolActivity>();
  const recent = new Set<string>();
  let requestsCompleted = 0;
  let lastRequestCompletedAt: number | undefined;
  let last: AskActivity | undefined;
  let selection: string | undefined;
  let order = 0;

  const isActive = (request: RequestActivity) =>
    request.phase === "started" && latestByChain.get(request.chain) === request;
  const publish = (sourceTime: number, immediate = false) => {
    const instance = input.instance();
    if (instance === undefined) return;
    let activeTool: [string, ToolActivity] | undefined;
    for (const entry of tools) {
      if (activeTool === undefined || entry[1].order > activeTool[1].order) activeTool = entry;
    }
    let request: RequestActivity | undefined;
    for (const candidate of requests.values()) {
      if (isActive(candidate) && (request === undefined || candidate.order > request.order))
        request = candidate;
    }
    const kind = activeTool !== undefined ? "tool" : (request?.kind ?? "unknown");
    const key =
      activeTool !== undefined
        ? `tool:${activeTool[0]}`
        : request === undefined
          ? "unknown"
          : `request:${request.id}:${kind}`;
    const observedAt = Math.max(sourceTime, last?.observedAt ?? sourceTime);
    const since =
      key === selection && last !== undefined
        ? last.since
        : (activeTool?.[1].since ?? request?.since ?? observedAt);
    const activity: AskActivity = {
      kind,
      observedAt,
      since,
      requestsCompleted,
      toolCalls: input.toolCalls(),
      ...(activeTool?.[1].name === undefined ? {} : { toolName: activeTool[1].name }),
      ...(activeTool !== undefined || request === undefined
        ? {}
        : { requestId: request.id.slice(0, REQUEST_ID_MAX_CHARS) }),
      ...(lastRequestCompletedAt === undefined ? {} : { lastRequestCompletedAt }),
    };
    const changed = key !== selection || last?.kind !== kind;
    selection = key;
    last = activity;
    emitter.offer(instance, activity, immediate || changed);
  };

  const retainRecent = (request: RequestActivity) => {
    recent.delete(request.id);
    recent.add(request.id);
    // 只保留有界终结/被替换历史；当前在飞请求不驱逐，否则并发分支完成会漏计。
    while (recent.size > RECENT_REQUESTS_MAX) {
      const id = recent.values().next().value;
      if (id === undefined) break;
      recent.delete(id);
      const ended = requests.get(id);
      requests.delete(id);
      if (ended !== undefined && latestByChain.get(ended.chain) === ended)
        latestByChain.delete(ended.chain);
    }
  };
  const resetTurn = () => {
    requests.clear();
    latestByChain.clear();
    tools.clear();
    recent.clear();
  };
  return {
    reset() {
      emitter.reset();
      resetTurn();
      requestsCompleted = 0;
      lastRequestCompletedAt = undefined;
      last = undefined;
      selection = undefined;
      order = 0;
    },
    beginTurn() {
      emitter.clear();
      resetTurn();
    },
    endTurn() {
      emitter.flush();
      resetTurn();
    },
    suspend() {
      emitter.clear();
      resetTurn();
    },
    finish(at: number | undefined) {
      resetTurn();
      if (at !== undefined) publish(at, true);
      else emitter.flush();
    },
    flush: () => emitter.flush(),
    network(status: ModelNetworkStatusEvent): RequestObservation | undefined {
      if (status.type === "model_stream_stalled" || status.type.startsWith("model_first_"))
        return undefined;
      const at = activitySourceTime(status.timestamp);
      if (at === undefined || !status.requestId) return undefined;
      const chain = activityRequestChain(status);
      let request = requests.get(status.requestId);
      const latest = latestByChain.get(chain);
      const starts =
        status.type === "model_request_started" ||
        status.type === "model_request_admitted" ||
        status.type === "model_request_queued";
      if (request === undefined) {
        // 完成必须有本 ask 观察到的起点；旧请求不能凭迟到的 completed/failed 创建活动。
        if (!starts || (latest !== undefined && at < latest.observedAt)) return undefined;
        request = {
          id: status.requestId,
          chain,
          phase: "queued",
          started: false,
          primary:
            status.toolCallId === undefined && PRIMARY_QUERY_SOURCES.has(status.querySource ?? ""),
          since: at,
          observedAt: at,
          kind: "model",
          order: ++order,
        };
        requests.set(request.id, request);
        latestByChain.set(chain, request);
        // 同链换了物理请求后，旧项只留作有界迟到成功关联，不能再成为当前活动候选。
        if (latest !== undefined) retainRecent(latest);
      } else if (
        request.chain !== chain ||
        // runner 的 started 时间在 admission 前取；同请求的合法启动按事件相位认领，不能按晚到的 admitted 时间丢弃。
        (at < request.observedAt &&
          !(
            status.type === "model_request_started" &&
            !request.started &&
            (request.phase === "queued" || request.phase === "admitted")
          )) ||
        request.phase === "completed"
      ) {
        return undefined;
      }
      const current = latestByChain.get(chain) === request;
      // 旧请求的终结仍须移出在飞集合，但不能改新请求的等待/执行链；否则新请求结束后旧请求会复活。
      if (
        !current &&
        status.type !== "model_request_completed" &&
        status.type !== "model_request_failed" &&
        status.type !== "model_retry_scheduled"
      )
        return undefined;
      let completed = false;
      switch (status.type) {
        case "model_request_queued":
          if (request.started || request.phase !== "queued") return undefined;
          break;
        case "model_request_admitted":
          if (request.started || request.phase !== "queued") return undefined;
          request.phase = "admitted";
          break;
        case "model_request_started":
          if (request.started || (request.phase !== "queued" && request.phase !== "admitted"))
            return undefined;
          request.started = true;
          request.phase = "started";
          request.since = at;
          request.order = ++order;
          break;
        case "model_request_completed":
          if (request.phase === "failed" || request.phase === "backoff") return undefined;
          completed = request.started;
          request.phase = "completed";
          if (completed) {
            requestsCompleted++;
            lastRequestCompletedAt = Math.max(lastRequestCompletedAt ?? at, at);
          }
          break;
        case "model_request_failed":
          if (request.phase === "failed" || request.phase === "backoff") return undefined;
          request.phase = "failed";
          break;
        case "model_retry_scheduled":
          if (request.phase === "backoff") return undefined;
          request.phase = "backoff";
          break;
        default:
          return undefined;
      }
      request.observedAt = at;
      if (
        request.phase === "completed" ||
        request.phase === "failed" ||
        request.phase === "backoff"
      )
        retainRecent(request);
      if (status.type !== "model_request_queued" && status.type !== "model_request_admitted")
        publish(at, true);
      else emitter.flush();
      return { current, completed };
    },
    stream(event: SessionEvent) {
      const payload = event.payload as ModelStreamingPayload;
      if (!payload.delta || (payload.kind !== "text_delta" && payload.kind !== "reasoning_delta"))
        return;
      const at = activitySourceTime(event.timestamp);
      if (at === undefined) return;
      const primary = [...requests.values()].filter(
        (request) => request.primary && isActive(request),
      );
      // ModelStreaming 没有 requestId；多主请求重叠时不能猜归属，更不能把 sidecar 当作思考输出。
      if (primary.length !== 1) return;
      const request = primary[0]!;
      if (at < request.observedAt || latestByChain.get(request.chain) !== request) return;
      const kind = payload.kind === "reasoning_delta" ? "reasoning" : "text";
      if (kind !== request.kind) request.since = at;
      request.kind = kind;
      request.observedAt = at;
      publish(at);
    },
    tool(observation: ActorToolObservation) {
      const at = activitySourceTime(observation.timestamp);
      if (at === undefined) return;
      if (observation.phase === "started") {
        tools.set(observation.toolCallId, {
          name: observation.toolName,
          since: at,
          order: ++order,
        });
      } else {
        const tool = tools.get(observation.toolCallId);
        if (tool === undefined || at < tool.since) return;
        if (observation.phase === "completed") tools.delete(observation.toolCallId);
      }
      publish(at, observation.phase !== "progress");
    },
  };
}
