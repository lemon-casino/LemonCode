# 依赖升级材料复核（2026-10-08）

本次升级保留了现有发行门禁：当前 inventory 的未解决集合必须与
`third-party/release-review-baseline.json` 完全一致。未取得完整原始材料的条目
不会被描述为已补齐。具体来源、版本、npm archive SHA-256、源码 revision 和树查询
记录于 `npm-overrides.json` 的 reviewEvidence；未从 npm author 推断版权人。

已补齐原始许可：Rive React 4.36.0、Rive WASM 2.44.0、Duke sheets WASM 0.1.23、
agent-base 6.0.2、https-proxy-agent 5.0.1、fastdom 1.0.12、strictdom 1.0.1。
README 中的完整许可段按原文保存，独立 LICENSE 按上游固定 revision 保存。

本轮已登记的基线差异：

| 条目                                 | 依赖路径与用途                                                            | 缺口                                                           |
| ------------------------------------ | ------------------------------------------------------------------------- | -------------------------------------------------------------- |
| @electron-internal/extract-zip@1.0.5 | Electron 41.10.7 的下载/解包工具；RUM 的 Electron peer 使其进入保守生产图 | npm 与固定源码树仅声明 BSD-2-Clause，没有完整独立版权/许可文件 |
| proxy-agent-negotiate@1.1.0          | proxy-agent 8.0.2 的 HTTP/HTTPS 代理链                                    | npm 与固定源码目录仅声明 MIT，没有完整独立版权/许可文件        |
| @hono/node-ws@1.3.1                  | 服务端 WebSocket adapter                                                  | 既有 1.3.0 材料缺口延续；版本更新，没有新增缺口类型            |

前两项是新增材料债务；第三项替换既有条目。版本固定的 publisher declaration、
标准条款与可用 README 段已保留，但不代表取得完整原始授权材料。
旧 `keyv@4.5.4` 已离开生产依赖图，对应旧基线条目需要移除。
零债务的 `node scripts/licenses.mjs check --strict` 仍应失败，不降低该门禁。
用户在了解材料检查与签名证书、付费授权的区别后要求继续处理，本轮已手动更新上述基线差异。
新增未知材料、已有条目删除或理由变化仍会被后续发行校验拒绝，不在 CI 自动重写基线。

当前发行契约 24/24 通过，上述材料基线差异已登记；
NOTICE/inventory 新鲜度通过。Web、CLI、Desktop 生产构建及 Windows x64 安装包已通过本地验证。
