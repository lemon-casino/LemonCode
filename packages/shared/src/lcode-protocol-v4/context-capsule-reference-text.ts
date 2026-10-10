import type { ContextCapsuleRef } from "./shared-context-ref.js";

/** Only an explicit standalone reference outside code fences admits background context. */
export function readContextCapsuleRefs(text: string): ContextCapsuleRef[] {
  const ids = new Set<string>();
  let fence: string | undefined;
  for (const line of text.split(/\r?\n/u)) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/u.exec(line);
    if (fence) {
      // 围栏内带正文的同类标记不是结束行，否则后续代码示例会被误接纳为摘要背景。
      if (
        marker &&
        marker[1]![0] === fence[0] &&
        marker[1]!.length >= fence.length &&
        /^[\t ]*$/u.test(marker[2]!)
      ) {
        fence = undefined;
      }
      continue;
    }
    if (marker && (marker[1]![0] === "~" || !marker[2]!.includes("`"))) {
      fence = marker[1];
      continue;
    }
    // 四空格或 tab 开头属于缩进代码，不能因空白匹配而变成隐式上下文引用。
    const id = /^ {0,3}#(capsule_[a-f0-9]{32})[\t ]*$/u.exec(line)?.[1];
    if (id) ids.add(id);
  }
  if (ids.size > 4) throw new Error("A message can reference at most 4 saved summaries.");
  return [...ids].map((capsule_id) => ({ kind: "context_capsule", capsule_id }));
}
