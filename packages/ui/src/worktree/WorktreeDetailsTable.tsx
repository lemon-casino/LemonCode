import type { ReactNode } from "react";

export function WorktreeDetailsTable({
  label,
  children,
  testId,
}: {
  label: string;
  children: ReactNode;
  testId?: string;
}) {
  return (
    <div className="min-w-0 overflow-hidden rounded-lg border border-border bg-card">
      <table className="w-full table-fixed text-ui-sm" aria-label={label} data-testid={testId}>
        <tbody>{children}</tbody>
      </table>
    </div>
  );
}

export function WorktreeDetailsRow({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <tr className="border-b border-border last:border-b-0">
      <th
        scope="row"
        className="w-1/3 px-3 py-2 text-left align-top font-normal text-foreground-subtle [overflow-wrap:anywhere] sm:w-36"
      >
        {label}
      </th>
      <td className="min-w-0 px-3 py-2 align-top [overflow-wrap:anywhere]">{children}</td>
    </tr>
  );
}
