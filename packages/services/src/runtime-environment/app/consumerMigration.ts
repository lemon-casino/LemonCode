import { randomUUID } from "node:crypto";
import type { RuntimeConsumerReference } from "@lcode/shared";
import type { RuntimeEnvironmentConsumerAuthority } from "../contract.js";
import { assertEnvironmentScope } from "./preparationAdmission.js";
import type { RuntimeEnvironmentStore } from "./ports.js";

type Migration = Parameters<NonNullable<RuntimeEnvironmentConsumerAuthority["migrateSessions"]>>[0];
export async function migrateEnvironmentSessions(
  store: RuntimeEnvironmentStore,
  params: Migration,
  stamp: () => string,
): Promise<void> {
  const keys = [...new Set([params.fromEnvironmentId, params.toEnvironmentId])].sort();
  const run = async () => {
    const previous = await store.readEnvironment(params.fromEnvironmentId);
    const current = await store.readEnvironment(params.toEnvironmentId);
    if (!previous || !current)
      throw new Error("stale-reference: session migration environment is missing");
    assertEnvironmentScope(previous, params);
    assertEnvironmentScope(current, params);
    if (
      previous.bindingId !== params.bindingId ||
      current.bindingId !== params.bindingId ||
      current.currentRevision !== params.revision ||
      current.status !== "ready"
    )
      throw new Error("stale-reference: session migration binding or revision differs");
    const refs = await store.listConsumers(params.fromEnvironmentId);
    if (refs.some((ref) => ref.state === "active" && ref.kind !== "session"))
      throw new Error("resource-busy: old execution owners must close before session migration");
    const same = params.fromEnvironmentId === params.toEnvironmentId;
    const next = same ? [...refs] : await store.listConsumers(params.toEnvironmentId);
    const ids = new Set(params.sessionIds);
    for (const id of ids) {
      const old = refs.find((ref) => ref.kind === "session" && ref.id === id);
      const index = next.findIndex((ref) => ref.kind === "session" && ref.id === id);
      const existing = next[index];
      if (
        existing?.state === "active" &&
        existing.ownerId === `binding:${params.bindingId}` &&
        existing.revision === params.revision
      )
        continue;
      if (
        (old && old.ownerId !== `binding:${params.bindingId}`) ||
        (old?.state === "active" &&
          params.oldRevision !== undefined &&
          old.revision !== params.oldRevision) ||
        (!same && existing?.state === "active")
      )
        throw new Error("stale-reference: session consumer changed before migration");
      const ref: RuntimeConsumerReference = {
        environmentId: params.toEnvironmentId,
        kind: "session",
        id,
        revision: params.revision,
        ownerId: `binding:${params.bindingId}`,
        ownerGeneration: (existing?.ownerGeneration ?? 0) + 1,
        lease: randomUUID(),
        state: "active",
        createdAt: existing?.createdAt ?? stamp(),
        updatedAt: stamp(),
      };
      if (index < 0) next.push(ref);
      else next[index] = ref;
    }
    // 先持久新引用再写旧墓碑；故障最多多保护一份，不能让仍可恢复会话的工具失去保护。
    await store.saveConsumers(params.toEnvironmentId, next);
    if (!same)
      await store.saveConsumers(
        params.fromEnvironmentId,
        refs.map((ref) =>
          ref.kind === "session" && ids.has(ref.id)
            ? { ...ref, state: "released", updatedAt: stamp() }
            : ref,
        ),
      );
  };
  const lock = (index: number): Promise<void> =>
    index === keys.length ? run() : store.lock(keys[index]!, () => lock(index + 1));
  await lock(0);
}
