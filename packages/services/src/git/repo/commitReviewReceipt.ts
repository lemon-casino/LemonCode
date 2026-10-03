import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { resolve, join } from "node:path";
import { z } from "zod";
import { atomicWritePrivateTextFile } from "@lcode/shared/node";
import type { GitCommitRequest } from "@lcode/shared";
import type { GitCommandProvider } from "../providers/gitCommandProvider.js";
import { ensureGitCommandSucceeded } from "./gitCliHelpers.js";
import type { GitCliRepo } from "./gitCliTypes.js";

export async function recoverReviewedCommit(
  command: GitCommandProvider,
  repo: GitCliRepo,
  params: GitCommitRequest,
) {
  const receipt = await new CommitReviewReceiptStore(command).recover(params);
  return receipt
    ? { ...receipt, summary: (await repo.getStatus(params.workspacePath)).summary }
    : null;
}

export interface CommitReviewAuthorization {
  reviewId: string;
  groupId: string;
  workspaceIdentity?: string;
  workspacePath: string;
}
const receiptSchema = z
  .object({
    version: z.literal(1),
    key: z.string(),
    ref: z.string(),
    candidate: z.string().regex(/^[a-f0-9]{40,64}$/),
    oldHead: z.string().nullable(),
    tree: z.string(),
    indexDigest: z.string(),
    stage: z.enum(["prepared", "completed"]),
    warning: z.string().optional(),
  })
  .strict();
type Receipt = z.infer<typeof receiptSchema>;
const digest = (value: string | Buffer) => createHash("sha256").update(value).digest("hex");
const authorizationKey = (authorization: CommitReviewAuthorization) =>
  digest(
    JSON.stringify([
      authorization.workspaceIdentity?.trim() || resolve(authorization.workspacePath),
      resolve(authorization.workspacePath),
      authorization.reviewId,
      authorization.groupId,
    ]),
  );

export async function prepareReviewCommitReceipt(
  command: GitCommandProvider,
  authorization: CommitReviewAuthorization | undefined,
  snapshot: { ref: string; head: string | null },
  candidate: { commitHash: string; tree: string; indexPath: string },
) {
  if (!authorization) return undefined;
  return new CommitReviewReceiptStore(command).prepare(authorization, {
    ref: snapshot.ref,
    candidate: candidate.commitHash,
    oldHead: snapshot.head,
    tree: candidate.tree,
    indexDigest: digest(await readFile(candidate.indexPath)),
  });
}

export class CommitReviewReceiptStore {
  constructor(private readonly command: GitCommandProvider) {}
  private async git(cwd: string, args: string[]) {
    const result = await this.command.run({ cwd, args });
    ensureGitCommandSucceeded("git commit receipt", result);
    if (result.outputTruncated) throw new Error("Git receipt evidence is truncated");
    return result.stdout.trim();
  }
  private async location(authorization: CommitReviewAuthorization) {
    const common = await this.git(authorization.workspacePath, ["rev-parse", "--git-common-dir"]);
    return join(
      resolve(authorization.workspacePath, common),
      "lcode",
      "commit-receipts",
      `${authorizationKey(authorization)}.json`,
    );
  }
  async prepare(
    authorization: CommitReviewAuthorization,
    input: Omit<Receipt, "version" | "key" | "stage">,
  ) {
    const path = await this.location(authorization);
    const receipt: Receipt = {
      ...input,
      version: 1,
      key: authorizationKey(authorization),
      stage: "prepared",
    };
    await atomicWritePrivateTextFile(path, JSON.stringify(receiptSchema.parse(receipt)));
    return async (warning?: string) =>
      atomicWritePrivateTextFile(
        path,
        JSON.stringify({ ...receipt, stage: "completed", ...(warning ? { warning } : {}) }),
      );
  }
  async recover(
    params: GitCommitRequest,
  ): Promise<{ commitHash: string; warning?: string } | null> {
    if (!params.review) return null;
    const authorization = { ...params, reviewId: params.review.id, groupId: params.review.groupId };
    let receipt: Receipt;
    try {
      receipt = receiptSchema.parse(
        JSON.parse(await readFile(await this.location(authorization), "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    if (receipt.key !== authorizationKey(authorization))
      throw new Error("Commit receipt scope mismatch");
    const ref = await this.git(params.workspacePath, ["rev-parse", "--verify", receipt.ref]);
    const contains = await this.command.run({
      cwd: params.workspacePath,
      args: ["merge-base", "--is-ancestor", receipt.candidate, ref],
    });
    if (contains.timedOut || contains.outputTruncated || ![0, 1].includes(contains.exitCode ?? -1))
      throw new Error("Unable to reconcile commit receipt");
    if (contains.exitCode !== 0) {
      if (receipt.stage === "prepared" && ref === receipt.oldHead) return null;
      throw new Error("Reviewed commit ref changed; inspect recovery before retrying");
    }
    let warning = receipt.warning;
    if (receipt.stage !== "completed") {
      const index = resolve(
        params.workspacePath,
        await this.git(params.workspacePath, ["rev-parse", "--git-path", "index"]),
      );
      const matches = await readFile(index).then(
        (bytes) => digest(bytes) === receipt.indexDigest,
        () => false,
      );
      // 中文依据：ref 已前进是不可撤销事实；中断后不重提交、不自动覆盖 index，也不宣称 Hook 收尾已完成。
      warning = matches
        ? "提交已保存，但审核事务收尾中断，请重新检查 Hook 和剩余改动。"
        : "提交已保存，但暂存区收尾未确认，请人工恢复 index 后继续。";
    }
    return { commitHash: receipt.candidate, ...(warning ? { warning } : {}) };
  }
}
