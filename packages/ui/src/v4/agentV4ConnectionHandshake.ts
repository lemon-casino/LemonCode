// 每个 RPC service proxy 对应一个 attachment；hello/clientHello 只做一次，所有
// conversation/sessions-index transport 共享该 Promise，避免并发首订阅重复握手。
import type { ILCodeAgentService } from "@lcode/services";
import {
  V4_WIRE_PROTOCOL_VERSION,
  helloMessageSchema,
  type HelloMessage,
} from "@lcode/shared/lcode-protocol-v4";
import { getV4ClientId } from "@/v4/commandFactory.js";

type AgentV4HandshakeService = Pick<
  ILCodeAgentService,
  "helloConversationV4" | "initializeConversationV4"
>;

const handshakes = new WeakMap<object, Promise<HelloMessage>>();
export function ensureAgentV4ConnectionHandshake(
  service: AgentV4HandshakeService,
): Promise<HelloMessage> {
  const key = service as object;
  const existing = handshakes.get(key);
  if (existing) return existing;

  const handshake = (async () => {
    const hello = helloMessageSchema.parse(await service.helloConversationV4());
    await service.initializeConversationV4({
      kind: "clientHello",
      protocolVersion: V4_WIRE_PROTOCOL_VERSION,
      // handshake 与 commandFactory 曾各生成一套页面 clientId，facade
      // 无法验证 command envelope 是否属于已绑定客户端。统一复用持久化 V4 clientId。
      clientId: getV4ClientId(),
      clientKind: hello.clientMode === "desktop-continuous" ? "desktop" : "web",
      appVersion: "unknown",
      capabilities: { workspaceHookReviewUi: true },
    });
    return hello;
  })();
  handshakes.set(key, handshake);
  void handshake.catch(() => {
    if (handshakes.get(key) === handshake) handshakes.delete(key);
  });
  return handshake;
}
