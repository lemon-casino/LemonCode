/**
 * ask 调度器：把"每 actor FIFO + hold 规则 + 并发上限派发 + ask 结算"从引擎主体拆出，
 * 使两个文件都聚焦、可读（并满足单文件行数上限）。引擎通过 {@link SchedulerHost} 注入其
 * 依赖（driver、caps、序号分配、run 级失败），调度器只负责 ask 生命周期，不管 run 生命周期。
 *
 * 关键规则见 engine.ts 顶部说明：命中短路、actorSeq 准入顺序、replay 的 hold 规则、串行 actor。
 *
 * 内部类型与 SchedulerHost 在 scheduler-types.ts；submit / turn 的向上回报处理在 scheduler-submit.ts
 * （拆分原因：oxlint max-lines 上限 400 行）。SchedulerHost 在此原地再导出，导入路径不变。
 */

import { inputHash } from "./hash.js";
import type { ImportedActorState } from "./imported-cache.js";
import { applyTaskSupplement, nodeRecordFor, releaseCachedAsk, settleImportedAsk } from "./scheduler-cached.js";
import { describeCause, hashMismatch, headOfInstructions } from "./scheduler-helpers.js";
import { recoverInstanceAttempt } from "./ask-control-recovery.js";
import { defer, type Actor, type AskNode, type Deferred, type SchedulerHost } from "./scheduler-types.js";
import { handleSubmitAttempted, handleTurnEnded, type SubmitSeam } from "./scheduler-submit.js";
import type {
  ActorId,
  ActorRef,
  AskMessage,
  AskSpec,
  AskStats,
  InstanceRef,
  JournalStorePort,
  PersonaSpec,
  SessionRef,
  WorkflowImageRef,
} from "./types.js";
import {
  NUDGE_ATTEMPTS,
  refToString,
  REPAIR_ATTEMPTS,
  WorkflowError,
} from "./types.js";

export type { SchedulerHost } from "./scheduler-types.js";
export { hashMismatch } from "./scheduler-helpers.js";

export class AskScheduler {
  private readonly actors = new Map<ActorId, Actor>();
  private readonly actorOrder: Actor[] = [];
  private readonly liveNodes = new Map<string, AskNode>();
  private readonly settledAttempts = new Map<string, number>();
  private activeAsks = 0;

  /** scheduler-submit.ts 的自由函数经它查 live 节点、按结果结算（见 {@link SubmitSeam}）。 */
  private readonly submitSeam: SubmitSeam;

  constructor(private readonly host: SchedulerHost) {
    this.submitSeam = {
      host,
      liveNode: (instance) => {
        const node = this.currentAttempt(instance);
        return node?.paused ? undefined : node;
      },
      settleOk: (node, artifact) => this.settleOk(node, artifact),
      settleFailed: (node, error) => this.settleFailed(node, error),
    };
  }

  private get journal(): JournalStorePort {
    return this.host.driver.journal;
  }

  hasActor(id: ActorId): boolean {
    return this.actors.has(id);
  }

  /**
   * 注册一个 actor（创建站点 × 序号）。`imported` 是 amend-resume 的导入候选：引擎已在
   * createActor 里按有效名 + 规范化 persona 匹配过，调度器只负责消费它。
   */
  registerActor(
    ref: ActorRef,
    id: ActorId,
    name: string | undefined,
    persona: PersonaSpec,
    imported?: ImportedActorState,
  ): Actor {
    const recordedCount = this.journal
      .listNodes(this.host.runId)
      .filter((n) => n.kind === "ask" && n.actorSiteId === ref.siteId && n.actorOrdinal === ref.ordinal).length;
    const actor: Actor = {
      ref,
      id,
      persona,
      name,
      recordedCount,
      nextAdmitSeq: 0,
      pendingRecorded: new Map(),
      pendingLive: [],
      liveQueue: [],
      ...(imported === undefined ? {} : { imported }),
    };
    // 不能把 journal 记录的 sessionId 预解析成 actor.session/sessionPromise：
    // 让 resume 后的 ensureSession 跳过 driver.createActorSession。但生产 driver 的会话表
    // **只**在 createActorSession 里填充，startAsk 按表查会话——于是 resume 重新派发的每个
    // ask 都以「未知会话」失败。纯 replay（零派发）与 fake driver（startAsk 不查表）都暴露
    // 不了它。会话身份本就归 driver 所有（生产铸造函数按 (runId, actorRef) 纯确定，重挂时
    // 铸出同一个 id）；journal 的 dwf_actor.session_id 是记录、不是权威，所以这里绝不从
    // journal 短路会话——首次派发一律走 driver.createActorSession（见 ensureSession）。
    this.actors.set(id, actor);
    this.actorOrder.push(actor);
    return actor;
  }

