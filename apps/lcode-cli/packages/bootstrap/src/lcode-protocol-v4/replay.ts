// 回放导出桶。
//
// 下游回放页面在浏览器里用 CLI 自己的三段归约器把持久化的 MessageWithParts 重建成
// ConversationSnapshot：synthesizeEventsFromMessages → mergeColdConversationEvents →
// ProductProjection（hydration replay）。三者都是纯函数/纯类，无 node 依赖——这条纪律由
// 浏览器回放包的 `vite build` 机械检查（桶里一旦混进 node 内建模块导入，浏览器包立刻构建失败）。
//
// 只 re-export，不定义任何东西。
export { ProductProjection } from "./product-projection.js";
export { synthesizeEventsFromMessages } from "./transcript-hydration.js";
export { mergeColdConversationEvents, type ColdEventMergeResult } from "./cold-event-merge.js";
export { HYDRATION_TRACE_ID } from "./projection-state.js";
