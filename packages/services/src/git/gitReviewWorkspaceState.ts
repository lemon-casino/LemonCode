import { z } from "zod";
import { createHash } from "node:crypto";
import { mkdir, readFile, watch } from "node:fs/promises";
import { join } from "node:path";
import { Emitter, type Event } from "@lcode/rpc";
import {
  createGitReviewWorkspaceSnapshot,
  gitReviewWorkspaceKey,
  gitReviewWorkspaceScopeSchema,
  gitReviewWorkspaceSnapshotSchema,
  gitReviewWorkspaceUpdateSchema,
  type GitReviewWorkspaceScope,
  type GitReviewWorkspaceSnapshot,
  type GitReviewWorkspaceUpdate,
  type GitReviewWorkspaceUpdateResult,
} from "@lcode/shared";
import { atomicWritePrivateTextFile, withFileLock } from "@lcode/shared/node";
import { createServiceLogger } from "../logger/serviceLogger.js";

const documentSchema = z
  .object({
    snapshot: gitReviewWorkspaceSnapshotSchema,
    commands: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(8192),
            revision: z.number().int().positive(),
          })
          .strict(),
      )
      .max(256),
  })
  .strict();
type Document = z.infer<typeof documentSchema>;
const logger = createServiceLogger("git-review-workspace");

/** Host 唯一 accepted owner；UI 仅持有快照和未接受 overlay。 */
export class GitReviewWorkspaceState {
  private readonly memory = new Map<string, Document>();
  private readonly changed = new Emitter<GitReviewWorkspaceSnapshot>();
  private readonly tails = new Map<string, Promise<unknown>>();
  constructor(private readonly dataDir?: string) {}
  private location(scope: GitReviewWorkspaceScope) {
    return this.dataDir
      ? join(
          this.dataDir,
          `${createHash("sha256").update(gitReviewWorkspaceKey(scope)).digest("hex")}.json`,
        )
      : null;
  }
  private async document(scope: GitReviewWorkspaceScope): Promise<Document> {
    const path = this.location(scope);
    if (!path)
      return structuredClone(
        this.memory.get(gitReviewWorkspaceKey(scope)) ?? {
          snapshot: createGitReviewWorkspaceSnapshot(scope),
          commands: [],
        },
      );
    try {
      const raw = documentSchema.parse(JSON.parse(await readFile(path, "utf8")));
      const snapshot = raw.snapshot;
      if (
        gitReviewWorkspaceKey(snapshot.scope) !== gitReviewWorkspaceKey(scope) ||
        raw.commands.some((receipt) => receipt.revision > snapshot.revision)
      )
        throw new Error("Invalid review workspace document");
      return { snapshot, commands: raw.commands };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return { snapshot: createGitReviewWorkspaceSnapshot(scope), commands: [] };
      throw error;
    }
  }
  async read(input: GitReviewWorkspaceScope) {
    return (await this.document(gitReviewWorkspaceScopeSchema.parse(input))).snapshot;
  }
  async update(input: GitReviewWorkspaceUpdate): Promise<GitReviewWorkspaceUpdateResult> {
    const command = gitReviewWorkspaceUpdateSchema.parse(input);
    const path = this.location(command.scope);
    const perform = async (): Promise<GitReviewWorkspaceUpdateResult> => {
      const document = await this.document(command.scope);
      const receipt = document.commands.find((entry) => entry.id === command.commandId);
      if (receipt)
        return {
          status: "accepted",
          commandRevision: receipt.revision,
          snapshot: document.snapshot,
        };
      const fields = Object.keys(command.patch) as (keyof typeof command.patch)[];
      if (fields.some((field) => command.expectedFieldRevisions[field] === undefined))
        throw new Error("Missing review field revision");
      if (
        fields.some(
          (field) =>
            command.expectedFieldRevisions[field] !== document.snapshot.fieldRevisions[field],
        )
      )
        return { status: "conflict", snapshot: document.snapshot };
      const revision = document.snapshot.revision + 1;
      const snapshot = gitReviewWorkspaceSnapshotSchema.parse({
        scope: command.scope,
        revision,
        lastCommandId: command.commandId,
        fieldRevisions: {
          ...document.snapshot.fieldRevisions,
          ...Object.fromEntries(fields.map((field) => [field, revision])),
        },
        data: { ...document.snapshot.data, ...command.patch },
      });
      const next = {
        snapshot,
        commands: [...document.commands.slice(-255), { id: command.commandId, revision }],
      };
      if (path) await atomicWritePrivateTextFile(path, JSON.stringify(next));
      else this.memory.set(gitReviewWorkspaceKey(command.scope), next);
      this.changed.fire(snapshot);
      return { status: "accepted", commandRevision: revision, snapshot };
    };
    // 跨窗口 Host 共用文件锁；同进程队列也由同一锁实现，不能只靠 Renderer busy。
    if (path) return withFileLock(path, perform);
    const key = gitReviewWorkspaceKey(command.scope);
    const admission = (this.tails.get(key) ?? Promise.resolve()).then(perform);
    this.tails.set(
      key,
      admission.catch(() => undefined),
    );
    return admission;
  }
  subscribe(input: GitReviewWorkspaceScope): Event<GitReviewWorkspaceSnapshot> {
    const scope = gitReviewWorkspaceScopeSchema.parse(input);
    return (listener) => {
      const abort = new AbortController();
      let revision = -1;
      const emit = (snapshot: GitReviewWorkspaceSnapshot) => {
        if (
          !abort.signal.aborted &&
          gitReviewWorkspaceKey(snapshot.scope) === gitReviewWorkspaceKey(scope) &&
          snapshot.revision > revision
        ) {
          revision = snapshot.revision;
          listener(snapshot);
        }
      };
      const live = this.changed.event(emit);
      if (this.dataDir) {
        const directory = this.dataDir;
        const path = this.location(scope)!;
        void (async () => {
          await mkdir(directory, { recursive: true });
          if (abort.signal.aborted) return;
          const events = watch(directory, { signal: abort.signal, persistent: false });
          const observe = (async () => {
            for await (const event of events) {
              if (!event.filename || join(directory, event.filename) === path)
                emit(await this.read(scope));
            }
          })();
          await this.read(scope).then(emit);
          await observe;
        })().catch(() => {
          if (!abort.signal.aborted) logger.warn(undefined, "审核编辑订阅中断，需重新读取快照");
        });
      } else void this.read(scope).then(emit);
      return {
        dispose: () => {
          abort.abort();
          live.dispose();
        },
      };
    };
  }
}
