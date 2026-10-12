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
  const original =
    "return { prompt_tokens: p, completion_tokens: c, total_tokens: Number(u.total_tokens ?? u.totalTokens) || p + c }";
  if (source.split(original).length !== 2)
    throw new Error("Pinned Trae cache usage patch no longer matches");
  return source.replace(
    original,
    "return { prompt_tokens: p, completion_tokens: c, total_tokens: Number(u.total_tokens ?? u.totalTokens) || p + c," +
      "\n    ...(u.prompt_tokens_details ? { prompt_tokens_details: { ...u.prompt_tokens_details } } : {})," +
      "\n    ...(u.cache_creation_input_tokens == null ? {} : { cache_creation_input_tokens: u.cache_creation_input_tokens })," +
      "\n    ...(u.cache_read_input_tokens == null ? {} : { cache_read_input_tokens: u.cache_read_input_tokens })," +
      "\n    ...(u.prompt_cache_hit_tokens == null ? {} : { prompt_cache_hit_tokens: u.prompt_cache_hit_tokens }), }",
  );
}
