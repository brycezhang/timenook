# T22 前端工程证据

## 范围与边界

基线 `ca57d1c2183f4bc42b680674213bc71ac9c4272f`，消费 T20/T21 已合并的确定书稿、受鉴权的 PDF 下载及临时文件清理。沿 T22/父规格已约定的 Page、平台请求与行为边界实施；不读取 live 模式以外的演示资料，不调用支付，不启用正式生产。

已有成书和完整书稿页携带 `projectId/versionId` 进入首本确认页。首本页显示购买时的付款、一本权益与配送约定；讲述者本人确认本版内容，发起人确认同一完整 PDF 与当前地址。所有写入使用服务端返回的书稿、snapshot/PDF hash 和地址版本/hash，服务端重新核验仍为权威。选择框及 3–160 字独立说明均须由当前操作人明确填写，不自动勾选。

发起人可从首本页进入当次 `book_confirmation` 同机协助；该证据与采集、故事确认分开。返回精确版本后，仍须本人逐页核对 PDF 并独立确认。完整 PDF 复用原完整书稿页的下载、SHA/字节校验与查看器，不引入另一个渲染或文件网关。

地址更改清空本次发起人选择，未保存时不能确认/提交；服务端保存后保留讲述者同版确认，使发起人重新确认。未知提交结果保留原幂等键用于当前页面重试。服务器返回过期时提供独立人工审核申请，只记录共享工单；不预留首本、不支付、不删除资料。

## 公开行为 RED → GREEN

| 切片 | 首次失败与最终行为 | 日志（Git 外） |
| --- | --- | --- |
| 固定版本导航 | 原 live print 入口返回首页；现在 Book/Manuscript 均进入精确版本首本页 | `/tmp/timenook-t22-front-navigation-{red,green}.log` |
| 首本状态 | 原 print 页无 live onLoad、读取演示资料；现在只查询 HTTP 权益/配送快照 | `/tmp/timenook-t22-front-context-{red,green}.log` |
| 地址保存 | 原页无配送地区和服务端地址保存；现在提交 observed address version，返回失效的发起人确认 | `/tmp/timenook-t22-front-address-{red,green}.log` |
| 本人内容确认 | 原无 live 确认；现在绑定 book version/snapshot/PDF 三元组、明确选择及独立证据 | `/tmp/timenook-t22-front-confirm-{red,green}.log` |
| 首本提交 | 原提交尝试演示 store；现在仅提交已确认书稿/地址，网络未知后同键重试并显示唯一生产单 | `/tmp/timenook-t22-front-submit-{red,green}.log` |
| 制作到期人工审核 | 原无独立入口；现在无 PDF/地址也可按服务端许可申请人工核验 | `/tmp/timenook-t22-front-expiry-{red,green}.log` |
| 当次书稿协助 | 原只支持故事确认协助；现在单独记录 book_confirmation 后返回指定书稿 | `/tmp/timenook-t22-front-assisted-{red,green}.log` |
| 私有资料到期 | 原确认响应恰好到期仍保留书稿；现在在响应结束时清理书稿、地址及独立说明 | `/tmp/timenook-t22-front-expiry-private-{red,green}.log` |
| 改地址清选择 | 原保留旧的发起人勾选/说明；现在立即清空并阻止未保存地址的确认/提交 | `/tmp/timenook-t22-front-address-choice-{red,green}.log` |
| 换号前置清理 | 原计时器前可用新账号发送旧页面书稿命令；现在清屏并拒绝发出 | `/tmp/timenook-t22-front-account-{red,green}.log` |
| 制作期限等号边界 | 原已知截止时间到达后仍发送提交；现在立即禁止提交并提示重新查询人工审核 | `/tmp/timenook-t22-front-creation-{red,green}.log` |
| 协助核对 PDF 后返回 | 原从完整书稿返回时丢失当次协助标识；现在往返携带同一标识，后端仍重新检查有效性 | `/tmp/timenook-t22-front-assisted-pdf-{red,green}.log` |
| 确定文件响应校验 | 原接受 ready PDF 的空 SHA；现在拒绝缺失的 snapshot/PDF hash，不能进入确认 | `/tmp/timenook-t22-front-response-{red,green}.log` |
| 浏览器请求适配 | 实际浏览器发现 first-copy 查询/命令被旧白名单拒绝；最小补充 GET 与四个 POST，未知路由及 DELETE 仍拒绝 | `/tmp/timenook-t22-front-preview-{red,green}.log` |

另验证旧书稿/超规格不提交、403 清除私有资料、离页后迟到 HTTP 不恢复内容。测试固定时间及 HTTP/微信边界替身；不以这些用例作为真实微信设备结果。

## 验证

- `pnpm exec tsx --test tests/first-copy-page.test.ts tests/book-page.test.ts tests/participation-page.test.ts tests/session.test.ts tests/model.test.ts`：**104/104**，其中首本 Page **12/12**。日志 `/tmp/timenook-t22-front-regression.log`。
- `pnpm exec playwright test -c playwright.admin.config.mjs tests/admin/first-copy-preview.spec.mjs`：**1/1**。在真实浏览器调用 `window.wx.request`，以 HTTP 边界合成响应核对 GET/四个 POST 的方法、载荷及幂等头；不替代完整业务浏览器联调。日志 `/tmp/timenook-t22-front-preview-green.log`。
- `pnpm typecheck:frontend`、`pnpm build:frontend`：成功。日志 `/tmp/timenook-t22-front-types-final.log`、`/tmp/timenook-t22-front-build.log`。
- `pnpm check:native`：Mac 微信 `wcc/wcsc` 各 **20 页**成功。日志 `/tmp/timenook-t22-front-native.log`。编译不代表设备实测。

Browser plugin not available。实际浏览器 HTTP/PDF/地址/双方确认/首本提交、390×844 与 1280×900 截图及控制台检查由主 Agent 使用仓库 Playwright 单独执行，最终结果以 [T22 汇总](T22.md) 为准。

正式 D01/D02/D05/D08、微信账号与双端真机、印厂实物和实际生产仍由责任票验收；本票保留未完成外部条件，不因本地合成测试关闭 issue。
