import type { LCodeSessionStateSnapshot } from "@lcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { repairImportedClaudeSessionSnapshot } from "#src/session/claude-native/importedClaudeHistoryRepair.js";
import type { ILCodeAgentService } from "#src/lcode-agent/lcodeAgent.js";
import type {
  LCodeSessionReadParams,
  LCodeSessionResumeParams,
} from "#src/lcode-session/lcodeSession.js";

const logger = createServiceLogger("lcode-session-service");

export async function repairEmptyImportedClaudeSessionSnapshot(params: {
  agentService: ILCodeAgentService;
  snapshot: LCodeSessionStateSnapshot;
  target: LCodeSessionResumeParams | LCodeSessionReadParams;
}): Promise<LCodeSessionStateSnapshot> {
  const repaired = await repairImportedClaudeSessionSnapshot({
    snapshot: params.snapshot,
    target: {
      workspacePath: params.target.workspacePath,
      workspaceIdentity: params.target.workspaceIdentity,
      taskId: params.target.sessionId,
      ...("mcpServers" in params.target && params.target.mcpServers
        ? { mcpServers: params.target.mcpServers }
        : {}),
    },
    createSession: (input) => params.agentService.createSession(input),
    onRepair: (history) => {
      logger.warn(
        undefined,
        `[lcode-session-service] Claude 导入 session 历史异常，按 ${history.source} 回填 taskId=${params.target.sessionId}`,
      );
    },
  });
  return repaired ?? params.snapshot;
}
