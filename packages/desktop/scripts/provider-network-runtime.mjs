// 网络依赖内部含 CommonJS require；Desktop ESM 必须外置，并在打包时带齐闭包。
// 构建、afterPack 注入和最终校验共用此清单，避免安装包能生成却启动崩溃。
export const providerNetworkRuntimeModules = ["undici", "socks"];
