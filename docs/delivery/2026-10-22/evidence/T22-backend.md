# T22 后端本地工程证据

## 边界与依赖

基线 `ca57d1c2183f4bc42b680674213bc71ac9c4272f`。复用 T21 PR #57 / main CI 40269778533、T20 不可变书稿/真实 PDF、T10 核验付款/唯一权益/旧销售快照时钟、T11 当前授权与 epoch、T12 独立 `book_confirmation` 协助证据。保留上游原生依赖与真实条件；只在已有 `environment=test` / `books.mode=synthetic-local` 范围中实施。

按 T22 约定公开 HTTP 与真实 PostgreSQL 并发边界实现，Redis 及共享渲染 Worker 同样实际运行。微信、支付和 AI 网络是明确的外部合成替身，没有真实资金、私人采集、云端部署或开售。独立套餐在订单创建前设置 `minPages=1, bleedMm=0`，不改默认销售夹具，也不改已付款不可变快照。

## 实现

- 双方确认绑定同一书稿 ID / snapshot hash / PDF hash，发起人另绑定当前地址 hash 与版本；地址 A→B→A 不恢复旧确认。当前书稿/目录/入书许可变化后旧确认失效。
- 当前讲述者本人确认；发起人代操作须以有效 `book_confirmation` 会话写独立的本次确定版本证据，故事或采集用途不能代替。
- 受保护事务消费真实付款事务、唯一权益、授权、当前版本和全部故事许可、撤回/删除工单、销售快照规格、双方确认及 T10 时钟。权益 `suspended` / `revoked` 为后续 Commerce 冻结的消费契约；本票没有退款申请或资金执行。
- 唯一生产单与权益预留、审计事件和 Outbox 同事务写入；8 路同键/不同键并发只返回一个生产单，重放不再付款，载荷不同返回 409。没有新建调度队列或外部印厂调用。
- 管理审核复用门禁和 AdminAccess MFA/权限/CSRF/事务审计。响应仅含生产单绑定与到期工单，私人正文、地址不返回。在线改稿后，即使此前审核通过，再审仍不能沿用旧版。
- 暂停拒绝提交/审核；恰好到期或之后按已选合成政策创建唯一 `first_copy_expiry` 工单，不预留新生产、不删除资料。通用 D08 本人申请核验不能处理这种运营期限工单，也不能借工单状态放行。

## RED → GREEN

日志保存在仓库外 `/tmp/timenook-t22-backend-*.log`，文件名对应行为。

| 切片                                | RED                                          | GREEN                                                       |
| ----------------------------------- | -------------------------------------------- | ----------------------------------------------------------- |
| 当前项目与已付金额 context          | `red-context` 缺路由 404，预期当前会话 401   | `green-address` 中 context 与地址 2/2                       |
| 发起人地址/购买地区/重放/讲述者隐私 | `red-address` 缺路由 404，预期讲述者禁止 403 | `green-address` 2/2                                         |
| 8 路首本预留                        | `red-submit` 404                             | `green-submit` 1/1，所有 ID 相同，同键异载荷 409            |
| 到期并发工单                        | `red-expiry` 404                             | `green-expiry` 5/5，含恰好到期及之后、唯一工单且 PDF 仍可读 |
| 管理审核                            | `red-admin` 404                              | `green-admin` 1/1，权限拒绝/合规审核/在线改稿拒绝           |
| 地址 A→B→A                          | `red-address-cycle` 旧确认错误恢复 true      | `green-address-cycle` 1/1，地址相同 hash 仍须重新确认       |
| 到期工单不能走通用 D08 核验         | `red-expiry-verify` 错误接受 201             | `green-expiry-verify` 1/1，拒绝 409，原生产仍 reserved      |

确认切片最初的夹具错误尝试修改已付款快照，被数据库不可变约束拒绝；随后独立套餐出血 3mm 与候选 PDF 0mm 不符，规格门禁正确拒绝。均已改为创建订单前的独立合成套餐，这些夹具失败不计作业务 RED。删除冻结回归最初误传 D08 notice/evidence 给既有申请 DTO，被白名单 400 拒绝；仅修测试载荷，没有放宽 API。最初使用未约定 `frozen` 权益状态的夹具也被约束拒绝，后按已定模型改为 `suspended` / `revoked`，不据此声称真实退款验收。

## 回归结果

首轮固定候选 T22 **14/14**，日志 `/tmp/timenook-t22-backend-first-copy-final.log`。覆盖 context/地区/隐私、确定 PDF 与地址失效、8 路唯一预留、到期边界/并发工单、管理员权限/当前版本/最少响应、地址循环、通用核验拒绝、缺确认/超规格、故事许可/删除冻结、暂停恢复、当次协助、缺付款证明及权益 suspended/revoked。

相关 T10 付款、Book PDF、Participation 和 Admin **73/73** 通过；同次组合含初版 T22 13 项，整体 85/86 的唯一失败是上文删除申请夹具载荷，日志 `/tmp/timenook-t22-backend-related-final.log`。仅修夹具后另跑最终 T22 14/14；不把两轮虚写成一次 87 项全量。API 类型检查已成功（root 最终全工作区类型/构建/OpenAPI 与浏览器结果见汇总），固定提交审查和 PR/main CI 由 GitHub 交付评论补齐。每次 `startBookFixture` 在真实 PostgreSQL 独立 schema 执行全部迁移及重放；本票新增唯一约束、状态/归属检查和不可变确认/生产绑定，不修改既有业务数据。

复现命令与公开字段见[首本开发说明](../../../development-first-copy.md)。T22 本票真实参数、微信双端双方确认/同机协助和纸书交付仍未验收；T23 生产交接、T27 真实退款、T29 正式环境继续另票。本票工程完成只用 Refs #23，不能据合成结果关闭 issue。

## 独立审查后的手机号修复

固定候选 `5ee11b6` 的 Spec 审查指出：原手机号表达式允许空格及纯连字符，保存时 trim 成空串仍可返回 201。新增公开 HTTP 回归先复现两个实际 RED：六空格手机号保存错误 201（预期 400）；存量坏地址保留原确认绑定时，首本提交错误 201（预期 409）。日志 `/tmp/timenook-t22-backend-red-phone-review.log`。

DTO 与事务内地址核验现在共同使用页面既有的 `/^1\d{10}$/` 规则。新输入的空格、纯连字符、错误长度、非数字或不以 1 开头均返回 400；有效手机号保存和同键重放保留原地址版本。事务读取已有地址时同时检查 phone 为字符串且符合该规则，坏记录产生 `ADDRESS_REQUIRED`，禁止预留和管理审核。恢复损坏夹具验证提交及管理审核均返回 409，已预留单保持 reserved；未修改生产规格、商业规则或数据库结构。

新增定向 **2/2** GREEN，日志 `/tmp/timenook-t22-backend-green-phone-review.log`；修复后的完整 T22 **16/16**，日志 `/tmp/timenook-t22-backend-phone-review-final.log`。API typecheck、build 与差异空白检查通过，构建日志 `/tmp/timenook-t22-backend-phone-review-build.log`。其他业务代码未变，相关 73 项回归按原适用范围复用；最终固定提交的复审与 CI 另由 GitHub 交付记录确定。
