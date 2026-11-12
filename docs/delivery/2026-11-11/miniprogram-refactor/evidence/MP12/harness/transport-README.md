# PrintUnknown 真实提交丢响应夹具

`transport.cjs` 默认在 `127.0.0.1:3430` 代理 `127.0.0.1:3428`。它仅模拟网络丢失：真实 `POST /v1/projects/:id/first-copy/submit` 的成功响应完整到达后，才丢弃响应并关闭客户端连接。服务端事务照常提交；其余 API、上传和 PDF 字节透传。没有修改业务 API、`wx.request` 或页面业务状态。

```sh
node docs/delivery/2026-11-11/miniprogram-refactor/evidence/MP12/harness/transport.cjs serve
```

私有 manifest 位于 `test-results/mp12-transport-native/fixture.json`，目录 0700、文件 0600；包含 `proxyApiBase`、PID、控制与状态文件位置。代理只允许 HTTP loopback 上游，不操作 PostgreSQL／Redis，不停止 3428／3429。端口占用时直接失败。

1. 只在隔离的原生构建副本中，将 API base 改为 `http://127.0.0.1:3430/v1`，重新启动并使用 3428 manifest 身份走真实登录。会话和 print intent 按 API base 隔离，不能直接沿用 3428 的客户端缓存。
2. 使用待提交的真实就绪 PDF 和有效地址，进入确认制作页。先协调项目，避免消耗其他待验场景。
3. 在仓库根目录执行 `node docs/delivery/2026-11-11/miniprogram-refactor/evidence/MP12/harness/transport.cjs arm PROJECT_ID`，再点击实际提交按钮。
4. 代理只有在该项目 POST 提交成功后才丢响应。页面应进入 PrintUnknown，保留本次真实幂等键及固定摘要；先截图，再点击查询制作状态，恢复已提交生产单。

`status` 返回脱敏阶段、丢弃次数及上游 HTTP 状态；`disarm` 取消下一次匹配。控制通过本机私有文件传递，没有额外 HTTP 管理端点。非成功提交照常返回且保持待触发；成功丢失一次后自动解除。GET 查询及其他项目请求不会被丢弃。

可选环境变量：`TIMENOOK_REPO`、`TIMENOOK_MP12_PROXY_PORT`、`TIMENOOK_MP12_PROXY_UPSTREAM`（必须 loopback 且路径 `/v1`）、`TIMENOOK_MP12_TRANSPORT_DIR`。验证时可设端口 `0`，从私有 manifest 读取实际端口。向 manifest 的 PID 发送 SIGTERM 只关闭代理并删除自身控制文件，保留上游服务与业务数据。

2026-11-12 在单独临时 schema／Redis 前缀和新项目完成真实集成验证，随后已清理该测试 API：PDF 字节／SHA256 及 Range 请求结果与上游一致；上游 201 后丢响应，首次命令仍已提交；原键重放仍为同一生产单，数据库只有一条 `FirstCopyOrder` 和一份首本权益；只丢一次，manifest 为 0600。上游 PDF Range 请求实际返回完整 200，代理保持该行为。

正式供验收的 3430→3428 又通过真实登录和固定 PDF hash 只读检查，未修改 3428 的任何业务场景。以上证明传输夹具和真实事务，不代替原生 PrintUnknown 截图／交互或真实印厂与实物验收。
