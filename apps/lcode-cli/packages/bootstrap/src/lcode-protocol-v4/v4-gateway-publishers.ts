import type { MessageWithParts } from "@lcode/contracts";
import { ConversationTopicPublisher } from "./conversation-topic-publisher.js";
import type { SessionUsageSeed } from "./product-projection.js";
import { type V4GatewayState } from "./v4-gateway-state.js";

export function ensurePublisher(
  gateway: Pick<V4GatewayState, "createLogEpoch" | "host" | "now" | "publishers">,
  sessionId: string,
): ConversationTopicPublisher {
  let publisher = gateway.publishers.get(sessionId);
  if (!publisher) {
    publisher = new ConversationTopicPublisher(sessionId, gateway.createLogEpoch(sessionId), {
      now: gateway.now,
    });
    gateway.publishers.set(sessionId, publisher);
    // config 种子：创建即注入 runtime 真值（不产 delta / 不 bump revision）。
    seedPublisherConfig(gateway, sessionId, publisher);
  }
  return publisher;
}

/**
 * config 种子注入（防御式：种子失败不打断 conversation 主路径）。
 * 幂等且事件优先（seedConfig 跳过事件触碰过的字段），故在 publisher 创建与
 * hydration 收尾两处都调用——创建时机可能早于 record 完全就位（createSessionRecord
 * 事件接线期间），hydration 处补一次兜住该窗口。
 */
export function seedPublisherConfig(
  gateway: Pick<V4GatewayState, "host">,
  sessionId: string,
  publisher: ConversationTopicPublisher,
): void {
  const getSeed = gateway.host.getSessionConfigSeed;
  if (!getSeed) return;
  try {
    const seed = getSeed.call(gateway.host, sessionId);
    if (seed) publisher.seedConfig(seed);
  } catch (error) {
    gateway.host.onError?.("v4.configSeed", error);
  }
}

/**
 * 运行中 subagent 没有独立 bootstrap record，但 raw child events 会先建立 publisher。
 * publisher 已存在就代表 conversation live 可订阅，不能再把同一 child cold resume 成
 * 第二个 runtime；真正的历史 session 仍由 host record / persisted resume 负责。
 */
export function hasLiveConversation(
  gateway: Pick<V4GatewayState, "detachedLiveSessions" | "host">,
  sessionId: string,
): boolean {
  return gateway.host.sessionExists(sessionId) || gateway.detachedLiveSessions.has(sessionId);
}

export async function seedPublisherUsage(
  gateway: Pick<V4GatewayState, "host">,
  sessionId: string,
  publisher: ConversationTopicPublisher,
  persistedMessages?: MessageWithParts[],
  loadedSeed?: SessionUsageSeed | null,
): Promise<void> {
  if (loadedSeed !== undefined) {
    if (loadedSeed) publisher.seedUsage(loadedSeed);
    return;
  }
  const getSeed = gateway.host.getSessionUsageSeed;
  if (!getSeed) return;
  try {
    const seed = await getSeed.call(gateway.host, sessionId, persistedMessages);
    if (seed) publisher.seedUsage(seed);
  } catch (error) {
    gateway.host.onError?.("v4.usageSeed", error);
  }
}
