import { compileModelOptionMap } from "./compiler.js";
import { applyOrderedJsonMergePatches, type NamedJsonMergePatch } from "./merge-patch.js";
import { ModelOptionMapError, type JsonObject, type ModelOptionMapProgram } from "./types.js";

export interface ModelOptionMapSpecs {
  readonly reasoningLevel: { readonly map: string };
  readonly maxOutputTokens: { readonly map: string };
  readonly speed?: { readonly map: string };
}

export interface ModelOptionValues {
  readonly reasoningLevel: string;
  readonly maxOutputTokens: number;
  readonly speed?: string;
}

export interface CompiledModelOptionMaps {
  apply(body: JsonObject, values: ModelOptionValues): JsonObject;
}

/** Model 创建时编译一次；每个请求只绑定本轮冻结的 Option value。 */
export function compileModelOptionMaps(specs: ModelOptionMapSpecs): CompiledModelOptionMaps {
  const reasoningLevel = compileModelOptionMap(specs.reasoningLevel.map, "reasoningLevel");
  const maxOutputTokens = compileModelOptionMap(specs.maxOutputTokens.map, "maxOutputTokens");
  const speed = specs.speed ? compileModelOptionMap(specs.speed.map, "speed") : undefined;
  return Object.freeze({
    apply(body: JsonObject, values: ModelOptionValues): JsonObject {
      const patches: NamedJsonMergePatch[] = [];
      if (values.reasoningLevel === undefined) {
        throw new ModelOptionMapError("reasoningLevel requires an effective value");
      }
      patches.push(optionPatch("reasoningLevel", reasoningLevel, values.reasoningLevel));
      patches.push(optionPatch("maxOutputTokens", maxOutputTokens, values.maxOutputTokens));
      if (speed) {
        if (values.speed === undefined) {
          throw new ModelOptionMapError("speed requires an effective value");
        }
        patches.push(optionPatch("speed", speed, values.speed));
      }
      return applyOrderedJsonMergePatches(body, patches);
    },
  });
}

function optionPatch(
  option: string,
  program: ModelOptionMapProgram,
  value: string | number,
): NamedJsonMergePatch {
  return { option, patch: program.evaluate(value) };
}
