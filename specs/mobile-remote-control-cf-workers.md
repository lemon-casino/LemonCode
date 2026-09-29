# 社区版移动端远程控制(CF Workers 隧道)

## 目标与边界

1. 社区版自研移动端远程控制:桌面端(本项目构建)与手机之间用 Cloudflare Worker(`cfworker-remote` 仓库,经 GitHub 连接 Workers Builds 自动部署)做**隧道**。桌面端只做出站连接,无需公网 IP/端口转发,任意地点、任意时间可连。
2. 交互形态对齐官方:提供「远程控制」设置段(2026-09-29 起入口从设置侧栏迁至侧栏 footer 快捷入口,见「桌面端改动」#1);桌面生成二维码或可复制链接,手机扫码/打开链接 → **双方授权** → 手机获得与官方一致的远程控制能力,且**权限与桌面使用者完全对等(镜像)**:桌面能使用的功能,手机同样可以使用,不另做缩减版界面或只读模式;断线后按 web-remote-replayable 恢复。
3. Worker 只做鉴权、配对、心跳、桥接转发与房间生命周期管理,**不保存任务队列、快照、消息内容等业务状态**;桌面不为本功能另起 Agent、Local Host 或远程会话,手机 attachment 到已有窗口 Host,复用会话运行时。
4. v1 明确不做:端到端加密(Worker 以 TLS 终止 + 鉴权转发,可见帧内容);离线推送;多桌面账号体系。

## 总体架构与所有者

```text
┌────────────────────┐  WSS 出站 /connect/host(接入 Key + 房间注册)  ┌────────────────────┐  WSS /connect/client  ┌────────────────┐
│ Desktop Main        │ ────────────────────────────────────────────▶ │ CF Worker           │ ◀─────────────────── │ 手机 Web(PWA) │
│ (本项目构建)         │ ◀────────────────── 桥接帧(授权后) ─────────── │ cfworker-remote     │ ───────────────────▶ │ 扫码/链接打开    │
│ 鉴权·配对·attachment │                                               │ DO:房间/桥/凭据哈希  │                      │ replayable 客户端│
└─────────┬──────────┘                                               └────────────────────┘                      └────────────────┘
          │ MessageChannel port(仅本地)
┌─────────▼──────────┐
│ 窗口 Host(已有)     │  手机 = 新的远端 attachment,复用 v4 会话运行时
└────────────────────┘
```

- **Worker(唯一新组件)**:房间状态唯一所有者(房间映射、capability 哈希、设备凭据哈希、TTL)。Durable Object 每房间一个实例;桥接为逐帧透传,不解析业务消息。
- **Desktop Main**:出站连接所有者、配对确认所有者、attachment 调度所有者。把手机侧帧泵入窗口 Host 的 attachment port;不承载任务/会话业务状态。
- **窗口 Host(现有)**:会话运行时唯一所有者;手机作为带 `clientMode=web-remote-replayable` 档位的可信连接接入(v4 连接作用域既有权威面,不新增第二写入路径)。
- **手机**:replayable 客户端;断线重连与恢复走既有 web-remote-replayable 语义。

## 双方授权与配对时序

```text
桌面                       Worker(DO)                      手机
 │ ①开启等待:生成 roomId+一次性 capability(30s,consume-once)
 │ ②WSS /connect/host(接入Key) ──▶ room.create{roomId,capHash,ttl}
 │                                ──▶ room 注册完成(ready)
 │ ③显示二维码/链接:https://<域名>/p/<roomId>#<capability>
 │                                 ◀── ④扫码 GET /p/<roomId>(SPA)── │
 │                                 ◀── ⑤WSS /connect/client + cap ── │
 │                                (校验 capHash:一次性、TTL、失败计数)
 │ ◀── pairing.request{设备名/UA} ──▶                                 │
 │ ⑥桌面用户确认(允许此设备) 或 拒绝                                    │
 │ ── pairing.accept ─────────────▶ 建桥(双向透传) ────────────────▶ ⑦双方授权完成
 │                                签发设备凭据(哈希存 DO,TTL)          │
 │ ⑧Main attachment 调度:attachRemoteWorkspaceSessionHost ──▶ 窗口 Host
 │ ⑨心跳保活;断线后手机凭设备凭据重连 → 桥重建 → replay 恢复
```

- 授权是**双向**的:手机须持一次性 capability(来自二维码,URL fragment 传递不进服务器日志);桌面用户须显式确认该设备(或比对 PIN)。任一环节缺失不建桥、手机拿不到任何会话数据。
- 连续配对失败达到阈值(默认 5 次)房间立即作废;配对链接默认 5 分钟过期。
- 重连不重复人工确认:已授权设备凭设备凭据重连;桌面「停止」或吊销设备后,现有连接立即断开、凭据失效。

## cfworker-remote 设计(空仓库起步)

- 技术形态:Workers + Durable Objects(每房间一个 DO 实例)+ Workers Static Assets(托管移动端 SPA);`wrangler.jsonc` 声明 DO binding,GitHub 连接后由 Workers Builds 在 push 时自动部署。
- 端点:`GET /`(移动端 SPA)、`GET /p/:roomId`(配对深链,同一 SPA)、`WS /connect/host`(桌面,凭接入 Key)、`WS /connect/client`(手机,凭一次性 capability 或设备凭据)。可选 `POST /api/health` 供设置页「测试连接」。
- DO 内状态仅限:roomId、capHash、过期时间、已配对设备凭据哈希(含设备名)、双向 socket 引用、失败计数。TTL 到期与房间关闭即清理;不落 KV/R2 的业务数据。
- 透传规则:授权前仅允许配对控制帧;授权后所有帧双向透传,不解析、不缓存消息内容;心跳由两端各自与 DO 维持,DO 负责断连检测与对端通知。

## 桌面端改动

1. **设置(基础设置 → 远程控制)**:启用开关;Worker 域名;接入 Key(凭据保存复用 `remoteWorkspaceHistory` 的凭据集中管理机制,不进明文配置);安全隐私——允许新设备配对开关、已授权设备列表(名称/授权时间/最近在线)+吊销、配对链接有效期、空闲自动断开;「测试连接」。对应 `packages/ui/src/settings/settingsPageConfig.ts` 的 `BASE_SETTINGS_SECTIONS`(basics 组)新增 section。
   - **入口迁移(2026-09-29,同日二改)**:分区入口从设置侧栏「基础设置」组迁到侧栏 footer——`WorkspaceSidebarFooter` 中「连接使用」账户入口与「设置」齿轮之间、齿轮之前的手机图标按钮,**点击弹出「移动端远程控制」配对弹框(向上 Popover),不再跳转设置页**。配对块独立为 `MobileRemoteControlPanel`(自持 `useRemoteControl` 装配与镜像 target fail-closed 判定,配对交互本体仍是 `RemotePairingPanel`);设置段 `RemoteControlSettingsSection` 不再承载配对分区,只保留连接配置与安全隐私。弹框内提供「远程控制设置」出口,经 `setPendingSettingsSection("remoteControl")` + `openSettingsTab()` 直达分区。设置侧栏导航不再列出该分区(`settingsPageConfig` 以 `navHidden` 标记保留分区注册,`settingsSections` 解析、面包屑、上次停留分区记忆与直达意图均不受影响)。入口平台门禁与分区注册同源(仅桌面平台三布尔任一为真);Web/手机视图既不注册分区也不显示 footer 入口。
2. **配对面板**:对齐截图形态(等待手机连接/已就绪/停止/刷新二维码/复制链接);「开启等待」驱动 Main 出站注册并生成二维码;「停止」关闭房间并断开出站。
3. **Attachment 接线**:Main 收到配对完成事件后,经 `attachRemoteWorkspaceSessionHost`(`desktopRemoteSessions.ts:832`,现为已实现无调用方)把手机接入窗口 Host——这将是该入口的首个生产调用方;Main 维护「Worker WS ↔ attachment port」的帧泵,只做转发。
4. Main 在桌面退出/禁用功能时主动关闭房间并断开出站;接入 Key 与设备吊销列表本地持久化。

## 移动端

- 载体:`packages/web` 完整客户端的构建产物(**镜像 UI**),由 Worker 静态资源托管;新增配对深链接入——从 `/p/<roomId>#<capability>` 深链读取配对参数,完成双方授权后按既有 connectViaWebSocket 流程连到同源 WS。
- 权限镜像:命令面与桌面使用者一致,不做额外缩减;仅 desktop-continuous 专属能力(如视频 preview)按既有档位门禁如实降级。断网重连后按 web-remote-replayable 恢复,已结算事实不丢、可 replay 补齐。
- 启动渲染门禁(2026-09-28 黑屏诊断补充):桌面专用的启动 loading 门禁(`shouldShowRootStartupLoading`)只覆盖桌面,Web/手机在启动解析(鉴权/provider/会话恢复,均经 CF 桥,RTT 显著放大)完成前会落到「无 workspaceShellPath」分支。该分支禁止渲染空 RootShell(表现为整页黑屏),必须渲染与桌面一致的 `RootStartupLoading` 启动页,直至 welcome/工作区内容就绪。
- RPC Initialize 时序(同日诊断补充):host 侧 ChannelServer 仅在创建时发送一次 Initialize,而配对确认触发的 attach 早于手机数据套接字接入(Worker 按 §2.3 原语义丢弃早期帧),60s 宽限内的 resumed 重连又复用 attachment 不重建 ChannelServer——两者都会让手机端全新 ChannelClient 永久停在 Uninitialized,所有 RPC 排队,镜像永远不渲染。修复:(a) Worker 对桥接建立窗口内的 host→手机帧做有界缓冲与回放;(b) resumed 桥接时桌面经 `resend-service-port-init` 请求 host 重发 Initialize。

## 复用现有构件对照

| 现有构件                                                | 位置                                                             | 在本方案中的角色                                 |
| ------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------ |
| 一次性 capability 防重放(30s TTL、consume-once)         | `packages/server/src/hostCapability.ts`                          | Worker DO 同构实现配对 token                     |
| `/ws`(恒 web-remote-replayable)与 `/ws/host` 双路径语义 | `packages/server/src/http.ts:322-343`                            | 协议语义参照;手机按 replayable 档位接入          |
| v4 连接作用域 clientMode/档位权威面                     | `packages/services/src/lcode-agent/lcodeAgentConnectionScope.ts` | 手机连接的可信档位判定,不新增路径                |
| `attachRemoteWorkspaceSessionHost`(无调用方)            | `packages/desktop/src/desktopRemoteSessions.ts:832`              | 手机 attachment 的生产入口                       |
| web-remote-replayable 客户端                            | `packages/web`                                                   | 移动端镜像 UI(完整客户端构建产物,由 Worker 托管) |
| 凭据集中管理                                            | `packages/ui/src/root/remoteWorkspaceHistory.ts`                 | 接入 Key/设备凭据的保存与删除                    |

## 验收

- 桌面处于 NAT 后(仅出站 443)时,手机在异地扫码或打开复制链接 → 完成双方授权 → 可查看当前工作区任务、发送输入、看到流式输出。
- 手机端配对接管后的整个启动解析期间(鉴权/provider/会话恢复未完成时)不得出现整页黑屏或空壳;应显示启动 loading,直至 welcome 或工作区内容就绪。
- 一次性 capability:同一 token 第二次使用被拒;过期被拒;连续失败达阈值房间作废;未授权设备无法获得任何会话数据。
- 桌面「停止」或吊销某设备后,该设备现有连接立即断开且凭据失效;再次连接需重新走双方授权。
- 手机断网后重连(同设备凭据):web-remote-replayable 恢复,已结算事实不丢、可 replay 补齐。
- 设置禁用后,桌面立即断开出站连接且不再重连;主开关关闭时不产生任何出站请求。
- Worker 不持久化任务队列、快照、消息内容(仅鉴权哈希与房间映射,TTL 清理);房间关闭后 DO 状态清空。
- 中英文、桌面窄窗口与手机窄屏均可用;扫码与复制链接两条路径等价。
- 桌面端侧栏 footer 在「连接使用」与「设置」之间显示远程控制快捷入口,点击向上弹出「移动端远程控制」配对弹框(二维码/复制链接/停止/刷新在弹框内完成,不跳设置页);设置侧栏「基础设置」组不再出现该分区,弹框内「远程控制设置」可直达分区;Web/手机视图无此入口,直达意图不得把分区解析回退成 general。
- `cfworker-remote` push 到 GitHub 后,Workers Builds 自动部署,无需本地 wrangler。

## 开放问题(实现前需对齐)

1. 手机 attachment 的 scope 语义:**已定**——本地工作区镜像以 `scope:{kind:"local"}` 第二 attachment 挂到窗口 Host(`attachLocalWorkspaceSessionHost`,注册表按 attachmentId 键控、与 Renderer 共存);远程工作区继续走 `kind:"remote"` 三元组入口。镜像目标为判别联合(`remotePairingMirrorTargetSchema`)。
2. 移动端 SPA 载体:已定——采用 `packages/web` 完整构建产物做镜像 UI,不做裁剪版。
3. Cloudflare 免费额度对 WS 并发/时长/消息量的限制,以及是否需要付费兜底。
4. RPC PersistentProtocol 可靠层(已实现未接线)是否在本项目 v2 接入隧道两端,替换纯透传的 SocketProtocol 语义。
5. 端到端加密是否排期(v1 不做,Worker 可见帧内容需在设置页隐私说明中如实标注)。
