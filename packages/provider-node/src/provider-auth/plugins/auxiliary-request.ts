const CURSOR_AUXILIARY = new Set([
  "/aiserver.v1.ServerConfigService/GetServerConfig",
  "/aiserver.v1.DashboardService/GetFilteredUsageEvents",
  "/aiserver.v1.DashboardService/GetMe",
  "/aiserver.v1.DashboardService/GetPlanInfo",
  "/aiserver.v1.DashboardService/GetHardLimit",
  "/aiserver.v1.DashboardService/GetCurrentPeriodUsage",
  "/aiserver.v1.AiService/AvailableModels",
  "/agent.v1.AgentService/GetUsableModels",
]);
/** 仅放行已核对的辅助接口；不能按整个域名或路径前缀豁免推理 POST。 */
export function isPluginAuxiliaryRequest(channel: string, input: string | URL | Request): boolean {
  const url = new URL(input instanceof Request ? input.url : String(input));
  return (
    (channel === "cursor" &&
      url.hostname === "api2.cursor.sh" &&
      CURSOR_AUXILIARY.has(url.pathname)) ||
    (channel === "zed" && url.hostname === "cloud.zed.dev" && url.pathname === "/client/llm_tokens")
  );
}
