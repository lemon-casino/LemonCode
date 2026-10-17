import { useEffect, useRef, useState } from "react";
import {
  findProjectDefinition,
  isSameLocalProjectPath,
  type ProjectDefinition,
  type ProjectMutationRequest,
} from "@lcode/shared";
import type { SidebarProjectEditorTarget } from "./useSidebarOrganization.js";
import {
  useBaseWorkspaceServices,
  useWorkspaceServicesResolution,
} from "./useWorkspaceServices.js";
import { useSettings } from "./useSettingService.js";
import { getPathLeaf } from "@/lib/path.js";
import { toast } from "@/components/ui/toast.js";
import { useProjectEditorText } from "@/WorkspaceSidebar/projectEditorText.js";
import { mergeLocalProjectFolderPaths } from "@/createProjectFolderDrop.js";

export function useProjectEditor(target: SidebarProjectEditorTarget, onSaved: () => void) {
  const baseServices = useBaseWorkspaceServices();
  const { mutateProject, refresh } = useSettings(baseServices);
  const resolution = useWorkspaceServicesResolution(
    target.workspacePath,
    target.remoteSessionId,
    target.workspaceIdentity,
    target.remoteTarget,
  );
  const connection = useRef(resolution);
  connection.current = resolution;
  const text = useProjectEditorText();
  const [base, setBase] = useState<ProjectDefinition | null>(null);
  const [draft, setDraft] = useState<ProjectDefinition | null>(null);
  const [projects, setProjects] = useState<ProjectDefinition[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [latest, setLatest] = useState<ProjectDefinition | null | undefined>();
  const [saving, setSaving] = useState(false);
  const [folderErrors, setFolderErrors] = useState<Record<string, string>>(Object.create(null));
  const [checking, setChecking] = useState(false);
  const requestRef = useRef<ProjectMutationRequest | null>(null);
  const loadGeneration = useRef(0);
  const original = useRef("");
  const load = async () => {
    const token = ++loadGeneration.current;
    setLoading(true);
    setError("");
    try {
      const settings = await baseServices.settingService.get();
      const all = settings.projectDefinitions?.projects ?? settings.localProjects;
      const existing = findProjectDefinition(
        all,
        target.workspacePath,
        target.workspaceIdentity,
        target.localProjectId,
      );
      const initial = existing ?? {
        id: crypto.randomUUID(),
        name: target.label || getPathLeaf(target.workspacePath),
        primaryFolderPath: target.workspacePath,
        sourceFolderPaths: [target.workspacePath],
        ...(target.workspaceIdentity ? { workspaceIdentity: target.workspaceIdentity } : {}),
      };
      const members =
        initial.members ??
        initial.sourceFolderPaths.map((path) => ({
          id: crypto.randomUUID(),
          path,
          role: "",
          label: "",
          description: "",
          enabled: true,
        }));
      const display = {
        ...initial,
        members,
        memberOrder: initial.memberOrder ?? members.map((member) => member.id),
      };
      if (token !== loadGeneration.current) return;
      original.current = JSON.stringify(display);
      setBase(existing ?? null);
      setDraft(display);
      setProjects(all);
      setLatest(undefined);
    } catch (failure) {
      if (token === loadGeneration.current)
        setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      if (token === loadGeneration.current) setLoading(false);
    }
  };
  useEffect(() => {
    void load();
    return () => {
      loadGeneration.current++;
    };
  }, [
    baseServices.settingService,
    target.workspacePath,
    target.workspaceIdentity,
    target.localProjectId,
  ]);
  const changed = Boolean(draft && JSON.stringify(draft) !== original.current);
  const addFolders = async (paths: string[]): Promise<boolean> => {
    if (!draft || checking || saving || !resolution.rpcReady) return false;
    const source = resolution.services;
    const token = loadGeneration.current;
    setError("");
    const merged = mergeLocalProjectFolderPaths(draft.sourceFolderPaths, paths);
    if (!merged.addedPaths.length) {
      if (merged.discardedForLimitCount) setError(text("limit"));
      return false;
    }
    setChecking(true);
    try {
      for (let offset = 0; offset < merged.addedPaths.length; offset += 4) {
        await Promise.all(
          merged.addedPaths.slice(offset, offset + 4).map(async (path) => {
            const status = await source.fileService.stat({ path });
            if (status.type !== "directory") throw new Error(`${path}: Not a directory`);
          }),
        );
      }
      if (token !== loadGeneration.current) return false;
      if (!connection.current.rpcReady || connection.current.services !== source)
        throw new Error(text("connectionChanged"));
      const added = merged.addedPaths.map((path) => ({
        id: crypto.randomUUID(),
        path,
        role: "",
        label: "",
        description: "",
        enabled: true,
      }));
      // 中文依据：多选/拖入先校验整批目录，再一次追加；使用当前草稿保留等待期间已编辑的说明。
      setDraft((current) =>
        current
          ? {
              ...current,
              sourceFolderPaths: [
                ...current.sourceFolderPaths,
                ...added.map((member) => member.path),
              ],
              members: [...current.members!, ...added],
              memberOrder: [...current.memberOrder!, ...added.map((member) => member.id)],
            }
          : current,
      );
      if (merged.discardedForLimitCount) setError(text("limit"));
      return true;
    } catch (failure) {
      if (token === loadGeneration.current)
        setError(failure instanceof Error ? failure.message : String(failure));
      return false;
    } finally {
      if (token === loadGeneration.current) setChecking(false);
    }
  };
  const signature = draft?.sourceFolderPaths.join("\u0000");
  useEffect(() => {
    let active = true;
    if (!draft || !resolution.rpcReady) {
      setFolderErrors({});
      return;
    }
    const paths = draft.sourceFolderPaths;
    void (async () => {
      const errors: Record<string, string> = {};
      for (let offset = 0; offset < paths.length; offset += 4) {
        await Promise.all(
          paths.slice(offset, offset + 4).map(async (path) => {
            try {
              if ((await resolution.services.fileService.stat({ path })).type !== "directory")
                errors[path] = "Not a directory";
            } catch (failure) {
              errors[path] = failure instanceof Error ? failure.message : String(failure);
            }
          }),
        );
        if (!active) return;
      }
      setFolderErrors(errors);
    })();
    return () => {
      active = false;
    };
  }, [signature, resolution.services, resolution.rpcReady]);
  const save = async () => {
    if (!draft || saving || checking) return;
    setError("");
    if (!draft.members?.some((member) => member.enabled)) {
      setError(text("noSelection"));
      return;
    }
    const addedError = Object.entries(folderErrors).find(
      ([path]) => !base?.sourceFolderPaths.some((item) => isSameLocalProjectPath(item, path)),
    );
    if (addedError) {
      setError(`${addedError[0]}: ${addedError[1]}`);
      return;
    }
    setSaving(true);
    const command = {
      type: "save" as const,
      projectId: draft.id,
      expectedRevision: base ? (base.revision ?? 0) : null,
      project: { ...draft, name: draft.name.trim() },
    };
    const previous = requestRef.current;
    const { operationId: _id, ...previousCommand } = previous ?? { operationId: "" };
    const request: ProjectMutationRequest =
      JSON.stringify(command) === JSON.stringify(previousCommand)
        ? previous!
        : { ...command, operationId: crypto.randomUUID() };
    requestRef.current = request;
    try {
      // 中文依据：响应丢失时重放原 operationId，由设置 owner 核对收据；禁止新 key 重复创建。
      let result;
      try {
        result = await mutateProject(request);
      } catch {
        result = await mutateProject(request);
      }
      if (result.status === "conflict") {
        // 中文依据：另一窗口可能已将隐式目录升级为不同 id 的同源项目，这不是对象被删除。
        setLatest(result.project);
        setError(result.reason ?? text("failed"));
        return;
      }
      if (result.status !== "applied") {
        setError(result.reason ?? text("failed"));
        return;
      }
      toast(text("saved"));
      onSaved();
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : text("failed"));
    } finally {
      setSaving(false);
    }
  };
  return {
    base,
    draft,
    setDraft,
    projects,
    loading,
    error,
    latest,
    saving,
    checking,
    folderErrors,
    changed,
    services: resolution.services,
    ready: resolution.rpcReady,
    addFolders,
    addFolder: (path: string) => addFolders([path]),
    reportFolderError: (message: string | null) => setError(message ?? ""),
    save,
    load,
    reviewLatest: () => {
      if (latest && latest.id === draft?.id) {
        setBase(latest);
        setLatest(undefined);
        setError("");
        requestRef.current = null;
      }
    },
    refresh,
  };
}
