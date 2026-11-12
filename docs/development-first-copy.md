# 首本制作

2026-11-12 按[当前业务流程](../designs/timenook-modern-2026-11-10/project/BUSINESS-FLOW.md)和 [MP11](delivery/2026-11-11/miniprogram-refactor/MP11-delivery.md)执行。项目成员在当前 PDF 就绪后填写地址并提交制作，不再要求双方确认或协助确认。购买时不收地址。

## 用户接口

前缀 `/v1/projects/:id/first-copy`；要求产品会话及项目权限，写入要求 `Idempotency-Key`，私人响应禁止缓存。

| 路径 | 方法 | 输入与结果 |
| --- | --- | --- |
| `/` | GET | 当前书稿、地址版本/hash、首本权益、已提交生产单及阻断原因 |
| `/address` | POST | `expectedVersion, recipientName, phone, regionCode, detail`；按原销售快照核验配送范围 |
| `/submit` | POST | `bookVersionId, snapshotHash, pdfHash, addressHash`；预留唯一首本，返回生产单或冲突 |

提交时核验当前完整 PDF、真实付款与唯一权益、项目与资料权限、印刷规格和地址。事务锁定项目并保存书稿、PDF 与地址快照/hash；同键同载荷及合法并发保持同一生产单，同键异载荷拒绝。小程序在请求前保存原键、绑定与展示摘要，响应未知先查询，不能以超时另造一次提交。

提交后新故事、改稿或改地址不覆盖本次制作内容。成员通过 `GET /v1/projects/:id/fulfillment/book` 读取已提交版本，通过 `/fulfillment/book/pdf` 读取固定 PDF；普通旧稿预览仍拒绝过期版本。访问始终检查当前成员权限、制作绑定及文件 hash，不绕过核验删除等权限拒绝。

## 审核与取消后重提

`POST /v1/admin/first-copy/:id/approve` 的 `:id` 是生产单 ID；要求独立管理员会话、CSRF、`fulfillment:write` 与幂等键。核验预留的版本/hash、原地址快照、付款、权益、权限及规格；不要求该书稿仍是最新编辑稿，不重建双方确认门槛。

印厂明确确认取消后，成员可用当前就绪书稿及地址重提。沿用原生产单和首本权益，递增预留版本，旧尝试及原 PDF/地址保持不变；取消待核实期间不释放权益。详见[生产与物流](development-fulfillment.md)。按 [ADR 0017](adr/0017-lifetime-service-and-retention.md)，长期制作资格不增加首本数量，也不取消付款、权限或唯一权益校验。

## 验证

先按[本地开发](development.md)准备 PostgreSQL/Redis、固定字体及 Chromium。在仓库根目录编译，再从 API 目录执行：

```sh
pnpm db:generate
pnpm --filter @timenook/contracts build
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
cd apps/api
node --env-file-if-exists=../../.env --test dist-test/test/first-copy.test.js
```

当前工程结果见 [MP11 交付](delivery/2026-11-11/miniprogram-refactor/MP11-delivery.md)及[固定稿修复](delivery/2026-11-11/miniprogram-refactor/review-fixes.md)。测试使用真实本地 PostgreSQL/Redis 与真实 PDF；支付及印厂结果为明确夹具，不代表真实资金或实物交付。早期双方确认方案的历史证据保留在 [T22](delivery/2026-10-22/evidence/T22.md)，不作为当前接口要求。
