// 兼容现有执行 owner 的入口；实际目录/身份判定由 Worktree 模块统一维护。
export { isCheckoutPathWithin, isOwnedCheckoutScope } from "../worktree/node.js";
