# T05 销售参数与准入配置核验

这是待人工填写的决策文件与本地完整性检查，不是套餐发布或开售入口。当前 [决策文件](commerce-decisions.json) 的 D02–D08 均未冻结，真实平台、供应商和本人授权流程证据仍待补齐。代码不核验证据真实性，不检查引用是否存在，也不能代替平台准入、本人授权、合同审核或履约验收。

## 首版使用范围

按[固定首版政策](spec.md#首版固定政策)，只冻结并交付一份实际配置；下文枚举描述现有检查器能表达的格式，不是要求生产执行所有分支。相同条款可在多类资料中引用同一决策，制作、访问、导出和保留的语义仍分开。既有检查器及 JSON 本轮不修改，真实值与证据仍待负责人冻结；结构完整不证明规则已执行。

## 使用与结果

从仓库根目录执行，沿用 Node 22.23.4 / pnpm 10.34.7：

```sh
pnpm check:commerce --file docs/delivery/2026-10-22/commerce-decisions.json
```

命令先构建 contracts/API，再运行只读 CLI。没有网络、数据库、环境文件或凭据依赖，不修改输入文件。输入路径由操作者明确指定；当前模板应退出 **1**。脚本构建阶段会输出 pnpm 日志；需要纯 JSON 时，构建后直接执行：

```sh
node apps/api/dist/commerce/admission-cli.js --file docs/delivery/2026-10-22/commerce-decisions.json
```

| 退出码 | 含义                                                                                         |
| ------ | -------------------------------------------------------------------------------------------- |
| 0      | 所填字段的结构、规定值、基本数量关系及证据范围一致性通过；仍未核验证据真实性，仍未获开售授权 |
| 1      | 配置不完整或不符合规则；按 `issues[].path / code / message` 补齐                             |
| 2      | 参数错误、无法读取文件或 JSON 解析失败                                                       |

公开纯函数为 `apps/api/src/commerce/admission.ts` 的 `validateSalesAdmission(input: unknown)`，返回 `completeness: complete / incomplete`、**`salesAuthorized: false`**、**`evidenceAuthenticity: not_verified`** 和稳定的错误列表。没有提供发布、支付、授权开关或 HTTP 接口；后续调用方不能把 `complete` 或退出码 0 当成可售状态。

报告不回显输入值、未知字段名、文件路径、异常详情或证据正文。不要把 Secret、密钥、身份证明、录音、照片、私人故事或证据正文放入此 JSON。实际填写副本放在 Git 忽略的受限目录，例如 `.probe-local/commerce-decisions.json`，并设置文件权限 600；受限证据库另行保存材料。

## 填写通则

- 只有已确认产品常量已填：99900 分 CNY、一个项目、一位成年讲述者和一位发起人、首本 1 本、两角色分离、约定运费及完整导出包含，不提供付费加印/超页。单位标签是字段含义，不是已决定的服务数值。
- 未确定数值、规则、实际身份、时间和负责人保留 `null`；审核状态保留 `pending`。不能以 `已完成`、`approved` 一个字段、任意非空对象或 `record:pending` 替代明细。
- 每个 D02–D08 的 `review` 均需 `state: frozen`、实际负责人的 `ownerRef`、记录该组决定的 `decisionRef` 和 `decidedAt`。时间为真实存在的 UTC `YYYY-MM-DDTHH:mm:ssZ`，不填示例时间。负责人必须在受限库内可追溯到具体责任人，不能仅有无人承接的角色名。
- 引用采用 `record:` 加受限库记录 ID；后缀 3–120 个 ASCII 字母、数字、点、下划线、斜线或短横线，以字母/数字开头。引用不携带 URL 参数、凭据或私人内容。程序只验证引用格式；运营仍须打开材料确认其存在、版本、适用范围和有效性。
- 数量使用整数及明确单位：人民币 `fen`、录音 `seconds`、次数/照片 `count`、自然日 `calendar_days`、SLA 工作日 `business_days`。不接受数字字符串、小数、负值、未知单位或未支持字段。
- 正数是有期限/额度字段的当前表达方式；暂停总天数、到期提前通知天数、系统重试预算和退款金额支持明确的 0。退款金额为 0–99900 分。不要借 0 或极大整数表达“未知”“永久”或规避责任。
- 下述枚举是当前检查器能表达的方案，**不是替运营选定的政策**。若真实决定无法准确表达，保持 pending，先审核并调整版本与测试；不得用相近枚举或随意加字段绕过核验。技术试验的 5 分钟、300 DPI、临时 URL TTL 等不回填为销售承诺。

## D02 制作权益

`duration` 为制作权益自然日，`startsAt` 支持 `payment_verified` 或 `subject_participation`。`notStarted` 单独填写从 `payment_verified` 起的最大等待自然日，以及 `contact_and_offer_refund / expire_creation` 和用户告知引用。

`pause` 明确 `clock: continues / stops`、暂停累计上限、`atLimit: resume_clock / manual_review` 和政策引用。上限为 0 表示没有暂停额度，仍需填写相应处理规则。`expiration` 的新录音为 `blocked`；首本为 `blocked / manual_review`；已有资料必须 `per_d03`，不能把制作到期当作删除。

## D03 资料服务

- `onlinePlayback` 与 `exportRequests` 各有独立期限和起算点，支持付款核验、本人参与、制作到期、交付完成四个事件（`payment_verified / subject_participation / creation_expired / delivery_completed`）。回听到期为 `stop_access`，导出还要受理渠道引用。
- `retention` 分别表达采集原声、原图、必要衍生音频/图片、转录、确认故事、PDF，以及活动数据、历史对象、备份的保留期限；这些项除上述事件外支持 `asset_created`。导出包从 `export_ready` 起算，供应商副本从 `processing_completed` 起算。文件类别与存储副本层级都要填写，运营须核对共同适用的条款，程序不证明存储系统已执行。
- `deletion` 的活动数据、历史对象、备份和供应商副本分别填写从 `verified_deletion_request` 起的处理自然日及执行流程引用；备份待轮换、外部副本待确认不能写成活动数据已删就全部完成。
- `expiryNotice` 填提前自然日、通知渠道及到期说明。`copyStatusSeparately` 与 `restoreAppliesDeletionLedger` 必须为 true，分别表示按副本层级报告进度及恢复前应用删除台账的已审流程。

## D04 用户额度与供应商成本

`userQuotas` 六项分别为单段录音秒数、总录音秒数、照片数量、整理次数、主动重生成次数、追问次数。总录音不小于单段；每项独立填写 `excess: stop / stop_and_contact_support` 与告知引用。不存在购买加额、加印或超页入口。

`providerBudget` 独立填写 ASR 提交、ASR 轮询、系统重试次数及人民币分成本上限；`scope` 为 `per_project`，耗尽处理为 `manual_review`，需成本负责人。`systemRetriesChargeUserQuota` 为 false。这些是供应商执行预算，不能代替用户录音/整理权益；本票不实现预算执行。

## D05 配送

明确地区代码目录引用、`includedRegionCodes` 含运费地区、`excludedRegionCodes` 不支持地区；代码形如 `CN-110000`，双方清单非空、不重复、无交集。使用同一目录和同一粒度的明确地区代码，不用通配符或“全国”等模糊文字。格式检查不证明地区真实或履约可达。

未列地区为 `reject_before_payment`，约定运费包含为 true；填写付款前告知引用，以及 `verification` 的 `address_code_and_manual_review` 核验方式、证据、时间和负责人。实际地址覆盖及地区目录由运营核验。

## D06 人工时限

各项独立填写 `within` 工作日、负责人和执行流程，另填 `businessCalendarRef` 说明节假日口径。当前起算事件如下；物流 SLA 适用于 `all_included_regions`。

| 项目                        | 起算事件                              |
| --------------------------- | ------------------------------------- |
| `proofreading` 校对         | `proofreading_requested`              |
| `completeExport` 完整资料包 | `export_identity_and_scope_verified`  |
| `production` 生产           | `book_locked_and_operations_approved` |
| `logistics` 物流            | `carrier_accepted`                    |
| `customerService` 客服      | `request_received`                    |
| `afterSales` 售后           | `after_sales_request_verified`        |

生产周期不是从付款开始计算。完整性通过不证明供应商或责任人可兑现这些时限。

## D07 退款与质量售后

九项规则分别填写：未参与、已使用未投产、已投产、平台无法交付、破损、漏页、错版、平台排版错误、确认后发现事实错误。每项包含若选择退款时的明确 `refundAmount` 分金额、申请窗口、从 `verified_refund_request` 起的处理自然日、救济方式、权益后果、生产处理、政策引用及负责人。当前金额结构表达每种情形的固定退款额；不支持未经审核的任意计算公式。

| 情形                           | 申请窗口起算事件      |
| ------------------------------ | --------------------- |
| `notParticipated`              | `payment_verified`    |
| `usedNotProduced`              | `service_first_used`  |
| `inProduction`                 | `production_accepted` |
| `platformUnableDeliver`        | `failure_notified`    |
| 四项 `quality*`                | `delivered`           |
| `postConfirmationFactualError` | `error_discovered`    |

`remedy` 支持 `refund / reprint_or_refund / resend_or_refund / correction_and_explain`。制作权益后果为 `retain / suspend / terminate`，首本后果为 `retain / cancel / consumed / quality_remedy`；生产处理为 `none / check_and_stop_if_possible / remedy_original_order / already_produced`。运营须核对所选处理和阶段相符；程序不查询实际生产状态或执行退款。`refundDeletesData` 必须 false，`qualityReprintUsesOriginalOrder` 必须 true。

## D08 主体、平台、本人权利和供应商

`identity` 保存主体证据引用、实际 AppID/商户号、类目与支付路径记录引用，实际商品固定为 `digital-production-plus-physical-book`。AppID/商户号仅做 3–128 位 ASCII 字母数字/短横线/下划线格式检查；合法性、归属和准入由外部证据核对。

`platform` 的商户绑定、商品准入、iOS 支付、Android 支付、发货管理五项均要审核通过，且各自 `scope` 六个字段与 `identity` 完全一致。每项需 `outcome: approved`、证据、要求说明、审核人及真实时间。双端还需真机测试记录及 `paymentAndQuery: passed`；发货管理需履约核验记录，处理为 `implemented_and_verified / platform_exemption_verified`。豁免只能填有平台适用依据的核验结果，不能用来跳过发货管理。

`identityBinding` 需审核证据和流程；主体与操作人分离、讲述者申请/发起人确认、防发起人自绑定、付款不替代同意四项均为 true。`assistedConsent` 需审核证据、同机证据形式/采集流程和责任人；在场、主体/操作人、目的/告知版本、确定内容版本、每次确认留证均需明确 true。程序不认定勾选记录或某种证据形式足以证明本人身份。

`disputes` 需受理、核验流程、负责人、处理自然日和决定告知；暂行处理为 `freeze_access_and_processing`。`withoutWechat` 的撤回、导出、删除三条通道各有渠道、本人核验、请求范围核验、回复渠道、责任人和响应自然日，申请人为 `verified_subject`；导出另有交付渠道，接收人为 `verified_subject_or_explicitly_authorized_recipient`，`neverDefaultToInitiator` 为 true。

`privacy` 需审核证据和告知版本，采集/AI/共享/入书分开、撤回停止访问及处理、生产仅最小资料三项为 true。

`suppliers` 分 ASR、文本模型、印厂逐项审核。分别填写实际供应商、服务/模型配置版本、处理条款、处理地域、责任人及删除流程引用；保留期限从 `processing_completed` 起算，删除期限为核验删除请求后的自然日，均不能超过 D03 公示的供应商副本期限。

| 供应商项   | 用途                  | 数据范围                                                |
| ---------- | --------------------- | ------------------------------------------------------- |
| `asr`      | `file_asr`            | 仅 `original_audio`                                     |
| `text`     | `story_and_follow_up` | 必须有 `transcripts`，可另有 `photo_descriptions`       |
| `printing` | `print_and_ship`      | 仅 `production_pdf` 和 `shipping_address`，两者均需说明 |

训练用途填写 `prohibited / separate_subject_consent`，转交填写 `prohibited / contracted_subprocessors_only`；另行同意与分包必须有适用条款及已核验流程，枚举不授予同意或准入。未经核验不能把供应商状态改成 approved。

## 待办与边界

- D02–D07：用户/运营决定商业值，确定具体责任人并审核可兑现性；当前全部 pending。
- D08：用户/运营提供实际主体、TimeNook AppID、商户绑定、类目及实际商品路径核验；补齐双端真机支付/查单和发货管理证据。同机本人证据、争议、无微信权利、隐私与供应商材料均待审核。
- D01 规格/实物由 T04 对应印厂与产品负责人冻结；D09 内置内容由 T09 对应内容负责人冻结；D10 关系场景由 T08 对应产品/授权负责人冻结。这里是票据责任范围提示，具体人仍待指派；三项不加入 T05 的阻塞回环。本票通过也不代表它们已完成。
- 完整合成数据只在 `apps/api/test/commerce-admission.test.ts` 的内存测试夹具中，带 `synthetic` 的记录是假数据，没有可售配置文件。将 `purpose` 填成 `synthetic_test_fixture` 会被拒绝；即使有人把假证据伪称为正式记录，完整性检查也不能证明真伪，报告仍固定未授权开售。

复现本票定向测试：

```sh
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
node --test apps/api/dist-test/test/commerce-admission.test.js
```

运行结果与外部未验收项见 [T05 证据](evidence/T05.md)。GitHub [#6](https://github.com/brycezhang/timenook/issues/6) 保持打开和 `ready-for-human`，真实材料齐全前不关闭。
