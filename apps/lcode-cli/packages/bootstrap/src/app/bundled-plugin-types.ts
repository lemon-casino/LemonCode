import { LCODE_OFFICIAL_PLUGIN_MARKETPLACE } from "@lcode/contracts";
import { type OfficialPluginDefinition } from "./official-plugin-definitions.js";

export const OFFICIAL_PLUGIN_MARKETPLACE = LCODE_OFFICIAL_PLUGIN_MARKETPLACE;

export interface OfficialPluginSeedFile {
  mode?: number;
  path: string;
  sha256: string;
  sourcePath?: string;
}

export interface OfficialPluginSeedPluginSource {
  definition: OfficialPluginDefinition;
  files: OfficialPluginSeedFile[];
  hash: string;
  missingSeedPaths: string[];
  rootPath?: string;
}

export interface OfficialPluginSeedSource {
  kind: "filesystem" | "sea";
  plugins: OfficialPluginSeedPluginSource[];
}
