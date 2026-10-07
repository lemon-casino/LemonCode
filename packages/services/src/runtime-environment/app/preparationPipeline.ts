import type {
  FrozenManifest,
  RuntimeEnvironmentError,
  RuntimePreparationOperation,
} from "@lcode/shared";
import { buildToolResolutionPlan, selectToolsForFreeze } from "../domain/selectTools.js";
import { buildDependencyInstallPlan } from "../domain/dependencies.js";
import { hasServiceExitProof } from "../domain/services.js";
import {
  declarationDigest,
  hostPlatform,
  manifestDigest,
  safeEnvironmentError,
} from "./manifest.js";
import { runDependencyStage } from "./dependencyStage.js";
import { preparationCheckpoint, settlePreparation } from "./preparationSettlement.js";
import {
  preparationError,
  type PreparationOptions,
  type PreparationRun,
} from "./preparationTypes.js";

async function hasActiveExecutions(
  options: PreparationOptions,
  environmentId: string,
): Promise<boolean> {
  const consumers = await options.store.listConsumers(environmentId);
  if (consumers.some((ref) => ref.state === "active" && ref.kind !== "session")) return true;
  for (const id of await options.store.listServiceIds(environmentId)) {
    const receipt = await options.store.readServiceReceipt(environmentId, id);
    if (
      !receipt ||
      !hasServiceExitProof(receipt)
    )
      return true;
  }
  return false;
}
export async function runPreparation(
  options: PreparationOptions,
  run: PreparationRun,
  signal: AbortSignal,
  underWriter = false,
): Promise<RuntimePreparationOperation> {
  const { store, backend, stamp } = options;
  const envId = run.record.environmentId;
  let writer: (() => Promise<void>) | undefined;
  let stage: RuntimeEnvironmentError["stage"] = "resolvingTools";
  const fail = (error: RuntimeEnvironmentError, failureStatus?: "needsUpdate") =>
    settlePreparation(options, run, { error, failureStatus });
  try {
    const parsed = await options.declarations.read(run.params.workspacePath);
    await preparationCheckpoint(options, run);
    const digest = declarationDigest(parsed);
    const previous =
      run.record.currentRevision > 0
        ? await store.readManifest(envId, run.record.currentRevision)
        : null;
    const problem = parsed.issues[0];
    if (problem)
      return await fail({
        ...preparationError(problem.code, stage, problem.message),
        detail: { source: problem.source, ...(problem.field ? { field: problem.field } : {}) },
      });
    if (!options.managed)
      return await fail(
        preparationError(
          "capability-unavailable",
          stage,
          options.missingReason ?? "managed environments are unavailable on this Host",
        ),
      );
    const probe = await backend.probeBackend();
    await preparationCheckpoint(options, run);
    if (!probe.available)
      return await fail(
        preparationError(
          "capability-unavailable",
          stage,
          probe.reason ?? "the bundled mise backend is unavailable",
        ),
      );
    if (
      previous?.declarationDigest === digest &&
      previous.manifestDigest &&
      previous.tools.every((tool) => tool.toolPath) &&
      run.params.operation !== "restore"
    )
      return await settlePreparation(options, run, { reuseRevision: run.record.currentRevision });
    if (previous && run.params.operation !== "upgrade")
      return await fail(
        preparationError(
          "stale-reference",
          "updating",
          "project declarations changed; explicitly update the environment before execution",
        ),
        "needsUpdate",
      );
    const active = await store.lock(envId, () => hasActiveExecutions(options, envId));
    if (active)
      return await fail(
        preparationError(
          "resource-busy",
          "updating",
          "active processes or unconfirmed services must settle before changing dependencies",
        ),
        "needsUpdate",
      );
    if (!underWriter && options.acquireWriter)
      writer = await options.acquireWriter({
        workspacePath: run.params.workspacePath,
        ownerId: `runtime-prepare:${run.operation.operationId}`,
      });
    await preparationCheckpoint(options, run);
    let plan = run.operation.plan;
    if (
      !plan ||
      plan.declarationDigest !== digest ||
      plan.backendVersion !== options.backendVersion ||
      plan.os !== hostPlatform() ||
      plan.arch !== process.arch
    ) {
      const selection = buildToolResolutionPlan(parsed, options.appDefaultTools);
      if (selection.issues[0])
        return await fail(
          preparationError(selection.issues[0].code, stage, selection.issues[0].message),
        );
      const resolvedVersions: Record<string, string> = {};
      for (const request of selection.requests) {
        if (!backend.resolveVersion)
          return await fail(
            preparationError(
              "capability-unavailable",
              stage,
              "tool backend cannot resolve declared version ranges",
            ),
          );
        resolvedVersions[request.key] = await backend.resolveVersion({ ...request, signal });
        await preparationCheckpoint(options, run);
      }
      const chosen = selectToolsForFreeze(parsed, options.appDefaultTools, { resolvedVersions });
      if (chosen.issues[0])
        return await fail(preparationError(chosen.issues[0].code, stage, chosen.issues[0].message));
      const resources = await options.ensureResources?.(envId);
      plan = {
        schemaVersion: 1,
        backendVersion: options.backendVersion,
        os: hostPlatform(),
        arch: process.arch === "arm64" ? "arm64" : "x64",
        tools: chosen.tools,
        declarationDigest: digest,
        installStrategy: buildDependencyInstallPlan(parsed) ? "frozen" : "non-frozen",
        ...(resources ? { resources } : {}),
        createdAt: stamp(),
      };
      // 准备计划可重试，已发布 manifest 不可变；范围解出的版本在首次下载前持久化。
      await preparationCheckpoint(options, run, undefined, plan);
    }
    stage = "installingTools";
    await preparationCheckpoint(options, run, stage);
    const installed: Record<string, string> = {};
    for (const tool of [...plan.tools].sort(
      (a, b) => Number(b.key === "node") - Number(a.key === "node"),
    )) {
      const result = await backend.installTool({
        key: tool.key,
        version: tool.version,
        nodePath: installed.node,
        signal,
      });
      await preparationCheckpoint(options, run);
      installed[tool.key] = result.toolPath;
    }
    const finalManifest: FrozenManifest = {
      ...plan,
      tools: plan.tools.map((tool) => ({
        ...tool,
        toolPath: installed[tool.key],
        installStrategy: "managed-tool-store",
      })),
    };
    if (
      parsed.packageManager?.key === "npm" ||
      buildDependencyInstallPlan(parsed)?.manager === "npm"
    ) {
      if (!options.dependencies?.verifyManager)
        return await fail(
          preparationError(
            "capability-unavailable",
            stage,
            "the npm version verifier is unavailable",
          ),
        );
      const npm = await options.dependencies.verifyManager({
        manager: "npm",
        expectedVersion:
          parsed.packageManager?.key === "npm" ? parsed.packageManager.version : undefined,
        toolPaths: installed,
        signal,
      });
      await preparationCheckpoint(options, run);
      installed.npm = npm.toolPath;
      finalManifest.tools.push({
        key: "npm",
        version: npm.version,
        toolPath: npm.toolPath,
        source: parsed.packageManager?.key === "npm" ? "project-declaration" : "app-default",
        installStrategy: "managed-tool-store",
      });
    }
    finalManifest.manifestDigest = manifestDigest(finalManifest);
    stage = "preparingDependencies";
    await preparationCheckpoint(options, run, stage);
    const failed = await runDependencyStage({
      store,
      install: options.dependencies,
      resourceRoot: options.dependencyResourceRoot,
      workspacePath: run.params.workspacePath,
      environmentId: envId,
      declarations: parsed,
      declarationDigest: digest,
      manifestDigest: finalManifest.manifestDigest,
      resources: plan.resources,
      manifestOs: plan.os,
      manifestArch: plan.arch,
      frozenTools: finalManifest.tools,
      installedToolPaths: installed,
      stamp,
      signal,
      checkpoint: () => preparationCheckpoint(options, run),
      fail,
    });
    if (failed) return failed;
    await preparationCheckpoint(options, run);
    const current = await options.declarations.read(run.params.workspacePath);
    if (declarationDigest(current) !== digest)
      return await fail(
        preparationError(
          "stale-reference",
          stage,
          "declarations changed while preparing; retry with the new declarations",
        ),
        "needsUpdate",
      );
    return await settlePreparation(options, run, { manifest: finalManifest });
  } catch (error) {
    const code = (error as { code?: string }).code;
    return await fail(
      preparationError(
        code === "stale-reference"
          ? "stale-reference"
          : stage === "installingTools"
            ? "download-failed"
            : stage === "preparingDependencies"
              ? "dependency-install-failed"
              : "unsupported-declaration",
        stage,
        safeEnvironmentError(error),
      ),
    );
  } finally {
    await writer?.();
    await run.release();
  }
}
