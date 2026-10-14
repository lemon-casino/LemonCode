# Window controller 与 workspace attachment

Controller 只聚合任务列表投影与列表写路由。`IWindowWorkspaceService` 提供已授权窗口的远端目录与 scoped 服务代理；文件、Git、工作树、conversation 等业务仍由注册表当前 source 的公开服务执行。

目录由 WindowRemoteConnectionRegistry 的当前 session 派生。调用必须包含完整 session/path/identity/generation；离线、换代、错 scope 及迟到回包拒绝，不回退本机。目录订阅先于初读，客户端以事件代际丢弃旧初读。每设备 carrier 复用既有 continuous/replayable wrapper，释放 facade 只清理当前 attachment 的订阅和 carrier。

客户端接口示例：

```ts
const catalog = await services.windowWorkspaceService.getCatalog();
const entry = catalog.find((entry) => entry.sourceAvailability === "online");
if (entry) {
  const workspace = services.createWorkspaceServiceAccessor(entry.scope);
  const bindings = await workspace.worktreeService.list({
    workspacePath: entry.scope.workspacePath,
    workspaceIdentity: entry.scope.workspaceIdentity,
  });
}
```

factory 是客户端本地适配器，call/listen 和目录是 RPC 接口。目录不包含认证字段，内部 channel 不在 scoped 服务面。新配对 attachment 绑定窗口 Local Host，不绑定当前项目。该接口不拥有 accepted 输入、runtime 或连接生命周期。
