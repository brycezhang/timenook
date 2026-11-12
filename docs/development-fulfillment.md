# 制作进度与人工交付

2026-11-12 当前路径为成员提交确定书稿与地址、运营安排制作、记录完成印制、发货和交付。系统保存并核验生产事实，不自动向印厂下单。首本预留见[首本制作](development-first-copy.md)，当前小程序路径及验证见 [MP11](delivery/2026-11-11/miniprogram-refactor/MP11-delivery.md)。

## 用户读取

| 接口 | 内容 |
| --- | --- |
| `GET /v1/projects/:id/fulfillment` | 当前预留、本次尝试、历史尝试、实际物流与固定收货地址 |
| `GET /v1/projects/:id/fulfillment/book` | 本次制作绑定的书稿信息 |
| `GET /v1/projects/:id/fulfillment/book/pdf` | 本次固定 PDF，经当前成员权限与制作绑定核验后返回 |

`current` 只指向当前 `reservationRevision` 的尝试。确认取消后新预留尚未建立尝试时为 `null`，不会继续显示旧尝试的取消状态。历史尝试仍在 `attempts` 中。`deliveryAddress` 来自本次尝试或预留的地址快照，不跟随后来的地址编辑变化。

制作页的查看书稿始终使用上述固定版本接口。书名、封面或正文后来变化可以使普通旧稿变为 `obsolete`，但不替换已提交的 PDF；文件完整性及当前访问权限仍需核验，核验删除后禁止读取。

## 运营路径与一致性

具有 `fulfillment:write` 的独立管理员在「生产与物流」按原销售规格安排印厂并建立尝试，保存处理人、工单、交接编号与期限。资料读取、批准和交接均校验已预留的固定文件、地址、权益与当前权限，不以新编辑稿取代原稿。

运营接口前缀 `/v1/admin/fulfillment`，`:id` 为生产单 ID：列表/详情、`/:id/attempts`，以及 `/:id/attempts/:attemptId/{materials,pdf,handoff,receipt,cancel,printing,wechat,shipping,delivery}`。资料和 PDF 为 GET，其余动作使用 POST；写入沿用管理员会话、CSRF、权限及事务审计。用户不再经过旧版单独资料授权页。

接单仅表示正在制作；完成印制为独立事实，发货前必须已有该事实。物流和微信发货处理结果分别记录，页面不将接口成功当作印好、发出或实际送达。PDF 读取前后和活动流中持续核验授权、版本/hash，避免在失权后继续交付文件。

交接结果未知时保持待核实，不能通过重试制造新交接或释放权益。交接前可以结束尝试；交接中请求取消后须核实供应商明确回执。确认取消才允许按当前稿和地址重提，沿用原生产单及权益并递增预留版本；原尝试、PDF 与地址保留。取消未成功时继续原实际制作状态。

交付保存唯一事实及原始发生时间；重放不能改变交付时间，也不启动资料到期时钟。已离开平台的纸书或文件副本由实际印厂处置，系统不承诺远程自动撤销。

## 验证

真实 PostgreSQL/Redis 与隔离 schema 验证生产、取消和固定文件一致性；支付、印厂、物流为明确夹具。编译后从 `apps/api` 执行：

```sh
node --env-file-if-exists=../../.env --test dist-test/test/fulfillment.test.js
```

现行结果见 [MP11](delivery/2026-11-11/miniprogram-refactor/MP11-delivery.md)和[固定稿修复](delivery/2026-11-11/miniprogram-refactor/review-fixes.md)。[T23](delivery/2026-10-22/evidence/T23.md)保留早期工程记录，真实供应商、微信发货及实物结果另行验收。
