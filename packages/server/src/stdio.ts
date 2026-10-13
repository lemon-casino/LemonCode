import { randomUUID } from "node:crypto";
import {
  Emitter,
  VSBuffer,
  SocketProtocol,
  ChannelServer,
  ChannelClient,
  ProxyChannel,
  type ISocket,
} from "@lcode/rpc";
import {
  ILCodeAgentService,
  IRuntimeEnvironmentService,
  createLCodeAgentConnectionScope,
  type ServiceCollection,
} from "@lcode/services";
import {
  attachProviderAccountRelay,
  createPublicRuntimeEnvironmentService,
} from "@lcode/services/node";
import type { ProviderAccountRelayService } from "@lcode/services";
import { PROVIDER_ACCOUNT_RELAY_CHANNEL } from "@lcode/shared";

/**
 * Wrap process.stdin/stdout as an ISocket for RPC communication.
 * In stdio mode, stdout is reserved exclusively for RPC data.
 * All logging must go through stderr.
 */
export function wrapStdio(): ISocket {
  const onData = new Emitter<VSBuffer>();
  const onClose = new Emitter<void>();
  const onEnd = new Emitter<void>();

  process.stdin.on("data", (chunk: Buffer) => {
    onData.fire(VSBuffer.wrap(new Uint8Array(chunk)));
  });
  process.stdin.on("end", () => {
    onClose.fire();
    onEnd.fire();
  });
  process.stdin.on("error", () => {
    onClose.fire();
    onEnd.fire();
  });

  return {
    onData: onData.event,
    onClose: onClose.event,
    onEnd: onEnd.event,
    write(buffer: VSBuffer) {
      process.stdout.write(Buffer.from(buffer.buffer));
    },
    end() {
      process.stdout.end();
    },
    drain() {
      return new Promise<void>((resolve) => {
        if (process.stdout.writableNeedDrain) {
          process.stdout.once("drain", resolve);
        } else {
          resolve();
        }
      });
    },
    dispose() {
      process.stdin.destroy();
    },
  };
}

export function createStdioServer(services: ServiceCollection) {
  const socket = wrapStdio();
  const protocol = new SocketProtocol(socket);
  // 修复：反向 client 必须先监听，Desktop 在收到正向 Initialize 后才宣布 relay 就绪。
  const relayClient = new ChannelClient(protocol);
  attachProviderAccountRelay(
    services,
    ProxyChannel.toService<ProviderAccountRelayService>(
      relayClient.getChannel(PROVIDER_ACCOUNT_RELAY_CHANNEL),
    ),
  );
  const channelServer = new ChannelServer(protocol, "stdio");
  const agentService = services.getOptional(ILCodeAgentService);
  const connectionScope = agentService
    ? createLCodeAgentConnectionScope(agentService, {
        connectionId: `server-stdio-${randomUUID()}`,
        clientMode: "desktop-continuous",
        role: "trusted-host-relay",
      })
    : undefined;
  const overrides = new Map<string, unknown>();
  if (connectionScope) overrides.set(ILCodeAgentService.channelName, connectionScope.service);
  const runtimeEnvironmentService = services.getOptional(IRuntimeEnvironmentService);
  if (runtimeEnvironmentService) {
    // stdio 只是已有 Host 的服务通路，不把内部 env/lease resolver 注册为远端公共 RPC。
    overrides.set(
      IRuntimeEnvironmentService.channelName,
      createPublicRuntimeEnvironmentService(runtimeEnvironmentService),
    );
  }
  services.exposeOnChannelServer(channelServer, overrides);
  let stopPromise: Promise<void> | undefined;
  const stop = (): Promise<void> => {
    if (stopPromise) {
      return stopPromise;
    }

    // 先同步摘掉 protocol listener，保证从这一刻起不再接收新的 service RPC；
    // connection scope 的异步退订完成后再关闭底层 stdio。
    channelServer.dispose();
    relayClient.dispose();
    stopPromise = (async () => {
      try {
        await connectionScope?.dispose();
      } finally {
        socket.dispose();
      }
    })();
    return stopPromise;
  };
  socket.onClose(() => {
    void stop();
  });
  return { stop };
}
