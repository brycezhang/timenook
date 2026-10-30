# 双方确认与首本制作本地验证

2026-10-29 当前方案以 [ADR 0017](adr/0017-lifetime-service-and-retention.md) 为准：制作长期有效；下文按新目标更新，代码对齐与本轮验证尚待完成。历史有限期测试保留为当时结果，不证明新规则已实现。

T22 接入 T10 已核验付款及唯一首本权益、T12 当次协助证据和 T20/T21 确定书稿。当前仍由 `books.mode=synthetic-local` 与 `environment=test` 隔离，只在既有 Book 合成应用中注册路由；默认配置和生产不能启用。D02 长期规则已决定；本票不代替 D01/D05/D06 的真实冻结，不付款、不联系印厂，也不执行 T23 的交接。

## 用户接口

以下路由以 `/v1/projects/:id/first-copy` 为前缀，均要求当前 TimeNook Bearer 会话和项目私人内容权限；写入要求 `Idempotency-Key`。成功返回统一 envelope，私人响应 `Cache-Control: no-store`。

| 路径             | 方法 | 输入与结果                                                                                                                           |
| ---------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `/`              | GET  | 当前书稿、双方有效确认、地址版本/hash、已付金额、制作一本/本次零付款、原订单配送/生产/物流约定、长期权益和拒绝原因                   |
| `/address`       | POST | 发起人提交 `expectedVersion, recipientName, phone, regionCode, detail`；地区必须在原销售快照包含范围内且不在排除范围                 |
| `/confirmations` | POST | `role, bookVersionId, snapshotHash, pdfHash, noticeVersion, evidenceRef`；发起人另传 `addressHash`，当次协助另传 `assistedSessionId` |
| `/submit`        | POST | 发起人提交 `bookVersionId, snapshotHash, pdfHash, addressHash`；唯一预留首本，返回原生产单或冲突                                     |

`noticeVersion=synthetic-d08-v1`，证据引用必须明确以 `synthetic:` 开头。讲述者只看到地址版本及 hash，不返回私人收货字段。讲述者确认内容；发起人确认同一完整 PDF 与当前地址。发起人代操作讲述者确认时，必须有独立、当前有效的 `book_confirmation` 会话，另写本次确定版本证据；录音或故事确认会话不能替代。

书稿内容、实际目录、素材或入书许可变化后，受影响旧书稿及双方确认失效。地址实际变化只使发起人确认失效；即使地址由 A 改为 B 再改回 A，也必须重新确认，因为确认同时绑定地址版本及 hash。重复保存相同规范化地址不制造新版本。

事务锁定当前会话/项目/讲述者后，重新读取真实付款事务、唯一权益、当前完整 PDF、故事许可、授权与 epoch、现有撤回/删除工单、购买时规格和双方确认。权益必须可用；`suspended` / `revoked` 阻止提交及审核。后两者是消费后续 Commerce 退款/核验动作的既定状态契约，本票没有实际退款接口或资金操作。书稿必须匹配销售快照的尺寸、出血及页数范围，不能用前端按钮放行超规格内容。

成功预留在同一事务内写唯一首本单、权益 `reserved`、审计事件和持久 Outbox。一个项目、付款订单和权益分别唯一；同键同载荷及不同键并发返回同一生产单，同键异载荷或已预留单不同内容返回 409。Outbox 仅保存交接事实，T22 没有新增队列或自动向印厂提交。

## 生产审核与长期制作

`POST /v1/admin/first-copy/:id/approve` 的 `:id` 是生产单 ID，输入为同一组四项版本/hash 绑定。要求独立管理员飞书会话、CSRF、`fulfillment:write` 和幂等键，由 AdminAccess 同事务审计。审核再次执行付款、权益、当前版本、许可、授权、冻结、规格和双方确认，不设置服务期限门禁。返回仅需项目与生产信息，不返回私人书稿全文或地址，也不授予运营私人内容读取权限。

制作长期有效，符合付款权益、当前授权和同版确认条件时可随时提交首本。移除 `/expiry-review`、`first_copy_expiry` 工单及暂停/恢复计时操作；时间推进不能转入人工到期审核。若底层日期必须填写，固定 2099-12-31 仅作占位，后台不可配置，用户端不显示倒计时。退款冻结、权益终止、争议 hold 和主动撤回仍按实际规则限制生产，不属于服务计时。

## 复现

新验收须覆盖跨时间提交/审核与重启、旧期限入口移除，同时复验并发唯一预留、同版确认和撤回。以下入口可复用，实际结果须按新提交留证。

先按[本地开发](development.md)准备回环 PostgreSQL/Redis、Node 22.23.4、pnpm 10.34.7、固定字体及 Chromium。API 测试只使用可丢弃独立 schema；微信、支付、ASR/文本边界均为明确合成替身。

```bash
pnpm db:generate
pnpm --filter @timenook/contracts build
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
cd apps/api
node --env-file=../../.env --test dist-test/test/first-copy.test.js
```

真实 PDF 样本使用独立合成套餐，`minPages=1, bleedMm=0` 与 T20 当前固定候选渲染器匹配。默认销售夹具仍是 `minPages=48, bleedMm=3`，不会为演示放宽。真实印厂规格、实际商业规则、双端微信双方确认/协助和实物交接仍按责任票验收。工程证据见 [T22 后端](delivery/2026-10-22/evidence/T22-backend.md) 和 [T22 汇总](delivery/2026-10-22/evidence/T22.md)。