  /** 受理一次 ask：完结命中短路（走 hold 规则），running 命中或未命中则 live 派发。 */
  admitAsk(siteId: string, actorId: ActorId, instructions: string, spec: AskSpec): Promise<unknown> {
    const actor = this.actors.get(actorId)!;
    const ordinal = this.host.nextOrdinal(siteId);
    const instance: InstanceRef = { siteId, ordinal };
    const admittedInstructions = this.host.instructionsForAdmission(instance, instructions);
    const admittedAttachments = this.host.attachmentsForAdmission(instance);
    const hash = inputHash(admittedInstructions + (admittedAttachments?.length ? JSON.stringify(admittedAttachments) : ""));
    const deferred = defer<unknown>();

    const recorded = this.journal.getNode(this.host.runId, siteId, ordinal);
    if (recorded !== undefined) {
      // 命中即防御性校验 inputHash——不一致说明纯度契约被破坏，run 大声失败。
      if (recorded.inputHash !== hash) {
        const err = hashMismatch(instance, recorded.inputHash, hash);
        this.host.failRun(err);
        return Promise.reject(err);
      }
      const seq = recorded.actorSeq ?? 0;
      if (recorded.status === "running") {
        // 崩溃于执行中：按记录的 actorSeq 位置重新 live 派发（hold 规则保证其准入次序）。
        actor.pendingRecorded.set(seq, () => {
          actor.imported?.reconcileRecorded(seq, recorded.inputHash, this.host.wasLiveBeforeResume(instance));
          if (this.host.invalidatesImportedAsk(instance)) actor.imported?.invalidate();
          const controlState = this.host.resumeAskControlState(instance);
          this.admitLive(
            recoverInstanceAttempt(instance, controlState),
            actor,
            seq,
            admittedInstructions,
            hash,
            spec,
            deferred,
            controlState?.paused === true,
            controlState?.supplement,
            controlState?.attachments ?? admittedAttachments,
          );
        });
      } else {
        // completed / failed：短路结算，无 driver 调用。
        actor.pendingRecorded.set(seq, () => {
          actor.imported?.reconcileRecorded(seq, recorded.inputHash, this.host.wasLiveBeforeResume(instance));
          releaseCachedAsk(this.host, instance, recorded, deferred);
        });
      }
      this.drainAdmission(actor);
      return deferred.promise;
    }

    // 未命中（fresh）：注册到 pendingLive，按到达顺序在记录节点排空后准入并分配新的 actorSeq。
    // 分配到 seq 之后先问导入缓存（amend-resume）：命中即 cached settle，不 live。
    actor.pendingLive.push(() => {
      const seq = actor.nextAdmitSeq++;
      if (settleImportedAsk({ instance, actor, seq, hash, deferred, host: this.host })) return;
      this.admitLive(instance, actor, seq, admittedInstructions, hash, spec, deferred, false, undefined, admittedAttachments);
    });
    this.drainAdmission(actor);
    this.pumpAll();
    return deferred.promise;
  }

