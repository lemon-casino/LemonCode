/** 审核内容预算：按本次真实改动计量，而不是按整份文件内容。 */
export const MAX_REVIEW_BYTES = 2_097_152;

/**
 * 本次改动真正需要审核的字节数：公共前后缀之外的部分。
 *
 * 直接累加整份 headContent + content 会把"大文件小改动"误判为超限——语言文件各约 48 万字节，
 * 只改 3 行也会算成 97 万字节，两份即触顶，与"文件数不能阻止审核"的规则相悖。
 * 新增/删除没有公共前后缀，仍按完整内容计入；重排大块代码时公共前后缀很短，
 * 结果接近完整内容，属于偏保守的上界，不会低估审核范围。
 */
export function changedBytes(headContent: string | null, content: string | null): number {
  if (headContent === null || content === null)
    return Buffer.byteLength(headContent ?? content ?? "", "utf8");
  const limit = Math.min(headContent.length, content.length);
  let prefix = 0;
  while (prefix < limit && headContent[prefix] === content[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < limit - prefix &&
    headContent[headContent.length - 1 - suffix] === content[content.length - 1 - suffix]
  )
    suffix += 1;
  return (
    Buffer.byteLength(headContent.slice(prefix, headContent.length - suffix), "utf8") +
    Buffer.byteLength(content.slice(prefix, content.length - suffix), "utf8")
  );
}
