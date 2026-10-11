import { endpoint, extract, patches } from "./quota-fact-rules.mjs";

const channels = new Set([
  "factory",
  "cline",
  "cursor",
  "grok",
  "kiro",
  "workbuddy",
  "workbuddy-ai",
  "bigmodel",
  "zai",
  "trae-cn",
  "trae-global",
]);
const numeric = ["used", "amount", "limit", "unlimited", "unit"];

/** One quota operation owns these facts; no account/global observation cache exists. */
export function createQuotaFacts(channel, signal) {
  if (!channels.has(channel)) return null;
  const observed = new Map(),
    latest = new Map();
  let closed = false,
    sequence = 0,
    unreadable = false;
  return {
    observe(input, response) {
      const key = endpoint(channel, input);
      if (!key || !response.ok || closed || signal?.aborted) return response;
      const id = ++sequence;
      latest.set(key, id);
      const remember = (value) => {
        if (!closed && !signal?.aborted && latest.get(key) === id)
          observed.set(key, extract(key, value));
      };
      const decorate = (res) => {
        const text = res.text.bind(res),
          json = res.json.bind(res),
          clone = res.clone.bind(res);
        // 观察插件已读取的正文，避免 clone/tee 额外缓冲或改变取消顺序；只保留数字投影。
        res.text = async () => {
          const body = await text();
          if (body.length > 2 * 1024 * 1024) unreadable = true;
          else {
            try {
              remember(JSON.parse(body));
            } catch {
              /* 原插件负责报告解析失败。 */
            }
          }
          return body;
        };
        res.json = async () => {
          const body = await json();
          remember(body);
          return body;
        };
        res.clone = () => decorate(clone());
        return res;
      };
      return decorate(response);
    },
    apply(result) {
      closed = true;
      if (!result || !Array.isArray(result.windows) || signal?.aborted) return result;
      const pending = patches(observed);
      const windows = result.windows.map((window, index) => {
        const at = pending.findIndex((p) =>
          p.index !== undefined ? p.index === index : p.name === window.name,
        );
        if (at < 0 && !unreadable) return window;
        const patch = at >= 0 ? pending.splice(at, 1)[0] : {};
        const out = { ...window };
        for (const field of numeric) {
          if (!unreadable && !(field in patch)) continue;
          if (unreadable || patch[field] === undefined) delete out[field];
          else out[field] = patch[field];
        }
        if (unreadable || patch.clearDisplay) delete out.display;
        return out;
      });
      observed.clear();
      return { ...result, windows };
    },
  };
}
