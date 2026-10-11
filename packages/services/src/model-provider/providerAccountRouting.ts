import type { AuthModel, AuthWireProtocol } from "@lcode/provider-node";

interface RoutableAccount {
  channelId: string;
  enabled: boolean;
  models: readonly AuthModel[];
}

/** One routing rule shared by ticket issuance and execution, including manual model IDs. */
export function resolveProviderAccountRoutes<T extends RoutableAccount>(
  accounts: readonly T[],
  channelId: string,
  modelId: string,
  protocol?: AuthWireProtocol,
): { account: T; model: AuthModel }[] {
  const channel = accounts.filter((account) => account.channelId === channelId);
  const known = channel.some((account) => account.models.some((model) => model.id === modelId));
  const candidates = channel
    .filter((account) => account.enabled)
    .flatMap((account) => {
      const model = account.models.find(
        (item) => (!known || item.id === modelId) && (!protocol || item.protocol === protocol),
      );
      // 手动模型只复用已授权端点；目录已知的模型不借手动回退绕过账号模型范围。
      return model
        ? [{ account, model: known ? model : { ...model, id: modelId, name: modelId } }]
        : [];
    });
  const selected = protocol ?? candidates[0]?.model.protocol;
  return candidates.filter(({ model }) => model.protocol === selected);
}
