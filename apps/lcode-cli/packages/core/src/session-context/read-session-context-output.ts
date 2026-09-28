import type {
  ReadSessionContextInput,
  ReadSessionContextOutput,
  SessionInfo,
} from "@lcode/contracts";
import type { SessionContextMaterial } from "./read-session-context.js";

export function buildReadSessionContextOutput(input: {
  content: string;
  error?: string;
  material: SessionContextMaterial;
  parsed: ReadSessionContextInput;
  session: SessionInfo;
  source: ReadSessionContextOutput["source"];
  truncated: boolean;
}): ReadSessionContextOutput {
  return {
    status: "success",
    sessionId: input.session.id,
    title: input.session.title,
    directory: input.session.directory,
    path: input.session.path,
    strategy: input.parsed.strategy,
    query: input.parsed.query,
    source: input.source,
    content: input.content,
    messageCount: input.material.messageCount,
    selectedMessageCount: input.material.selectedMessageCount,
    truncated: input.truncated,
    error: input.error,
    references: input.material.references,
  };
}
