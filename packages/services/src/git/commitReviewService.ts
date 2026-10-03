import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
  gitCommitReviewSelectionSchema,
  gitCommitReviewReadSchema,
  gitFileMutationJournalSchema,
  type GitCommitRequest,
  type GitCommitReview,
  type GitCommitResult,
  type GitFileMutationJournal,
  type Locale,
} from "@lcode/shared";
import { createServiceLogger } from "#src/logger/serviceLogger.js";
import { COMMIT_REVIEW_PROMPT_DATA_CHARS } from "./commitReviewModel.js";
import type { GitCommitMessageGenerator } from "./gitCommitMessageGenerator.js";
import {
  mergedSessionCommitPlan,
  planSessionCommits,
  type SessionCommitPlan,
} from "./commitReviewPlanner.js";
import type { CommitReviewRepo, CommitReviewSnapshot } from "./repo/commitReviewRepo.js";
import { normalizeInputPath } from "./repo/gitCliHelpers.js";

export type MutationJournalReader = (params: {
  workspacePath: string;
  workspaceIdentity?: string;
  paths: string[];
}) => Promise<GitFileMutationJournal>;
type ReviewRepo = Pick<
  CommitReviewRepo,
  "capture" | "describe" | "assertCurrent" | "commit" | "canonicalizeJournal"
> &
  Partial<Pick<CommitReviewRepo, "recoverCommit">>;
interface ReviewEntry {
  key: string;
  workspacePath: string;
  snapshot: CommitReviewSnapshot;
  plan: SessionCommitPlan;
  review: GitCommitReview;
  done: Map<string, GitCommitResult>;
  pending?: Promise<GitCommitResult>;
}
const key = (params: { workspacePath: string; workspaceIdentity?: string }) =>
  params.workspaceIdentity?.trim() || params.workspacePath;
const logger = createServiceLogger("git-commit-review");

export class CommitReviewService {
  private readonly entries = new Map<string, ReviewEntry>();
  constructor(
    private readonly repo: ReviewRepo,
    private readonly model: Pick<GitCommitMessageGenerator, "review"> | undefined,
    private readonly journal?: MutationJournalReader,
  ) {}

  async generate(params: {
    workspacePath: string;
    workspaceIdentity?: string;
    locale?: Locale;
    paths: string[];
    includeUnstaged: boolean;
  }) {
    if (!this.model) throw new Error("提交审核生成不可用，请选择可用模型。");
    const snapshot = await this.repo.capture(
      params.workspacePath,
      params.paths,
      params.includeUnstaged,
    );
    let journal: GitFileMutationJournal = { complete: false, mutations: [] };
    if (params.includeUnstaged && this.journal) {
      try {
        journal = gitFileMutationJournalSchema.parse(
          await this.journal({
            ...params,
            paths: snapshot.paths.map((path) => resolve(snapshot.resolution.repoRoot, path)),
          }),
        );
        journal.mutations = await Promise.all(
          journal.mutations.map(async (mutation) => ({
            ...mutation,
            path: await normalizeInputPath(snapshot.resolution, mutation.path),
          })),
        );
        journal = await this.repo.canonicalizeJournal(snapshot, journal);
      } catch {
        logger.warn(undefined, "提交修改证据不可用，转为合并审核");
        journal = { complete: false, mutations: [] };
      }
    }
    let plan = snapshot.hasModeChanges
      ? mergedSessionCommitPlan(snapshot.files, "unattributed-write")
      : planSessionCommits(snapshot.files, journal);
    let groups = await this.describe(plan);
    // 不能把截断的 diff 称为完整 AI 审核；大改动保守合并，明确要求人工读完冻结预览。
    if (
      JSON.stringify({ groups, warnings: plan.warnings }).length > COMMIT_REVIEW_PROMPT_DATA_CHARS
    ) {
      plan = mergedSessionCommitPlan(snapshot.files, "review-truncated");
      groups = await this.describe(plan);
    }
    const output = await this.model.review({
      ...params,
      groups,
      warnings: plan.warnings,
    });
    if (output.decision === "merge") {
      const priorWarnings = plan.warnings;
      plan = mergedSessionCommitPlan(snapshot.files, "ai-recommended-merge");
      plan.warnings.push(...priorWarnings);
      groups = await this.describe(plan);
      groups[0]!.message = output.mergedMessage;
    } else {
      for (const group of groups) {
        group.message = output.messages.find((item) => item.id === group.id)!.message;
        if (output.decision === "needsConfirmation" || output.warnings.length > 0)
          group.requiresConfirmation = true;
      }
    }
    const warnings = [...new Set([...plan.warnings, ...output.warnings])];
    const review: GitCommitReview = { id: randomUUID(), mode: plan.mode, groups, warnings };
    await this.repo.assertCurrent(snapshot);
    while (this.entries.size >= 16) {
      const oldest = [...this.entries].find(([, value]) => !value.pending)?.[0];
      if (!oldest) throw new Error("提交审核正在进行，请稍后重试。");
      this.entries.delete(oldest);
    }
    this.entries.set(review.id, {
      key: key(params),
      workspacePath: resolve(params.workspacePath),
      snapshot,
      plan,
      review,
      done: new Map(),
    });
    logger.info(undefined, "已生成冻结提交审核", { mode: review.mode, groupCount: groups.length });
    return {
      message: groups[0]!.message,
      providerId: output.providerId,
      model: output.model,
      review,
    };
  }

