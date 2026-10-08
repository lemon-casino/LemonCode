import { useCallback, useEffect, useRef, useState } from "react";
import type { IRuntimeEnvironmentService, WorktreeBinding } from "@lcode/services";
import {
  runtimeEnvironmentCapabilitiesSchema,
  runtimeEnvironmentErrorSchema,
  runtimeEnvironmentSnapshotSchema,
  type RuntimeEnvironmentCapabilities,
  type RuntimeEnvironmentError,
  type RuntimeEnvironmentPrepareParams,
  type RuntimeEnvironmentProjection,
  type RuntimeEnvironmentScope,
  type RuntimeEnvironmentSnapshot,
  type RuntimePreparationOperation,
} from "@lcode/shared";
import { useWorkspaceServicesResolution } from "./useWorkspaceServices.js";
import {
  applyEnvironmentSnapshot,
  environmentActionAvailable,
  environmentScopeKey,
  restoreEnvironmentUpgradeRequest,
} from "./runtimeEnvironmentModel.js";
import { getErrorMessage } from "@/lib/errorMessage.js";

interface EnvironmentTarget extends RuntimeEnvironmentScope {
  routingWorkspacePath?: string;
  workspaceRemoteSessionId?: string;
  environmentId?: string;
  bindingId?: string;
  binding?: WorktreeBinding;
  purpose?: "worktree" | "integration-candidate";
}
interface EnvironmentView {
  key: string;
  snapshot: RuntimeEnvironmentSnapshot | null;
  capabilities?: RuntimeEnvironmentCapabilities;
  operation?: RuntimePreparationOperation;
  error?: string;
  diagnostic?: RuntimeEnvironmentError;
  loading: boolean;
  pending: string | null;
}
interface EnvironmentReadOwner {
  key: string;
  service?: IRuntimeEnvironmentService;
  snapshot: RuntimeEnvironmentSnapshot | null;
  environmentId?: string;
  request?: RuntimeEnvironmentPrepareParams;
  pending: string | null;
}
const scanBudget = { maxEntries: 2000, maxDurationMs: 200 };