  /** 把一个 ask 作为 live 节点准入：建节点、准入即落 running 记录、入队并记事件。 */
  private admitLive(
    instance: InstanceRef,
    actor: Actor,
    seq: number,
    instructions: string,
    hash: string,
    spec: AskSpec,
    deferred: Deferred<unknown>,
    paused = false,
    supplement?: string,
    attachments?: WorkflowImageRef[],
  ): void {
    const effectiveInstructions = applyTaskSupplement(instructions, supplement);
    const node: AskNode = {
      instance,
      actor,
      actorSeq: seq,
      originalInstructions: instructions,
      instructions: effectiveInstructions,
      ...(supplement === undefined ? {} : { supplement }),
      ...(attachments === undefined ? {} : { attachments }),
      hash,
      spec,
      deferred,
      repairsRemaining: REPAIR_ATTEMPTS,
      nudgesRemaining: NUDGE_ATTEMPTS,
      settled: false,
      dispatched: false,
      ...(paused ? { paused: true } : {}),
    };
    this.liveNodes.set(refToString(instance), node);
    // 准入即落 running（携 actorSeq + inputHash）：崩溃于执行中的节点 resume 可据此重新派发。
    this.journal.putNode({
      runId: this.host.runId,
      siteId: instance.siteId,
      ordinal: instance.ordinal,
      kind: "ask",
      actorSiteId: actor.ref.siteId,
      actorOrdinal: actor.ref.ordinal,
      actorSeq: seq,
      inputHash: hash,
      status: "running",
    });
    if (paused) actor.paused = node;
    else actor.liveQueue.push(node);
    // 指令开头随出生事件一起落轨：这里的 instructions 还是
    // 作者的原文——driver 的质量 / schema 尾注在 startAsk 里才追加，所以摘要里不会混进引擎的话。
    const instructionsHead = headOfInstructions(instructions);
    this.host.record({
      type: "node-queued",
      instance,
      kind: "ask",
      actor: actor.ref,
      actorSeq: seq,
      ...(instructionsHead === undefined ? {} : { instructionsHead }),
    });
    // 冷恢复不能把用户已停止的任务自动派发；补发状态事件让实时投影与 journal 真相一致。
    if (paused) this.host.record({ type: "node-paused", instance });
    // 转 live **不**关导入缓存。曾经在这里关：任一 ask live
    // 即视为工作区可能被改写。那是拿时钟代替依赖——同一个 Promise.all 里排在第一个未命中之后的
    // 兄弟 ask 全被判失效，而它们之间没有任何依赖（实测 50 路扇出丢 6 个命中，5 路扇出
    // 丢掉唯一的 1 个）。现在关门的是**第一笔写入**：driver 在子代理即将执行改写工具时上报
    // askMutating，或一条 world.run live 执行；在此之前的世界与前驱留下的世界相同，缓存命中都成立。
  }

  // ——————————————————————————————— 向上回报 ———————————————————————————————

  /** submit_result 到达：方法体在 scheduler-submit.ts 的 handleSubmitAttempted。 */
  submitAttempted(instance: InstanceRef, payload: unknown): void {
    handleSubmitAttempted(this.submitSeam, instance, payload);
  }

  /** turn 结束（无 submit）：方法体在 scheduler-submit.ts 的 handleTurnEnded。 */
  turnEnded(instance: InstanceRef, finalText: string): void {
    handleTurnEnded(this.submitSeam, instance, finalText);
  }

  noteStats(instance: InstanceRef, stats: AskStats): void {
    const key = refToString(instance);
    const node = this.liveNodes.get(key);
    if (node !== undefined) {
      if (node.paused || (node.instance.attempt ?? 1) !== (instance.attempt ?? 1)) return;
      node.lastStats = stats;
      return;
    }
    // 节点已离开 liveNodes——typed-accept 主导路径：submit 停 turn 并在 settle 时落库，而真实
    // actor 的用量在 turn 解析后（submit 之后）才知道，故 stats 在结算之后才到达。回填已结算的
    // journal 记录：只新增/覆写 stats，保留 status/result/actorSeq/inputHash/error/kind/actor 身份。
    // 尽力而为且幂等；预算扣减仍在 engine.askStats（此处只补 journal 完整性）。
    // 旧 turn 的用量仍由 engine 累计，但不能覆盖新尝试的节点统计。
    const settledAttempt = this.settledAttempts.get(key);
    if (settledAttempt !== undefined && settledAttempt !== (instance.attempt ?? 1)) return;
    const recorded = this.journal.getNode(this.host.runId, instance.siteId, instance.ordinal);
    if (recorded === undefined) return;
    this.journal.putNode({ ...recorded, stats });
  }

  failed(instance: InstanceRef, error: WorkflowError): void {
    const node = this.currentAttempt(instance);
    if (node === undefined || node.settled || node.paused) return;
    this.settleFailed(node, error);
  }

  /** 该实例是否仍是在飞（已准入、未结算）的 live ask——限流观察事件只对这样的节点有意义。 */
  isLive(instance: InstanceRef): boolean {
    const node = this.currentAttempt(instance);
    return node !== undefined && !node.settled && !node.paused;
  }

  /** 在飞 ask 所属子代理的有效名（关门事件里点名用）；不在飞即 undefined。 */
  liveActorName(instance: InstanceRef): string | undefined {
    const node = this.currentAttempt(instance);
    return node === undefined || node.settled || node.paused ? undefined : node.actor.persona.name;
  }

