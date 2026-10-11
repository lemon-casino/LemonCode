// 路径与迁移的唯一实现供Host服务和CLI共用，避免两侧hash或项目scope漂移。
export { resolveProjectMemoryRoot } from "@lcode/shared/node";
