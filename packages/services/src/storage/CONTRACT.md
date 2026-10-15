# Storage

资源管理器专用的存储扫描与按类别清理服务；公开接口为 `contract.ts`，共享 DTO 来自 `@lcode/shared`。Desktop Main 持有唯一实例，文件系统与 Worker 由 ports 注入，UI 只消费桥的快照和命令。

分类和清理范围统一由 domain catalog 决定，不以 UI 传入路径执行删除。媒体派生缓存按会话保留七天，编辑器图标缓存保留 24 小时；原始附件、工作树、Git 自动备份、运行时及迁移旧数据不提供整类清理。完整规则见根目录 `specs/resource-manager-storage.md`。

`pnpmCache` 为专用命令类别：Main 注入 runtime-environment 的包缓存清理 port，StorageService 检查迁移根保护后调用，不向通用文件清理器提供候选。命令由托管 pnpm 执行，项目 node_modules 与 tool-store 不在清理范围；忙碌与不可用分别通过 `EBUSY` / `ETOOLUNAVAILABLE` 返回。StorageService 同时仅接纳一个清理请求。

```ts
// UI 沿用 StorageManagementBridge；Main 持有的 IStorageService 实现相同命令。
const result = await storage.clean({ rootId: "home", categoryId: "mediaCache" });
// result 只报告实际删除量；近期缓存和原始产物计入跳过项。
```
