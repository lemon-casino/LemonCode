import { isSea } from "node:sea";
import type { RuntimeInfo } from "@lcode/shared-types";

export { type RuntimeInfo };

export const getRuntimeInfo = (): RuntimeInfo => ({
  arch: process.arch,
  cwd: process.cwd(),
  execPath: process.execPath,
  node: process.version,
  platform: process.platform,
  sea: isSea(),
  versions: process.versions,
});