/** 只保留 UI 读取投影/未结算意图；所有生命周期事实与动作幂等仍由目标 Host 所有。 */
export function useRuntimeEnvironment(target: EnvironmentTarget) {
  const { workspacePath, workspaceIdentity, bindingId, purpose = "worktree" } = target;
  const resolution = useWorkspaceServicesResolution(
    target.routingWorkspacePath ?? workspacePath,
    target.workspaceRemoteSessionId,
    workspaceIdentity,
  );
  const service = resolution.rpcReady ? resolution.services.runtimeEnvironmentService : undefined;
  const scope: RuntimeEnvironmentScope = {
    workspacePath,
    ...(workspaceIdentity ? { workspaceIdentity } : {}),
  };
  const restoredRequest = restoreEnvironmentUpgradeRequest(scope, target.binding);
  const key = JSON.stringify([
    environmentScopeKey(scope),
    bindingId,
    target.environmentId,
    target.binding?.status === "updating"
      ? target.binding.environmentUpgrade?.requestId
      : undefined,
    target.binding?.environmentUpgrade?.cancelled,
  ]);
  const [view, setView] = useState<EnvironmentView>({
    key,
    snapshot: null,
    loading: true,
    pending: null,
  });
  const owner = useRef<EnvironmentReadOwner>({
    key,
    service,
    snapshot: null,
    environmentId: target.environmentId,
    request: restoredRequest,
    pending: null,
  });
  if (owner.current.key !== key || owner.current.service !== service) {
    const previous = owner.current;
    owner.current = {
      key,
      service,
      snapshot: previous.key === key ? previous.snapshot : null,
      environmentId:
        target.environmentId ?? (previous.key === key ? previous.environmentId : undefined),
      request: restoredRequest ?? (previous.key === key ? previous.request : undefined),
      pending: null,
    };
  }
  const current = view.key === key ? view : { key, snapshot: null, loading: true, pending: null };
  const update = useCallback((source: EnvironmentReadOwner, patch: Partial<EnvironmentView>) => {
    if (owner.current !== source) return;
    setView((value) => ({
      ...(value.key === source.key
        ? value
        : { key: source.key, snapshot: null, loading: true, pending: null }),
      ...patch,
    }));
  }, []);
  const readSnapshot = useCallback(
    async (source: EnvironmentReadOwner) => {
      if (!source.service || !source.environmentId) return null;
      const snapshot = runtimeEnvironmentSnapshotSchema.parse(
        await source.service.snapshot({
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          environmentId: source.environmentId,
        }),
      );
      if (owner.current !== source) return null;
      const accepted = applyEnvironmentSnapshot(
        source.snapshot,
        snapshot,
        { workspacePath, workspaceIdentity },
        source.environmentId,
      );
      if (!accepted) throw new Error("scope-mismatch");
      source.snapshot = accepted;
      update(source, { snapshot: accepted });
      return accepted.environment ?? null;
    },
    [workspacePath, workspaceIdentity, update],
  );
  const refresh = useCallback(async () => {
    const source = owner.current;
    if (!source.service) {
      // 断连后旧 capability 不是当前 attachment 的授权；保留只读事实但立即关闭动作门禁。
      update(source, {
        loading: false,
        capabilities: undefined,
        pending: null,
        error: resolution.rpcReady ? "capability-unavailable" : "remote-waiting",
      });
      return;
    }
    update(source, { loading: true, error: undefined });
    try {
      const [capabilities] = await Promise.all([
        source.service
          .getCapabilities({ workspacePath, ...(workspaceIdentity ? { workspaceIdentity } : {}) })
          .then((value) => runtimeEnvironmentCapabilitiesSchema.parse(value)),
        readSnapshot(source),
      ]);
      update(source, { capabilities, loading: false });
    } catch (error) {
      update(source, { loading: false, error: getErrorMessage(error) });
    }
  }, [workspacePath, workspaceIdentity, resolution.rpcReady, readSnapshot, update]);
  useEffect(() => {
    const source = owner.current;
    void refresh();
    const subscription = source.service?.onDidChangeEnvironment?.((event) => {
      // 事件仅使快照失效；不能把事件 payload 或本地 pending 当作 ready 事实。
      if (
        owner.current !== source ||
        event.environmentId !== source.environmentId ||
        event.stateRevision <= (source.snapshot?.stateRevision ?? -1)
      )
        return;
      void readSnapshot(source).catch((error) => update(source, { error: getErrorMessage(error) }));
    });
    return () => subscription?.dispose();
  }, [key, service, refresh, readSnapshot, update]);
  const perform = useCallback(
    async (
      label: string,
      action: (source: EnvironmentReadOwner) => Promise<void>,
      allowPending = false,
    ) => {
      const source = owner.current;
      if (!source.service || (source.pending && !allowPending)) return false;
      source.pending = label;
      update(source, { pending: label, error: undefined, diagnostic: undefined });
      try {
        await action(source);
        if (owner.current !== source) return false;
        await readSnapshot(source);
        return true;
      } catch (error) {
        const parsed = runtimeEnvironmentErrorSchema.safeParse(error);
        // RPC 响应失败也可能已落盘；先读 owner，再保留原始结构化诊断。
        try {
          await readSnapshot(source);
        } catch {
          /* 刷新失败不能吞掉动作的原始错误。 */
        }
        update(source, {
          error: getErrorMessage(error),
          diagnostic: parsed.success ? parsed.data : undefined,
        });
        return false;
      } finally {
        if (source.pending === label) {
          source.pending = null;
          update(source, { pending: null });
        }
      }
    },
    [readSnapshot, update],
  );
  const prepare = (operation: "prepare" | "upgrade" | "restore" = "prepare", retry = false) => {
    if (!environmentActionAvailable(current.capabilities, "prepare")) return Promise.resolve(false);
    return perform(operation, async (source) => {
      const environment = source.snapshot?.environment;
      const request =
        (retry || (operation === "upgrade" && restoredRequest)) && source.request
          ? source.request
          : {
              workspacePath,
              ...(workspaceIdentity ? { workspaceIdentity } : {}),
              requestId: crypto.randomUUID(),
              bindingId,
              environmentId: source.environmentId,
              purpose,
              operation,
              expectedRevision: environment?.currentRevision,
              expectedManifestDigest: environment?.manifestDigest,
            };
      // 失败重试沿原 requestId 和冻结参数；cancelled 后新提交才创建新请求。
      source.request = request;
      const result = await source.service!.prepare(request);
      source.environmentId = result.environmentId;
      update(source, { operation: result });
    });
  };
  const cancel = () =>
    perform(
      "cancel",
      async (source) => {
        if (!source.request) return;
        const operation = await source.service!.prepare({ ...source.request, cancel: true });
        source.environmentId = operation.environmentId;
        update(source, { operation });
      },
      true,
    );
  const serviceAction = (action: "start" | "stop" | "restart", serviceId: string) => {
    if (
      !environmentActionAvailable(
        current.capabilities,
        action === "start" ? "startService" : "stopService",
      ) ||
      (action === "restart" && !environmentActionAvailable(current.capabilities, "startService"))
    )
      return Promise.resolve(false);
    return perform(`${action}:${serviceId}`, async (source) => {
      let environment = source.snapshot?.environment;
      if (!environment) throw new Error("environment-unavailable");
      const run = async (kind: "start" | "stop", fact: RuntimeEnvironmentProjection) => {
        const params = {
          workspacePath,
          ...(workspaceIdentity ? { workspaceIdentity } : {}),
          requestId: crypto.randomUUID(),
          environmentId: fact.environmentId,
          serviceId,
          expectedRevision: fact.currentRevision,
          expectedGeneration: fact.services?.find((item) => item.serviceId === serviceId)
            ?.generation,
        };
        const result = await (kind === "start"
          ? source.service!.startService(params)
          : source.service!.stopService(params));
        if (["failed", "blocked", "needsRestart"].includes(result.status))
          throw new Error(result.reason ?? result.status);
        return result;
      };
      if (action !== "start") {
        await run("stop", environment);
        if (action === "stop") return;
        environment = (await readSnapshot(source)) ?? undefined;
        // stop 收据和最新快照共同确认；不定时猜测进程已退出，也不把旧 generation 用于重启。
        if (
          owner.current !== source ||
          !environment ||
          environment.services?.find((item) => item.serviceId === serviceId)?.state !== "stopped"
        )
          throw new Error("service-stop-unconfirmed");
      }
      if (owner.current === source) await run("start", environment);
    });
  };
  const scan = () =>
    environmentActionAvailable(current.capabilities, "resourceSummary")
      ? perform("scan", async (source) => {
          await source.service!.resourceSummary({
            workspacePath,
            ...(workspaceIdentity ? { workspaceIdentity } : {}),
            environmentId: source.environmentId,
            requestId: crypto.randomUUID(),
            budget: scanBudget,
          });
        })
      : Promise.resolve(false);
  return {
    ...current,
    environment: current.snapshot?.environment,
    prepare,
    cancel,
    serviceAction,
    scan,
    refresh,
    retry: () => prepare(owner.current.request?.operation ?? "prepare", true),
    canCancel: Boolean(
      owner.current.request &&
      ((current.pending && current.pending !== "cancel") ||
        target.binding?.status === "updating" ||
        current.operation?.status === "running" ||
        current.snapshot?.environment?.operation?.status === "running"),
    ),
    canRetry: Boolean(
      owner.current.request &&
      current.operation?.status !== "cancelled" &&
      current.snapshot?.environment?.status !== "cancelled",
    ),
    isRemoteTarget: resolution.isRemoteTarget,
  };
}
