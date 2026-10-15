// 固定 Qoder 插件会丢弃输入分类中的写入字段；构建时保留上游分类，不改原始 vendor 字节和哈希。
export function preserveQoderCacheUsage(source) {
  const original =
    "...(u.prompt_tokens_details?.cached_tokens ? { prompt_tokens_details: { cached_tokens: u.prompt_tokens_details.cached_tokens } } : {}),";
  if (source.split(original).length !== 2)
    throw new Error("Pinned Qoder cache usage patch no longer matches");
  return source.replace(
    original,
    "...(u.prompt_tokens_details ? { prompt_tokens_details: { ...u.prompt_tokens_details } } : {})," +
      "\n        ...(u.cache_creation_input_tokens == null ? {} : { cache_creation_input_tokens: u.cache_creation_input_tokens })," +
      "\n        ...(u.cache_read_input_tokens == null ? {} : { cache_read_input_tokens: u.cache_read_input_tokens })," +
      "\n        ...(u.prompt_cache_hit_tokens == null ? {} : { prompt_cache_hit_tokens: u.prompt_cache_hit_tokens }),",
  );
}

// Trae 的总输入已经包含缓存；透传分类不能再次累加到总量。
export function preserveTraeCacheUsage(source) {
  // 只归一化构建副本的换行；vendor 原始字节仍由 manifest 校验，跨平台补丁位置保持一致。
  source = source.replaceAll("\r\n", "\n");
  const original =
    "if (read || write) out.prompt_tokens_details = { cached_tokens: read, ...(write ? { cache_write_tokens: write } : {}) }";
  if (source.split(original).length !== 2)
    throw new Error("Pinned Trae cache usage patch no longer matches");
  const patched = source.replace(
    original,
    // 新版上游已保留非零缓存计数；仍需按字段存在性保留明确的零，与未知区分。
    "if (u.prompt_tokens_details) out.prompt_tokens_details = { ...u.prompt_tokens_details }",
  );
  const raw =
    "if (r) out.cache_read_input_tokens = r\n    if (w) out.cache_creation_input_tokens = w";
  if (patched.split(raw).length !== 2)
    throw new Error("Pinned Trae raw cache usage patch no longer matches");
  // 顶层 Anthropic 风格计数同样不能用真值判断，否则明确的 0 会再次变成未知。
  return patched.replace(
    raw,
    "const supplied = (v) => typeof v === 'number' && Number.isFinite(v) && v >= 0\n" +
      "    if ([u.cache_read_input_tokens, u.cacheReadInputTokens].some(supplied)) out.cache_read_input_tokens = r\n" +
      "    if ([u.cache_creation_input_tokens, u.cacheCreationInputTokens].some(supplied)) out.cache_creation_input_tokens = w",
  );
}
