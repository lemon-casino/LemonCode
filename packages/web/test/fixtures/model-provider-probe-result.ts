import type { ModelConnectivityResult } from "@lcode/shared";

/** 夹具的上游结果与本地配置错误，保持真实 UI 的准入、取消和持久化逻辑。 */
export function simulateModelProbeResult(
  modelId: string,
  localConfigurationError: boolean,
  record: (message: string) => void,
): ModelConnectivityResult {
  if (localConfigurationError) {
    return {
      success: false,
      error: {
        code: "provider-unavailable",
        message: "Fixture local proxy configuration unavailable",
      },
    };
  }
  if (modelId === "throws-model") {
    record("throws");
    throw new Error("Fixture probe threw (simulated network failure)");
  }
  if (modelId === "bad-model") {
    record("HTTP 403");
    return { success: false, error: { message: "HTTP 403: fixture access denied (simulated)" } };
  }
  if (modelId === "invalid-model") {
    record("model-not-found");
    return {
      success: false,
      error: { code: "model-not-found", message: "Fixture provider confirms model missing" },
    };
  }
  if (modelId === "uncertain-model") {
    record("HTTP 503");
    return { success: false, error: { message: "HTTP 503: fixture unavailable (simulated)" } };
  }
  record("success");
  return { success: true };
}
