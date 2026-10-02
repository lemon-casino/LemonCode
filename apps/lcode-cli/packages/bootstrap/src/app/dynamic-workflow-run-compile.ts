import { createHash } from "node:crypto";
import {
  buildAskSpecs,
  collectSites,
  collectWorldRunCommands,
  createWorkflowProgram,
  deriveWorkflowCausalityFor,
  deriveActorSubmitProfilesFor,
  lowerWorkflow,
  synthesizeAskSchemas,
  type WorkflowProgram,
} from "@lcode/dynamic-workflow";
import { type CompiledDynamicWorkflowScript } from "./dynamic-workflow-run-launch.js";

/**
 * 编译一次：一个 ts.Program 同时喂站点表、schema 合成与 lowering。
 *
 * 脏脚本在这里硬失败且**不建 run**：handler 只在 `ok` 时才调 submit，所以走到这里的脏脚本
 * 只可能是接线错误。防御性检查读的是同一次编译的程序诊断，不再起第二个 Program
 * （那会破坏「编译一次」）。resume 用同一个函数重编 journal 里的原文——byte-identical 的
 * 脚本必然重新通过同一套检查。
 */
export function compileOnce(scriptText: string): CompiledDynamicWorkflowScript {
  return compileProgram(scriptText, createWorkflowProgram(scriptText));
}

/**
 * compileOnce 的后半段：对**已建好的** Program 做站点表 / schema 合成 / lowering。resume 先用同一个
 * Program 取诊断再交到这里，仍是「编译一次」（Program 缓存自己的诊断，重读不重算）。
 */
export function compileProgram(
  scriptText: string,
  workflow: WorkflowProgram,
): CompiledDynamicWorkflowScript {
  const diagnostics = [
    ...workflow.program.getSyntacticDiagnostics(),
    ...workflow.program.getSemanticDiagnostics(),
  ];
  if (diagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script that does not typecheck (${diagnostics.length} diagnostics); no run was created`,
    );
  }

  const table = collectSites(workflow);
  const { diagnostics: schemaDiagnostics, schemas } = synthesizeAskSchemas(workflow, table);
  if (schemaDiagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with unsupported ask result types: ${schemaDiagnostics
        .map((diagnostic) => `L${diagnostic.line}:C${diagnostic.column} ${diagnostic.message}`)
        .join("; ")}`,
    );
  }
  // world.run 的命令集在同一次编译里收集（授权面：编译期字面量 + 确认窗展示 + driver 复验）。
  // 非字面量 cmd 在 handler 的 analyze 阶段已经挡回；到这里还出现即接线错误，硬失败不建 run。
  const worldRun = collectWorldRunCommands(workflow, table);
  if (worldRun.diagnostics.length > 0) {
    throw new Error(
      `dynamic workflow submit received a script with non-literal world.run commands (${worldRun.diagnostics.length} diagnostics); no run was created`,
    );
  }

  // buildAskSpecs 是 askSpecs 的唯一正确构造：untyped 站点显式记 {typed:false}。
  // 用 schemas 的键去构造会让 untyped 站点整个缺席，而引擎把缺席当接线错误硬失败。
  const askSpecs = buildAskSpecs(table, schemas);

  return {
    askSpecs,
    causality: deriveWorkflowCausalityFor(workflow, table),
    // 每个 actor 站点的 submit profile：在**同一个**
    // Program 上做解释 + 站点图投影（analyzeWorkflowScript 在 handler 的 analyze 阶段已对同一份文本
    // 跑过这两步），仍是「编译一次」。resume 用同一函数对 byte-identical 文本重算，确定性成立。
    actorSubmitProfiles: deriveActorSubmitProfilesFor(workflow, table, askSpecs),
    declaredRunCommands: new Set(worldRun.commands),
    lowered: lowerWorkflow(workflow, table).code,
    // scriptHash 的所有权在**这里**，不在 harness。harness 同时收 scriptText 与 lowered，
    // 且刻意不校验两者是否自洽——校验等于把编译再跑一遍，正是「编译一次」要省掉的那次
    // （harness.ts 把这条写成了调用方的不变式）。所以哈希必须算在作者原文上：
    // 若让 harness 哈希「它看到的文本」，lowered 路径落库的就是 lowered 函数体的哈希，
    // 而 resume 比对的是作者原文 —— 比对对象会静默错位。本函数从同一次编译里同时产出
    // lowered 与 hash，两者按构造自洽。
    scriptHash: createHash("sha256").update(scriptText, "utf8").digest("hex"),
  };
}
