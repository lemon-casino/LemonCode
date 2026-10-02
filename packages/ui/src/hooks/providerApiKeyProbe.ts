import type {
  IProviderSettingsService,
  ProviderApiKeyProbeProgress,
  ProviderApiKeyProbeResult,
} from "@lcode/services";

export interface ProviderApiKeyProbeRunOptions {
  readonly operationId: string;
  readonly signal: AbortSignal;
  readonly onProgress: (progress: ProviderApiKeyProbeProgress) => void;
}

export async function probeProviderApiKeys(
  service: IProviderSettingsService,
  providerId: string,
  keyIds?: readonly string[],
  options?: ProviderApiKeyProbeRunOptions,
): Promise<readonly ProviderApiKeyProbeResult[]> {
  if (!options) return service.probeApiKeys(providerId, keyIds);
  if (options.signal.aborted) return [];
  const subscription = service.onDidProbeApiKeys((event) => {
    if (event.operationId === options.operationId && event.providerId === providerId)
      options.onProgress(event);
  });
  // AbortSignal 留在 UI hook，RPC 只传可序列化的 operationId；不把平台对象跨进程传递。
  const cancel = () => {
    void service.cancelApiKeyProbe(providerId, options.operationId).catch(() => undefined);
  };
  options.signal.addEventListener("abort", cancel, { once: true });
  try {
    return await service.probeApiKeys(providerId, keyIds, {
      operationId: options.operationId,
      streamResults: true,
    });
  } finally {
    options.signal.removeEventListener("abort", cancel);
    subscription.dispose();
  }
}
