import { homedir } from "node:os";
import { migrateHomeBrandDataRootSync } from "@lcode/shared/node";
import { applyEarlyDataBaseDirBootstrap } from "./desktopDataBaseDirBootstrap.js";

// 品牌迁移（复制式、幂等）必须先于 setting.json 读取：旧 ~/.zcode/v2/setting.json 是
// dataBaseDir 自定义值的唯一来源，先迁移再引导，避免首次启动读不到自定义目录
// 而把日志/crash dump 写到两套路径（specs/brand-migration-lcode.md）。
migrateHomeBrandDataRootSync(process.env.LCODE_DESKTOP_HOME_DIR?.trim() || homedir());

applyEarlyDataBaseDirBootstrap();
