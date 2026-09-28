import { createContext, useContext, useMemo, type ReactNode } from "react";
import { findLocalProjectForWorkspace, type LocalProject } from "@lcode/shared";

const LocalProjectsContext = createContext<readonly LocalProject[]>([]);

export function LocalProjectsProvider({
  projects,
  children,
}: {
  projects: readonly LocalProject[];
  children: ReactNode;
}) {
  return <LocalProjectsContext.Provider value={projects}>{children}</LocalProjectsContext.Provider>;
}

export function useLocalProjectForWorkspace(
  workspacePath: string,
  workspaceIdentity?: string,
): LocalProject | undefined {
  const projects = useContext(LocalProjectsContext);
  return useMemo(
    () => (workspaceIdentity ? undefined : findLocalProjectForWorkspace(projects, workspacePath)),
    [projects, workspaceIdentity, workspacePath],
  );
}
