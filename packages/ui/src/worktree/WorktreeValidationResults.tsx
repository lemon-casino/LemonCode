import type { WorktreeIntegration } from "@lcode/services";

export function WorktreeValidationResults({
  results,
}: {
  results: WorktreeIntegration["validationResults"];
}) {
  return results.map((result, index) => (
    <details key={index}>
      <summary className="break-all font-mono text-ui-sm">
        {result.command} — {result.exitCode}
      </summary>
      <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-all font-mono text-ui-sm">
        {result.output}
      </pre>
    </details>
  ));
}
