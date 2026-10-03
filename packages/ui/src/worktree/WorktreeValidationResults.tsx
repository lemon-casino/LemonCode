import type { WorktreeIntegration } from "@lcode/services";

export function WorktreeValidationResults({
  results,
  commands = [],
}: {
  results: WorktreeIntegration["validationResults"];
  commands?: string[];
}) {
  return (
    <>
      {commands.length ? (
        <pre
          data-testid="worktree-validation-plan"
          className="max-h-40 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-sm"
        >
          {commands.join("\n")}
        </pre>
      ) : null}
      {results.map((result, index) => (
        <details key={index}>
          <summary className="break-all font-mono text-ui-sm">
            {result.command} — {result.exitCode}
          </summary>
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-sm">
            {result.output}
          </pre>
        </details>
      ))}
    </>
  );
}
