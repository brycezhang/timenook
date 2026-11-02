# 固定套餐发布与受控 1 分订单（#142）

基线 `76521a5`，父规格 #141。此文记录工程实现；没有部署、真实收款/退款、Pixel 7 或实物验收结论。真实运行由集成票另行记录。

## 行为

- 复用既有不可变目录及普通商户 PaymentOrder。正式发布不再受 production 环境的无条件禁止；完整 D01、D02–D08 和地区名称仍按现有校验，具备 `catalog:freeze` 权限的运营须明确确认真实材料后发布。结构校验和运营确认不等于程序核实了引用材料真实性。
- 普通版本 `purpose=production`，标价与实付均为 99900 分。完整真实商业材料仍未提供，本轮只在隔离测试中使用明确合成夹具验证发布/下单，不声称正式商业全链、渠道/印厂审核完成。
- `purpose=e2e` 使用固定当前验收快照：一个人生项目、一位成年讲述者及一位发起人、首本权益一本，沿用现有验收额度和长期服务。D01 标明候选/未获商业审批；不复制合成商业审核或假装实体书规格已定。
- E2E 标价 99900、实际 1 分，`listAmount`、`amount`、`isE2e` 独立持久化并返回。客户端不接受金额、折扣或 e2e 参数。用户必须在服务端开关及产品用户 UUID allowlist 中；准备支付时再次检查资格。
- 匿名及非白名单账号不读取 E2E 版本或验收条款；有真实普通版本时读取该版本，否则保留准备中。白名单账号登录后读取 E2E 版本、999 元标价和 1 分 checkout。
- 微信请求、通知/查单核验、交易入账、退款余额及退款外发均按实付 amount。复用原通知 Inbox、原单查单、事务和唯一约束激活同一项目、subject、计划、首本权益及长期服务；不会创建 `InternalProjectAdmission`。
- E2E 参与、邀请、故事确认采用 `paid-e2e-participation-v1`，`source=paid`、`policyStatus=paid-e2e`、证据前缀 `internal:`；内容明确本次为真实 0.01 元验收。既有无付款内测模式保留独立提示。原有内部供应商装配继续提供录音、照片、转写、整理及候选 PDF。
- E2E 书稿保持候选规格、`physicalProduction=false`，完整 PDF 的本人/发起人确认使用 `paid-e2e-book-confirmation-v1`。付款身份不成为讲述者；两人确认仍由各自账号完成，协助故事确认仍逐次重验当前协助会话。
- 当前验收退款固定为实际收到的 1 分：未参与从付款、已使用未投产从首次使用起 365 个自然日内申请，核验后 7 个自然日内处理；终止制作及首本权益，不自动删除资料。该条款仅属于本次受控验收，不替代未定的商业 D07。任何退款规则金额均不得超过原订单实付。

## 接口与发布

公开接口沿用 `/v1`（公网入口为 `/api/v1`）：

- `GET /packages/current` 可带产品 Bearer；失效 Bearer 返回 401。`version` 增加 purpose 与 `shippingRegions:[{code,label}]`；`checkout` 为 null 或 `{listAmount:99900,amount:1|99900,currency:"CNY",isE2e:boolean}`。
- `POST /orders` 沿用 packageVersionId、recipient、shippingRegionCode、subjectName/bookTitle，不增加客户端价格字段。`GET /orders`、`GET /orders/:id`、`POST /orders/:id/payment`、`POST /orders/:id/close` 保留原单恢复语义。
- 管理员 `POST /admin/catalog/package-drafts/:id/publish`：`{expectedRevision,confirmRealParameters:true}`；同修订重复发布返回原版本。若该修订已冻结为本地预览，先保存新修订再正式发布。后台提供真实材料复选确认和独立的正式发布按钮。
- 管理员 `POST /admin/catalog/e2e-versions`：`{}`；同 realm 幂等返回本次固定验收版本，不依赖未知商业材料。后台提供明确的受控 1 分发布按钮。两条路径均复用权限、Origin、CSRF、事务及审计。

新增服务端配置（空值为关闭，关闭时清除两项）：

```dotenv
TIMENOOK_CHECKOUT_E2E_ENABLED=1
TIMENOOK_CHECKOUT_E2E_USER_IDS=<实际产品用户UUID，多个用逗号分隔>
```

同时保留已验证的 `TIMENOOK_WECHAT_PAY_MODE=ordinary-merchant`、`INTERNAL_ACCEPTANCE_ENABLED=1` 及当前 product OSS/ASR/DeepSeek/book 装配。UUID 不使用 OpenID；密钥、会话、用户身份和值不进入 Git。本次已有线上运行环境为 development，目录 realm 为 local；用途 e2e/production 与 realm 独立。production realm 的管理发布也有 HTTP 回归。

部署依序执行契约构建、Prisma generate/migrate、API/Admin 构建，重启后发布 E2E 版本。无可复用飞书会话时，受授权服务器运维入口可运行同一个 `Catalog.publishE2e(tx)` 用例：

```sh
node --env-file=.env --env-file=.env.internal-acceptance \
  apps/api/dist/catalog/catalog-cli.js publish-e2e \
  --operator-label authorized-e2e-20261102
```

该命令如实记录 `operatorId=null`、`action=catalog.e2e.publish.server` 和运维运行标识，不伪造飞书登录或商业审批；只输出公开版本 ID、序列、用途和标价。常规管理 UI 发布仍使用真实管理员会话。

## 定向验证

真实本机 PostgreSQL/Redis、隔离 schema/namespace；微信、飞书外网仅在隔离测试使用显式协议替身，没有真实资金。

- 新 HTTP 5 项：固定发布/资格隔离、服务端定价和幂等、实际 1 分验签/并发通知查单激活、本人用途授权及非内测双挂、1 分退款原额外发、完整参数普通发布/999 下单。
- 目录 HTTP 17 项（含 production realm 发布）与上述新用例合计 22/22。
- 既有 payments、ordinary runtime、participation、story confirmation 相关回归通过；退款常规 17 项通过，3 项 PDF 前置因初始工作树缺少忽略的固定字体而失败。补入原工程固定字体并通过 SHA-256 校验后，受影响 3/3 通过。
- PDF 核心针对性复测 3/3：中文提取、独立双方同版内容确认/候选 PDF、完整生产任务及下载 hash。未再次重复整个 PDF 矩阵。
- Admin 类型检查/构建、API 构建与测试编译通过。后台浏览器验证关系/缺参预览、明确材料确认后正式发布、999 版本及移动布局；使用合成登录和商业夹具，不代表真实管理员/商业审核。
- RED 证据包括：原普通商户创建订单固定 403（新增 1 分用例失败）；原付费项目误返回无付款 internal 提示（新 paid-e2e 提示断言失败）；原退款 DTO 不接受真实验收证据前缀（新退款请求 400）。对应实现后通过。

Refs #142 #141。实际部署、供应商、真实资金、双方设备/目标用户及实物结果分别记录，不能由上述工程验证推断完成。
