import { respondToWorkspaceHookReview } from "./workspace-hook-review-response.js";
import { SessionEventType, type WorkspaceHookBundleSnapshot } from "@lcode/contracts";
import {
  WorkspaceHookReviewFlowRegistry,
  createWorkspaceHookTrustRecords,
  type WorkspaceHookReviewFlow,
  type WorkspaceHookReviewTarget,
  type WorkspaceHookRuntimeAdmissionPort,
  type WorkspaceHookSnapshotEvaluation,
  type WorkspaceHookTrustCoordinator,
} from "@lcode/core";
import type {
  WorkspaceHookReviewDecision,
  WorkspaceHookReviewRequestPayload,
  WorkspaceHookTrustRevokeTarget,
} from "@lcode/shared/lcode-protocol-v4";
import type {
  WorkspaceHookReviewCommandResult,
  WorkspaceHookReviewControllerOptions,
  WorkspaceHookReviewHostPort,
  WorkspaceHookReviewMutationPort,
  WorkspaceHookTrustStoreMutationPort,
} from "./workspace-hook-review-types.js";
import {
  buildWorkspaceHookReviewRequest,
  resolveWorkspaceHookReviewDigests,
  toWorkspaceHookReviewTarget,
} from "./workspace-hook-review-request.js";
import { WorkspaceHookReviewTelemetry } from "./workspace-hook-review-telemetry.js";
import { superviseWorkspaceHookReviewFlow } from "./workspace-hook-review-supervisor.js";
import { applyWorkspaceHookRevoke } from "./workspace-hook-review-revoke.js";
import { toggleWorkspaceHookReviewItem } from "./workspace-hook-review-toggle.js";

export type * from "./workspace-hook-review-types.js";

