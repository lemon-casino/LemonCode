# RPC 事件订阅失败隔离

## 规则与所有者

`ChannelServer` 是订阅生命周期与 `activeRequests` 的唯一所有者。
通道的权限校验仍由 `IServerChannel.listen` 执行，不增加允许列表或改变权限。

```text
EventListen → ChannelServer → channel.listen → 订阅成功 → activeRequests
                                           └→ 同步异常 → warn，结束本次订阅
后续 EventListen / Promise → 同一个 ChannelServer 正常处理
```

## 失败语义与边界

- 获取事件或注册监听器抛出同步异常时，不得逃逸到 transport 回调或 pending flush 定时器。
- 失败订阅不得进入 activeRequests；EventDispose 对失败订阅保持幂等。
- 不发送 PromiseError：现有协议没有事件订阅失败响应，客户端没有对应 promise。
- 日志只记录固定诊断文字，不输出订阅参数、凭据或异常携带的业务数据。
- 已注册及延迟注册的通道使用相同路径；桌面和手机共享此边界，不改变传输、配对或重连协议。

## 验收

1. listen 权限拒绝及事件注册异常不逃逸、不发送事件、不保留失败订阅。
2. 失败后合法事件仍可发送，正常订阅可释放，Promise 请求仍成功。
3. 延迟注册通道的 pending flush 遇到失败订阅后仍处理后续订阅。
