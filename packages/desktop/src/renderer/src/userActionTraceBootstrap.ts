import {
  DISABLED_RENDERER_ACTION_TRACE_CONFIG,
  RENDERER_ACTION_TRACE_SERVICE_NAME,
  LCODE_ENV,
  LCODE_VERSION,
  type IPlatformService,
  type RendererActionTraceConfigV1,
} from "@lcode/shared";
import { RendererUserActionTelemetry, setUserActionTelemetry } from "@lcode/ui";

export function initializeDesktopUserActionTrace(options: {
  platform: IPlatformService;
  isLocalDevelopmentRuntime: boolean;
}): () => void {
  const sendBatch = options.platform.reportRendererActionTraceBatch;
  const getConfig = options.platform.getRendererActionTraceConfig;
  if (!sendBatch || !getConfig) {
    setUserActionTelemetry(null);
    return () => {};
  }

  const rendererInstanceId = crypto.randomUUID();
  const telemetry = new RendererUserActionTelemetry({
    config: DISABLED_RENDERER_ACTION_TRACE_CONFIG,
    resource: {
      serviceName: RENDERER_ACTION_TRACE_SERVICE_NAME,
      serviceVersion: LCODE_VERSION || "unknown",
      deploymentEnvironment: options.isLocalDevelopmentRuntime ? "development" : LCODE_ENV,
      rendererInstanceId,
    },
    sendBatch: (batch) => sendBatch(batch),
  });
  setUserActionTelemetry(telemetry);

  const applyConfig = (config: RendererActionTraceConfigV1) => telemetry.updateConfig(config);
  void getConfig()
    .then(applyConfig)
    .catch(() => {
      telemetry.updateConfig(DISABLED_RENDERER_ACTION_TRACE_CONFIG);
    });
  const disposeConfigListener = options.platform.onRendererActionTraceConfigChanged?.(applyConfig);
  const handlePageHide = () => {
    void telemetry.shutdown();
  };
  window.addEventListener("pagehide", handlePageHide, { once: true });

  return () => {
    window.removeEventListener("pagehide", handlePageHide);
    disposeConfigListener?.();
    setUserActionTelemetry(null);
    void telemetry.shutdown();
  };
}
