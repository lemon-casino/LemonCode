import type { CompileDiagnostic } from "@lcode/dynamic-workflow";

/** resume 拒绝文案里诊断的上限（与中枢直接启动的 compile_failed 同一量级）。 */
const RESUME_DIAGNOSTICS_MAX_CHARS = 2000;

/** compile_failed 的人可读诊断：一行一条 `L:C message`，整体有界。 */
export function boundedResumeDiagnostics(runId: string, diagnostics: CompileDiagnostic[]): string {
  const body = [
    `The stored script of run ${runId} no longer compiles against the current workflow facade:`,
    ...diagnostics.map(
      (diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`,
    ),
  ].join("\n");
  return body.length > RESUME_DIAGNOSTICS_MAX_CHARS
    ? `${body.slice(0, RESUME_DIAGNOSTICS_MAX_CHARS - 1)}…`
    : body;
}
