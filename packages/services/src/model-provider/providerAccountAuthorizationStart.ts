import { randomUUID } from "node:crypto";
import {
  startProviderAuthorizationSchema,
  type ProviderAuthorization,
  type StartProviderAuthorization,
} from "@lcode/shared";
import type { AuthDriver, AuthDriverFactory } from "@lcode/provider-node";
import type { ProviderAccountDriverCleanup } from "./providerAccountDriverCleanup.js";
import type {
  AccountAuthorizationAttempt as Attempt,
  AccountAuthorizationRecord,
} from "./providerAccountCompletion.js";
import { prepareProviderAuthorizationInputs } from "./providerAccountAuthorizationInputs.js";
import {
  updateAuthorizationProgress,
  failAuthorizationProgress,
} from "./providerAuthorizationProgress.js";
import { authorizationFailureMessage } from "./providerAccountStorage.js";
interface StartHost {
  ready: Promise<unknown>;
  closed(): boolean;
  channels: readonly { id: string; name: string }[];
  factory: AuthDriverFactory;
  cleanup: ProviderAccountDriverCleanup;
  hostId(): Promise<string>;
  starting: Map<AuthDriver, AbortController>;
  attempts: Map<string, AccountAuthorizationRecord>;
  complete(attempt: Attempt): Promise<void>;
}
/** 仅编排原 ProviderAccounts 的资源与 Map；不会建立第二份 attempt/凭据状态。 */
export async function startProviderAccountAuthorization(
  host: StartHost,
  input: StartProviderAuthorization,
): Promise<ProviderAuthorization> {
  await host.ready;
  if (host.closed()) throw new Error("Provider account service closed");
  const parsed = startProviderAuthorizationSchema.parse(input);
  const channel = host.channels.find((item) => item.id === parsed.channelId);
  if (!channel) throw new Error("Unknown authorization channel");
  const progress = {
    startedAt: Date.now(),
    view: {
      attemptId: randomUUID(),
      channelId: parsed.channelId,
      methodId: parsed.methodId,
      status: "pending",
      method: "auto",
    } as ProviderAuthorization,
  };
  updateAuthorizationProgress(progress, { phase: "preparing", credentialsSaved: false });
  let active: Attempt | undefined;
  let owned: { driver: AuthDriver; controller: AbortController } | undefined;
  try {
    owned = await host.cleanup.constructDriver({
      create: () => host.factory(parsed.channelId),
      closed: () => host.closed(),
      publish: (driver) => {
        const controller = new AbortController();
        host.starting.set(driver, controller);
        return { driver, controller };
      },
    });
    const { driver, controller } = owned;
    if (host.closed()) throw new Error("Provider account service closed");
    const method = (await driver.methods()).find((item) => item.id === parsed.methodId);
    if (!method) throw new Error("Unknown authorization method");
    const inputs = prepareProviderAuthorizationInputs(method, parsed.inputs);
    if (channel.id === "chatgpt-api") inputs.hostId = await host.hostId();
    controller.signal.throwIfAborted();
    const challenge = await driver.authorize(
      parsed.methodId,
      inputs,
      controller.signal,
      (diagnostic) => {
        const owner = active ?? progress;
        if (!controller.signal.aborted && owner.view.status === "pending")
          updateAuthorizationProgress(owner, diagnostic);
      },
    );
    if (host.closed() || controller.signal.aborted) {
      challenge.cancel?.();
      throw new Error("Authorization cancelled");
    }
    const view: ProviderAuthorization = {
      ...progress.view,
      method: challenge.method,
      ...(challenge.url ? { url: challenge.url } : {}),
      ...(challenge.instructions ? { instructions: challenge.instructions } : {}),
    };
    const attempt: Attempt = { view, controller, driver, challenge, startedAt: progress.startedAt };
    active = attempt;
    updateAuthorizationProgress(attempt, { phase: "waiting", credentialsSaved: false });
    host.attempts.set(view.attemptId, attempt);
    if (challenge.method === "auto") attempt.completion = host.complete(attempt);
    return { ...attempt.view };
  } catch (error) {
    progress.view.status = "failed";
    failAuthorizationProgress(progress, error, progress.view.diagnostic?.phase ?? "preparing");
    if (owned) {
      owned.controller.abort();
      // 关闭失败仍由原 cleanup owner 留存，不能覆盖本次授权的安全失败事实。
      await host.cleanup.retire(owned.driver).catch(() => {});
    }
    if (host.closed()) throw new Error(authorizationFailureMessage(error));
    host.attempts.set(progress.view.attemptId, progress);
    return { ...progress.view };
  } finally {
    if (owned) host.starting.delete(owned.driver);
  }
}