export class WorkspaceHookReviewController {
  private readonly admission: WorkspaceHookRuntimeAdmissionPort;
  private readonly appVersion?: string;
  private readonly coordinator: WorkspaceHookTrustCoordinator;
  private readonly host: WorkspaceHookReviewHostPort;
  private readonly telemetry: WorkspaceHookReviewTelemetry;
  private readonly mutation: WorkspaceHookReviewMutationPort;
  private readonly sessionId: string;
  private readonly store: Promise<WorkspaceHookTrustStoreMutationPort>;
  private readonly now: () => number;
  private readonly createId: () => string;
  private readonly registry = new WorkspaceHookReviewFlowRegistry();
  /** flow → 监管 promise。WeakMap 使 flow 被回收后自动移除，不额外持有引用。 */
  private readonly supervisedFlows = new WeakMap<WorkspaceHookReviewFlow, Promise<void>>();
  private reviewFlowId?: string;
  private generation = 0;
  private mutationQueue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkspaceHookReviewControllerOptions) {
    this.admission = options.admission;
    this.appVersion = options.appVersion;
    this.coordinator = options.coordinator;
    this.host = options.host;
    this.telemetry = new WorkspaceHookReviewTelemetry(this.admission, options.logger);
    this.mutation = options.mutation;
    this.sessionId = options.sessionId;
    this.store = options.store;
    this.now = options.now ?? Date.now;
    this.createId = options.createId ?? (() => crypto.randomUUID());
  }

  /**
   * 见 workspace-hook-review-supervisor：任何新开 flow 都必须交由它监管。
   *
   * openOrReuseFlow 会复用仍 pending 的同一 flow
   * 对象，因此重复 requestReview 与 revoke 重开路径可能给同一个 flow 各挂一个 supervisor，
   * timeout 时重复 emit ReviewSettled。重复监管与缺监管同病：
   * 按 flow 对象单例化，重复请求直接复用已有的监管 promise。
   */
  private superviseFlow(flow: WorkspaceHookReviewFlow): Promise<void> {
    const existing = this.supervisedFlows.get(flow);
    if (existing) return existing;
    const supervision = superviseWorkspaceHookReviewFlow({
      flow,
      host: this.host,
      registry: this.registry,
      sessionId: this.sessionId,
      telemetry: this.telemetry,
    });
    this.supervisedFlows.set(flow, supervision);
    return supervision;
  }

  /**
   * 软门禁:按需开审核 flow。
   *
   * 用户点击「去审核」时经 requestWorkspaceHookReview 命令调用。
   * 无 pending 项时为安全 no-op(返回 accepted)。
   * 已有活跃 flow 时幂等复用(openOrReuseFlow)。
   * 必须经 superviseFlow 监管——否则 flow 超时后会静默死亡、面板永久失效。
   */
  async requestReview(target: {
    workspaceIdentity: string;
    bundleDigest: string;
  }): Promise<WorkspaceHookReviewCommandResult> {
    const snapshot = this.admission.getCurrentSnapshot();
    if (
      target.workspaceIdentity !== snapshot.workspaceIdentity ||
      target.bundleDigest !== snapshot.bundleDigest
    ) {
      return {
        accepted: false,
        reasonCode: "workspace_hooks_snapshot_mismatch" as const,
      };
    }
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
    // 旧实现只把 configuredEnabled=true 的 pending 当成可审核项，导致
    // Settings 把未信任开关锁定后形成死锁——disabled Hook 不会运行、不会触发 Banner，
    // 也永远无法预先建立 Trust。配置 gate 与 Trust 正交；review request 本就携带全部
    // snapshot items，因此按 admissionClass 判断即可，disabled item 信任后仍不会运行。
    const hasPending = evaluation.items.some((item) => item.admissionClass === "pending");
    if (!hasPending) {
      if (evaluation.items.some((item) => item.trustState === "blocked_policy")) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_blocked_by_policy" as const,
        };
      }
      if (evaluation.storeStatus === "corrupt") {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_trust_store_corrupt" as const,
        };
      }
      // 无待审项:安全 no-op
      return { accepted: true, reviewItemIds: [] };
    }
    const flow = await this.openOrReuseFlow(snapshot, evaluation);
    void this.superviseFlow(flow).catch(() => undefined);
    return { accepted: true, reviewItemIds: [] };
  }

  respond(
    target: WorkspaceHookReviewTarget,
    decision: WorkspaceHookReviewDecision,
  ): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(() =>
      respondToWorkspaceHookReview(
        {
          admission: this.admission,
          coordinator: this.coordinator,
          host: this.host,
          registry: this.registry,
          telemetry: this.telemetry,
          sessionId: this.sessionId,
          applyPersistentTrust: (ids) => this.applyPersistentTrust(ids),
          emitAdmissionUpdatedAfterMutation: () => this.emitAdmissionUpdatedAfterMutation(),
          refreshPendingFlow: (snapshot) => this.refreshPendingFlow(snapshot),
        },
        target,
        decision,
      ),
    );
  }

  toggle(
    target: WorkspaceHookReviewTarget,
    reviewItemId: string,
    enabled: boolean,
  ): Promise<WorkspaceHookReviewCommandResult & { request?: WorkspaceHookReviewRequestPayload }> {
    return this.enqueueMutation(() =>
      toggleWorkspaceHookReviewItem(
        {
          admission: this.admission,
          mutation: this.mutation,
          host: this.host,
          registry: this.registry,
          telemetry: this.telemetry,
          emitAdmissionUpdatedAfterMutation: () => this.emitAdmissionUpdatedAfterMutation(),
          refreshPendingFlow: (snapshot) => this.refreshPendingFlow(snapshot),
        },
        target,
        reviewItemId,
        enabled,
      ),
    );
  }

  revoke(
    target: WorkspaceHookReviewTarget,
    reviewItemIds: readonly string[],
  ): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const validation = this.registry.validate(target, {
        action: "trust_selected",
        reviewItemIds: [...reviewItemIds],
      });
      if (!validation.accepted) return validation;
      const snapshot = this.admission.getCurrentSnapshot();
      const result = await applyWorkspaceHookRevoke({
        coordinator: this.coordinator,
        digests: resolveWorkspaceHookReviewDigests(snapshot, validation.reviewItemIds),
        reviewItemIds: validation.reviewItemIds,
        snapshot,
        store: this.store,
      });
      if (result.accepted) {
        this.telemetry.revoked(snapshot.bundleDigest, validation.reviewItemIds.length);
        await this.refreshPendingFlow(snapshot);
        // 软门禁:revoke 后重新评估 pending 状态
        await this.emitAdmissionUpdatedAfterMutation();
      }
      return result;
    });
  }

  revokeCurrent(target: WorkspaceHookTrustRevokeTarget): Promise<WorkspaceHookReviewCommandResult> {
    return this.enqueueMutation(async () => {
      const snapshot = this.admission.getCurrentSnapshot();
      if (
        target.sessionId !== this.sessionId ||
        target.remoteSessionId !== this.host.remoteSessionId ||
        target.workspaceIdentity !== snapshot.workspaceIdentity ||
        target.bundleDigest !== snapshot.bundleDigest
      ) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      const digests = [...new Set(target.hookDeclarationDigests)];
      const entries = snapshot.hooks.filter((entry) =>
        digests.includes(entry.hookDeclarationDigest),
      );
      if (
        digests.length === 0 ||
        new Set(entries.map((entry) => entry.hookDeclarationDigest)).size !== digests.length
      ) {
        return {
          accepted: false,
          reasonCode: "workspace_hooks_snapshot_mismatch" as const,
        };
      }
      const result = await applyWorkspaceHookRevoke({
        coordinator: this.coordinator,
        digests,
        reviewItemIds: entries.map((entry) => entry.reviewItemId),
        snapshot,
        store: this.store,
      });
      if (result.accepted) {
        this.telemetry.revoked(snapshot.bundleDigest, digests.length);
        await this.refreshPendingFlow(snapshot);
        // 软门禁:revokeCurrent 后重新评估 pending 状态
        await this.emitAdmissionUpdatedAfterMutation();
      }
      return result;
    });
  }

  private async refreshPendingFlow(
    snapshot: WorkspaceHookBundleSnapshot,
  ): Promise<WorkspaceHookReviewFlow | undefined> {
    const current = this.registry.getCurrentFlow(this.sessionId);
    if (!current || current.state.state !== "pending") {
      // 无 pending flow 时直接返回会让
      // 「授权 → review resolved → 撤销」之后，当前会话再没有任何重新授权入口，
      // 用户只能新建对话。
      //
      // revoke 的语义是 revoked → admission=pending，本就应重新征询，
      // 因此这里在确实产生了待审项时开启新 flow：不新增「直接授予信任」的旁路，
      // 授权仍只能经当前不可变 review 绑定的行内按钮完成。
      return await this.openReviewFlowForNewPendingItems(snapshot);
    }
    const target = toWorkspaceHookReviewTarget(current.request);
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
    const replacement = this.buildRequest(snapshot, evaluation, {
      reviewFlowId: current.request.reviewFlowId,
      generation: current.request.generation + 1,
    });
    const nextFlow = this.registry.supersede(target, replacement);
    this.telemetry.superseded(replacement);
    this.generation = replacement.generation;
    await this.host.emit({
      type: SessionEventType.WorkspaceHookReviewSuperseded,
      payload: {
        interactionId: current.request.interactionId,
        supersededByInteractionId: replacement.interactionId,
      },
    });
    this.telemetry.requestCreated(replacement);
    await this.host.emit({
      type: SessionEventType.WorkspaceHookReviewRequested,
      payload: { request: replacement },
    });
    if (replacement.summary.pendingCount === 0) {
      this.registry.closeWithoutDecision(toWorkspaceHookReviewTarget(replacement));
      await this.host.emit({
        type: SessionEventType.WorkspaceHookReviewSettled,
        payload: {
          interactionId: replacement.interactionId,
          state: "resolved",
        },
      });
    }
    return nextFlow;
  }

  /**
   * revoke 之后当前会话没有 pending flow 时，重新开启审核。
   *
   * 只在真的存在待审项时开启。开关只控制运行，信任只控制准入；因此当前审核
   * 快照中的 configured-disabled 声明也必须保留行内信任入口。开启走
   * openOrReuseFlow，与首次征询同一条路径，因此 generation / reviewFlowId /
   * interactionId 的既有语义不变。
   */
  private async openReviewFlowForNewPendingItems(
    snapshot: WorkspaceHookBundleSnapshot,
  ): Promise<WorkspaceHookReviewFlow | undefined> {
    const evaluation = this.coordinator.evaluateSnapshot({
      snapshot,
    });
    const hasPending = evaluation.items.some((item) => item.admissionClass === "pending");
    if (!hasPending) return undefined;
    const flow = await this.openOrReuseFlow(snapshot, evaluation);
    // 必须监管：否则该 flow 超时后静默死亡，面板永久失效（见 superviseFlow 注释）。
    // 这里刻意不 await——revoke 命令不能被 10 分钟的审核 deadline 阻塞；
    // catch 兜底避免未处理拒绝，flow 终结本身不产生需要向调用方冒泡的错误。
    void this.superviseFlow(flow).catch(() => undefined);
    return flow;
  }

  private async openOrReuseFlow(
    snapshot: WorkspaceHookBundleSnapshot,
    evaluation: WorkspaceHookSnapshotEvaluation,
  ): Promise<WorkspaceHookReviewFlow> {
    const current = this.registry.getCurrentFlow(this.sessionId);
    if (
      current?.state.state === "pending" &&
      current.request.bundleDigest === snapshot.bundleDigest
    ) {
      return current;
    }
    this.reviewFlowId ??= `workspace-hook-review:${this.createId()}`;
    const request = this.buildRequest(snapshot, evaluation, {
      reviewFlowId: this.reviewFlowId,
      generation: this.generation + 1,
    });
    this.generation = request.generation;
    const flow = this.registry.open(request);
    this.telemetry.requestCreated(request);
    await this.host.emit({
      type: SessionEventType.WorkspaceHookReviewRequested,
      payload: { request },
    });
    return flow;
  }

  private buildRequest(
    snapshot: WorkspaceHookBundleSnapshot,
    evaluation: WorkspaceHookSnapshotEvaluation,
    flow: { reviewFlowId: string; generation: number },
  ): WorkspaceHookReviewRequestPayload {
    return buildWorkspaceHookReviewRequest({
      snapshot,
      evaluation,
      ...flow,
      sessionId: this.sessionId,
      host: this.host,
      now: this.now,
      createId: this.createId,
    });
  }

  private async applyPersistentTrust(
    reviewItemIds: readonly string[],
  ): Promise<{ grantedRecordCount?: number }> {
    const snapshot = this.admission.getCurrentSnapshot();
    this.coordinator.assertPersistentTrustMutationAllowed(snapshot.workspaceIdentity);
    const records = createWorkspaceHookTrustRecords({
      snapshot,
      reviewItemIds,
      grantedAt: new Date(this.now()).toISOString(),
      ...(this.appVersion ? { appVersion: this.appVersion } : {}),
    });
    const file = await (await this.store).grant(records);
    this.coordinator.replacePersistentTrustRecords(file.records, {
      status: "ok",
    });
    return { grantedRecordCount: records.length };
  }

  private enqueueMutation<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.mutationQueue.then(operation, operation);
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /**
   * 软门禁:mutation 完成后重新评估 pending 状态并发射 AdmissionUpdated。
   *
   * 口径与 admission 一致:configuredEnabled && admissionClass === "pending"。
   * pendingCount === 0 也要发,投影据此清空提示条。
   * 通过 admission 的 invalidate → 触发 evaluateDispatch 内的 refreshEvaluation;
   * 这里直接用 coordinator 重新评估快照,与 admission.emitAdmissionState 同源。
   */
  private async emitAdmissionUpdatedAfterMutation(): Promise<void> {
    const snapshot = this.admission.getCurrentSnapshot();
    const evaluation = this.coordinator.evaluateSnapshot({ snapshot });
    const pendingCount = evaluation.items.filter(
      (item) => item.configuredEnabled && item.admissionClass === "pending",
    ).length;
    await this.host.emit({
      type: SessionEventType.WorkspaceHookAdmissionUpdated,
      payload: {
        pendingCount,
        bundleDigest: snapshot.bundleDigest,
        ...(snapshot.workspaceIdentity ? { workspaceIdentity: snapshot.workspaceIdentity } : {}),
      },
    });
  }
}