  private async describe(plan: SessionCommitPlan) {
    return Promise.all(
      plan.groups.map(async (group) => ({
        ...group,
        files: await this.repo.describe(group.files),
        message: "",
      })),
    );
  }

  read(params: { workspacePath: string; workspaceIdentity?: string; reviewId: string }) {
    params = gitCommitReviewReadSchema.parse(params);
    const entry = this.entries.get(params.reviewId);
    if (
      !entry ||
      entry.key !== key(params) ||
      entry.workspacePath !== resolve(params.workspacePath)
    )
      return null;
    const position = entry.review.groups.findIndex((group) => !entry.done.has(group.id));
    return {
      review: structuredClone(entry.review),
      position: position < 0 ? entry.review.groups.length : position,
    };
  }

  async commit(
    params: GitCommitRequest,
    assertBeforeCommit?: () => Promise<void>,
  ): Promise<GitCommitResult> {
    const selected = gitCommitReviewSelectionSchema.parse(params.review);
    const recovered = await this.repo.recoverCommit?.(params);
    if (recovered) return recovered;
    const entry = this.entries.get(selected.id);
    if (
      !entry ||
      entry.key !== key(params) ||
      entry.workspacePath !== resolve(params.workspacePath)
    )
      throw new Error("审核已失效或 workspace 不匹配，请重新生成。");
    const done = entry.done.get(selected.groupId);
    if (done) return done;
    if (entry.pending) {
      await entry.pending;
      return this.commit(params, assertBeforeCommit);
    }
    const next = entry.review.groups.find((group) => !entry.done.has(group.id));
    if (!next || next.id !== selected.groupId)
      throw new Error("必须按审核顺序提交，不能跳过依赖候选。");
    if (next.requiresConfirmation && !selected.acknowledged)
      throw new Error("请先确认已人工检查合并范围及 AI 警告。");
    const planned = entry.plan.groups.find((group) => group.id === next.id)!;
    // 中文依据：先记录 admission，再校验新提交的发布版本；已完成 review/group 重试必须返回事实，不能被旧 expectedState 拦截。
    entry.pending = Promise.resolve()
      .then(async () => {
        await assertBeforeCommit?.();
        return this.repo.commit(entry.snapshot, planned.files, params.message, {
          reviewId: selected.id,
          groupId: selected.groupId,
          workspacePath: params.workspacePath,
          workspaceIdentity: params.workspaceIdentity,
        });
      })
      .then((result) => {
        // ref 成功事实必须先记录，再刷新 UI 或推送；网络重试不能再次创建同一候选提交。
        const committed = { ...result, summary: entry.snapshot.summary };
        entry.done.set(next.id, committed);
        logger.info(undefined, "审核候选已提交", {
          groupId: next.id,
          commitHash: result.commitHash,
        });
        return committed;
      });
    try {
      return await entry.pending;
    } finally {
      entry.pending = undefined;
    }
  }
}
