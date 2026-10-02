import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";
import { isFileSystemPortError, type ProjectMemoryReviewDraft } from "@lcode/contracts";
import { hashBuffer } from "./file-system-common.js";
import { NodeFileSystemAdapter } from "./index.js";

export const digest = (text: string): string => hashBuffer(Buffer.from(text));
export const hasCode =
  (code: string) =>
  (error: unknown): boolean =>
    isFileSystemPortError(error) && error.code === code;

export async function memoryFixture(t: TestContext) {
  const base = await mkdtemp(join(await realpath(tmpdir()), "lcode-managed-memory-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const rootDir = join(base, "project-not-inferred-from-name");
  await mkdir(rootDir);
  const adapter = new NodeFileSystemAdapter();
  assert.ok(adapter.projectMemory, "Node adapter must expose the managed memory port");
  await adapter.projectMemory.registerRoot(rootDir);
  return {
    base,
    rootDir,
    stateDir: join(base, "memory-state"),
    adapter,
    memory: adapter.projectMemory,
  };
}

export function reviewDraft(
  content = "proposal content",
  expectedHash: string | null = null,
): ProjectMemoryReviewDraft {
  return {
    fingerprint: digest("frozen evidence"),
    sources: [
      { id: "source-001", kind: "session", reference: "fixture-session", revision: "revision-1" },
    ],
    items: [
      {
        id: "item-0001",
        fileName: "fact.md",
        expectedHash,
        content,
        reason: "Explicit fixture",
        sourceIds: ["source-001"],
      },
    ],
    partial: false,
    summary: "Synthetic fixture only",
  };
}

export async function seedPrepared(input: {
  rootDir: string;
  stateDir: string;
  id: string;
  fileName: string;
  before: string | null;
  after: string;
  proposalId?: string;
  proposalItemId?: string;
}) {
  const { rootDir, stateDir, id, fileName, before, after, proposalId, proposalItemId } = input;
  const change = {
    schemaVersion: 1,
    id,
    fileName,
    createdAt: Date.now(),
    beforeHash: before === null ? null : digest(before),
    afterHash: digest(after),
    status: "prepared",
    ...(proposalId ? { proposalId, proposalItemId } : {}),
  };
  if (before !== null)
    await writeFile(join(stateDir, "preimages", `${id}.bin`), before, { mode: 0o600 });
  await writeFile(
    join(stateDir, "journal", `${id}.json`),
    JSON.stringify({ schemaVersion: 1, rootDir, change }),
    { mode: 0o600 },
  );
  return change;
}
