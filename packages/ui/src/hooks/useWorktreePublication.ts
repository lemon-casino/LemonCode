import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { WorktreeIntegration } from "@lcode/services";
import type { GitRemoteInfo, GitTagInfo, GitUnsupportedTagInfo } from "@lcode/shared";
import { useServices } from "./useServices.js";
import { useLCodeIntl } from "@/i18n/IntlProvider.js";
import { getErrorMessage } from "@/lib/errorMessage.js";
import { createPublishOptions, type PublishPlan } from "@/git-action-menu/publishModel.js";
import { worktreePublicationPlan } from "@/worktree/worktreePublicationPlan.js";
import {
  executePublishPlan,
  retryPublishStep,
  type PublishRun,
} from "@/git-action-menu/publishExecution.js";
import {
  applyPublishPreset,
  parsePublishPresets,
  publishPresetStorageKey,
  serializePublishPresets,
  type PublishPreset,
} from "@/git-action-menu/publishPresets.js";

/** 原 Git 发布执行器解释本次预览冻结的目标 HEAD；此 hook 只拥有当前弹窗的计划和结果。 */
export function useWorktreePublication(operation: WorktreeIntegration, workspaceIdentity?: string) {
  const { gitService } = useServices();
  const { intl } = useLCodeIntl();
  const request = useMemo(
    () => ({ workspacePath: operation.repositoryPath ?? operation.targetPath, workspaceIdentity }),
    [operation.repositoryPath, operation.targetPath, workspaceIdentity],
  );
  const scope = JSON.stringify([operation.id, operation.candidateHead, workspaceIdentity]);
  const active = useRef(scope);
  active.current = scope;
  const busy = useRef(false);
  const [pending, setPending] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [options, setOptions] = useState(createPublishOptions);
  const [catalog, setCatalog] = useState<{
    remotes: GitRemoteInfo[];
    tags: GitTagInfo[];
    unsupportedTags: GitUnsupportedTagInfo[];
  }>({ remotes: [], tags: [], unsupportedTags: [] });
  const [error, setError] = useState<string | null>(null);
  const [plan, setPlan] = useState<PublishPlan | null>(null);
  const [run, setRun] = useState<PublishRun | null>(null);
  const [presets, setPresets] = useState<PublishPreset[]>([]);
  const [presetName, setPresetName] = useState("");
  const [selectedPreset, setSelectedPreset] = useState("");
  const presetKey = publishPresetStorageKey(operation.targetPath, workspaceIdentity);
  useEffect(() => {
    active.current = scope;
    try {
      setPresets(parsePublishPresets(localStorage.getItem(presetKey)));
    } catch (failure) {
      setError(getErrorMessage(failure));
    }
    return () => {
      active.current = "";
    };
  }, [scope, presetKey]);
  const perform = useCallback(
    async (action: (isCurrent: () => boolean) => Promise<void>) => {
      if (busy.current) return;
      busy.current = true;
      setPending(true);
      setError(null);
      const isCurrent = () => active.current === scope;
      try {
        await action(isCurrent);
      } catch (failure) {
        if (isCurrent()) setError(getErrorMessage(failure));
      } finally {
        busy.current = false;
        if (isCurrent()) setPending(false);
      }
    },
    [scope],
  );
  const reload = () =>
    perform(async (isCurrent) => {
      const [remotes, tags] = await Promise.all([
        gitService.listRemotes(request),
        gitService.listTags(request),
      ]);
      if (isCurrent())
        setCatalog({
          remotes: remotes.remotes,
          tags: tags.tags,
          unsupportedTags: tags.unsupportedTags ?? [],
        });
    });
  const preview = () =>
    perform(async (isCurrent) => {
      const [state, remotes, tags] = await Promise.all([
        gitService.getPublishState({ ...request, sourceBranch: operation.targetBranch }),
        gitService.listRemotes(request),
        gitService.listTags(request),
      ]);
      if (!isCurrent()) return;
      const result = worktreePublicationPlan({
        operation,
        workspaceIdentity,
        options,
        state,
        remotes: remotes.remotes,
        tags: tags.tags,
        unsupportedTags: tags.unsupportedTags,
      });
      if (result.error) throw new Error(intl.formatMessage({ id: result.error }));
      setPlan(result.plan!);
    });
  const confirm = () =>
    perform(async (isCurrent) => {
      if (!plan) return;
      const result = await executePublishPlan({
        service: gitService,
        plan,
        isCurrent,
        onUpdate: setRun,
      });
      if (isCurrent()) setRun(result);
    });
  const retry = (id: string) =>
    perform(async (isCurrent) => {
      if (!run) return;
      const result = await retryPublishStep({
        service: gitService,
        run,
        stepId: id,
        isCurrent,
        onUpdate: setRun,
      });
      if (isCurrent()) setRun(result);
    });
  const savePresets = (next: PublishPreset[]) => {
    try {
      localStorage.setItem(presetKey, serializePublishPresets(next));
      setPresets(next);
    } catch (failure) {
      setError(getErrorMessage(failure));
    }
  };
  return {
    expanded,
    pending,
    options,
    catalog,
    error,
    plan,
    run,
    presets,
    presetName,
    selectedPreset,
    setOptions: (next: typeof options) => {
      setOptions(next);
      setError(null);
    },
    setPresetName,
    setSelectedPreset,
    toggle: () => {
      setExpanded(!expanded);
      if (!expanded) void reload();
    },
    reload,
    preview,
    confirm,
    retry,
    cancelPreview: () => setPlan(null),
    reset: () => {
      setPlan(null);
      setRun(null);
      void reload();
    },
    savePreset: () => {
      const name = presetName.trim();
      if (name) {
        savePresets([...presets.filter((preset) => preset.name !== name), { name, options }]);
        setSelectedPreset(name);
      }
    },
    applyPreset: () => {
      const preset = presets.find((item) => item.name === selectedPreset);
      if (preset)
        setOptions(
          applyPublishPreset(
            preset,
            catalog.tags.map((tag) => tag.name),
          ),
        );
    },
    deletePreset: () => {
      savePresets(presets.filter((preset) => preset.name !== selectedPreset));
      setSelectedPreset("");
    },
  };
}