  /** 中止所有在飞 ask：run 取消/失败时用。emitCancelled 为真时补发 node-settled(cancelled)。 */
  abortInFlight(error: WorkflowError, emitCancelled: boolean): void {
    for (const node of this.liveNodes.values()) {
      if (node.settled) continue;
      node.settled = true;
      if (node.dispatched) this.host.driver.cancelAsk(node.instance);
      if (emitCancelled) {
        this.host.record({ type: "node-settled", instance: node.instance, outcome: "cancelled" });
      }
      node.deferred.reject(error);
    }
    this.liveNodes.clear();
    this.activeAsks = 0;
    for (const actor of this.actorOrder) actor.paused = undefined;
  }

  /** 只暂停目标 ask；原 deferred 不结算，依赖它的脚本分支自然等待。 */
  pauseAsk(instance: InstanceRef): boolean {
    const node = this.currentAttempt(instance);
    if (node === undefined || node.paused || this.host.isRunSettled()) return false;
    // 先标记代次、再中断 turn：同步到来的旧回报会看到 paused，不能结算新尝试。
    node.paused = true;
    if (node.dispatched) this.host.driver.cancelAsk(node.instance);
    if (node.actor.current === node) {
      node.actor.current = undefined;
      this.activeAsks--;
    } else {
      node.actor.liveQueue = node.actor.liveQueue.filter((queued) => queued !== node);
    }
    node.actor.paused = node;
    this.host.record({ type: "node-paused", instance: node.instance });
    this.pumpAll();
    return true;
  }

  /** 复用同一个脚本 promise，另起一个有代次的尝试；旧尝试的回报会被 currentAttempt 丢弃。 */
  retryAsk(instance: InstanceRef, supplement?: string, attachments?: WorkflowImageRef[]): boolean {
    const node = this.currentAttempt(instance);
    if (node === undefined || !node.paused || this.host.isRunSettled()) return false;
    const revision = supplement?.trim();
    if (revision) {
      node.supplement = node.supplement === undefined
        ? revision
        : `${node.supplement}\n\n${revision}`;
    }
    if (attachments?.length) node.attachments = [...(node.attachments ?? []), ...attachments];
    node.instructions = applyTaskSupplement(node.originalInstructions, node.supplement);
    node.instance = { siteId: instance.siteId, ordinal: instance.ordinal, attempt: (node.instance.attempt ?? 1) + 1 };
    node.paused = false;
    node.dispatched = false;
    node.repairsRemaining = REPAIR_ATTEMPTS;
    node.nudgesRemaining = NUDGE_ATTEMPTS;
    node.actor.paused = undefined;
    node.actor.liveQueue.unshift(node);
    this.host.record({
      type: "node-retried",
      instance: node.instance,
      ...(node.supplement === undefined ? {} : { supplement: node.supplement }),
      ...(node.attachments === undefined ? {} : { attachments: node.attachments }),
    });
    this.pumpActor(node.actor);
    return true;
  }

  private currentAttempt(instance: InstanceRef): AskNode | undefined {
    const node = this.liveNodes.get(refToString(instance));
    return node !== undefined && (node.instance.attempt ?? 1) === (instance.attempt ?? 1)
      ? node
      : undefined;
  }

  // ——————————————————————————————— 内部：准入 / 派发 ———————————————————————————————

  private drainAdmission(actor: Actor): void {
    let progressed = true;
    while (progressed) {
      progressed = false;
      const release = actor.pendingRecorded.get(actor.nextAdmitSeq);
      if (release !== undefined) {
        actor.pendingRecorded.delete(actor.nextAdmitSeq);
        actor.nextAdmitSeq++;
        release();
        progressed = true;
        continue;
      }
      if (actor.nextAdmitSeq >= actor.recordedCount && actor.pendingLive.length > 0) {
        const admit = actor.pendingLive.shift()!;
        admit();
        progressed = true;
      }
    }
    this.pumpActor(actor);
  }

  private pumpAll(): void {
    for (const actor of this.actorOrder) this.pumpActor(actor);
  }

  private pumpActor(actor: Actor): void {
    if (this.host.isRunSettled()) return;
    if (actor.paused !== undefined) return;
    if (actor.current !== undefined) return;
    if (actor.liveQueue.length === 0) return;
    if (this.activeAsks >= this.host.caps.maxConcurrency) return;
    const node = actor.liveQueue.shift()!;
    actor.current = node;
    this.activeAsks++;
    void this.dispatch(node);
  }

