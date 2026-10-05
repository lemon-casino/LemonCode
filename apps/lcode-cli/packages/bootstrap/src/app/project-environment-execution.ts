import type { ExecutionEnvOverlay, ExecutionPort, ExecutionRequest } from "@lcode/contracts";

/**
 * 项目冻结环境覆盖（spec: specs/worktree-runtime-environments.md §9.3，P2-03）。
 * 解析器按 spawn cwd 查询所属托管环境；无命中返回 undefined，保持非托管继承语义。
 */
export type ProjectEnvironmentOverlayResolver = (
  cwd: string | undefined,
) => Promise<ExecutionEnvOverlay | undefined>;

/**
 * 合并规则（spec §9.3 固定）：请求自带 set 覆盖冻结 set（Hook 插件变量等优先）；
 * unset 取并集；base 以请求为准，缺省继承。
 */
export function mergeProjectEnvOverlay(
  request: ExecutionRequest,
  frozen: ExecutionEnvOverlay,
): ExecutionRequest {
  const own = request.env;
  const set = { ...frozen.set, ...own?.set };
  const unset = [...new Set([...(frozen.unset ?? []), ...(own?.unset ?? [])])];
  const base = own?.base ?? frozen.base;
  const env: ExecutionEnvOverlay = {
    ...(base ? { base } : {}),
    ...(Object.keys(set).length ? { set } : {}),
    ...(unset.length ? { unset } : {}),
  };
  return { ...request, env };
}

/**
 * 在执行端口外包装一层：每次 run/start（前台/后台/Hook 均经同一端口）前解析冻结覆盖并合并。
 * 解析失败按非托管继续，不阻塞 spawn（spec §9.5 兼容语义）。
 * 类实例不能靠对象展开复制原型方法，因此逐方法显式委托。
 */
export function createProjectScopedExecutionPort(
  base: ExecutionPort,
  resolve: ProjectEnvironmentOverlayResolver,
): ExecutionPort {
  const withOverlay = async (request: ExecutionRequest): Promise<ExecutionRequest> => {
    try {
      const frozen = await resolve(request.cwd);
      return frozen ? mergeProjectEnvOverlay(request, frozen) : request;
    } catch {
      return request;
    }
  };
  const port: ExecutionPort = {
    run: (request, options) => withOverlay(request).then((value) => base.run(value, options)),
  };
  if (base.start)
    port.start = (request, options) =>
      withOverlay(request).then((value) => base.start!(value, options));
  if (base.getBackgroundTask)
    port.getBackgroundTask = (taskId) => base.getBackgroundTask!(taskId);
  if (base.waitForBackgroundTask)
    port.waitForBackgroundTask = (taskId, options) => base.waitForBackgroundTask!(taskId, options);
  if (base.readBackgroundBashOutput)
    port.readBackgroundBashOutput = (taskId, sessionId) =>
      base.readBackgroundBashOutput!(taskId, sessionId);
  if (base.cancelBackgroundTask)
    port.cancelBackgroundTask = (taskId) => base.cancelBackgroundTask!(taskId);
  if (base.close) port.close = () => base.close!();
  return port;
}
