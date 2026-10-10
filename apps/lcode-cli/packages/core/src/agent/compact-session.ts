// Compact/rewind 选择器由 contracts 统一拥有；Runtime hydration 与 capsule 最终事务使用同一规则。
export {
  compactActiveSessionMessages,
  isCompactPreservableSessionMessage,
  isActiveCompactionBoundaryPart,
} from "@lcode/contracts";