  private async dispatch(node: AskNode): Promise<void> {
    const attempt = node.instance.attempt ?? 1;
    let session: SessionRef;
    try {
      session = await this.ensureSession(node.actor);
    } catch (cause) {
      if (this.host.isRunSettled() || node.settled || node.paused ||
          (node.instance.attempt ?? 1) !== attempt) return;
      // 把 cause 的文本带进 message：WorkflowError.toJSON 只落 code/message，cause 不进 journal 也
      // 无人记日志，于是「创建 actor 会话失败」在 GUI / journal 里成了无法诊断的黑盒
      // （实机上底层其实是 session_task_link 的 FOREIGN KEY constraint failed）。
      this.settleFailed(
        node,
        new WorkflowError(
          "DriverError",
          `Failed to create the subagent session: ${describeCause(cause)}`,
          { cause },
        ),
      );
      return;
    }
    if (this.host.isRunSettled() || node.settled || node.paused ||
        (node.instance.attempt ?? 1) !== attempt || node.actor.current !== node) return;
    // node-dispatched 在会话就绪之后。进程级并发闸门
    // 不在这里：它按**模型请求**准入，住在 driver 之下的 runtime deps 里；调度器只守
    // per-run 的 ask 级上界。
    this.host.record({ type: "node-dispatched", instance: node.instance });
    node.dispatched = true;
    const message: AskMessage = {
      instructions: node.instructions,
      ...(node.attachments === undefined ? {} : { attachments: node.attachments }),
      typed: node.spec.typed,
      schema: node.spec.schema,
    };
    this.host.driver.startAsk(session, node.instance, message);
  }

  private ensureSession(actor: Actor): Promise<SessionRef> {
    if (actor.sessionPromise !== undefined) return actor.sessionPromise;
    // 种子只有到分歧点才知道（运行期发现），所以必须在这里、由引擎侧交给 driver——引擎持有
    // 导入态，driver 持有会话 store，这个签名是两者的最小汇合点。
    const seed = actor.imported?.seed();
    const promise = this.host.driver.createActorSession(actor.ref, actor.persona, seed).then((session) => {
      actor.session = session;
      // resolvedModel 由宿主侧的 runtime 工厂在 createActorSession **内部**写下（它才知道
      // "lite" 落到哪个模型）。putActor 是整条记录的替换，所以这条写入必须把刚写下的值读回来
      // 带过去，否则这里就会把它抹掉——档位解析的审计与 resume 依据随之丢失。
      const resolvedModel = this.journal.getActor(
        this.host.runId,
        actor.ref.siteId,
        actor.ref.ordinal,
      )?.resolvedModel;
      this.journal.putActor({
        runId: this.host.runId,
        siteId: actor.ref.siteId,
        ordinal: actor.ref.ordinal,
        name: actor.name,
        persona: actor.persona,
        sessionId: session.id,
        resolvedModel,
      });
      return session;
    });
    actor.sessionPromise = promise;
    return promise;
  }

  // ——————————————————————————————— 内部：结算 ———————————————————————————————

  private settleOk(node: AskNode, artifact: unknown): void {
    if (node.settled) return;
    node.settled = true;
    this.journal.putNode(nodeRecordFor(this.host, node, { status: "completed", result: artifact }));
    this.host.record({ type: "node-settled", instance: node.instance, outcome: "ok" });
    this.finishLiveNode(node);
    node.deferred.resolve(artifact);
  }

  private settleFailed(node: AskNode, error: WorkflowError): void {
    if (node.settled) return;
    node.settled = true;
    // 结算失败必须落 journal（覆盖准入时的 running）：失败是"完结"，且脚本可能已观察到该 rejection
    // 并据此分支，replay 必须复现它——journal 化失败是重放正确性的硬性要求，而非可选。
    this.journal.putNode(nodeRecordFor(this.host, node, { status: "failed", error: error.toJSON() }));
    this.host.record({ type: "node-settled", instance: node.instance, outcome: "failed", error: error.toJSON() });
    this.finishLiveNode(node);
    // 节点失败只 reject 该 ask，不失败整个 run（脚本可 try/catch）。
    node.deferred.reject(error);
  }

  private finishLiveNode(node: AskNode): void {
    this.settledAttempts.set(refToString(node.instance), node.instance.attempt ?? 1);
    this.liveNodes.delete(refToString(node.instance));
    if (node.actor.current === node) {
      node.actor.current = undefined;
      this.activeAsks--;
    }
    this.pumpAll();
  }

}
