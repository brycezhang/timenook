# 固定套餐与 1 分受控验收运行记录

2026-11-02（Asia/Shanghai），关联 #141、#142、#143、[PR #144](https://github.com/brycezhang/timenook/pull/144)。

用户已确认先完成实付 0.01 元受控验收、普通 999 元售卖条款随后补齐；展示标价仍为 999 元。15:09:22 已核实原单真实支付 1 分、验签通知处理和唯一项目激活；该付费项目已通过完整内容 E2E，16:00:47 原单实际退款 1 分成功。真实资金与受控内容闭环已通过，真人、真机及正式商业/实物边界仍按下节分别保留。

付款前 14:27:37 的脱敏历史结果（保留，不代表当前状态）：

```json
{
  "observedAt": "2026-11-02T06:27:37.429Z",
  "listAmount": 99900,
  "amount": 1,
  "orderState": "pending",
  "verifiedPaidFen": null,
  "projectCreated": false,
  "paidProjectContentE2E": "not-run-pending-payment"
}
```

## 源码与工程证据

- 代码 HEAD `0ab39d1fabe6f0f3cf58d3c16424f4242102b726`；main 合并 `8bcc5e5d132b587d505c8e5a587f27599d4179be`。
- [最终 CI 41397837107](https://github.com/brycezhang/timenook/actions/runs/41397837107) 全部通过。Standards 0；Spec 发现未 prepare 的原单无法取消，已由独立实现者在订单行锁内修复，原审查者复核解决。定向真实 PostgreSQL/Redis 的付款及固定套餐用例 21/21，确定性 prepare/close 并发复测 1/1。
- 其余工程证据复用[服务端交付](fixed-package-api.md)和[原生交付](native-fixed-checkout.md)：前端 446/446、目录/新增 HTTP 22/22、后台浏览器 1/1、受影响 PDF/退款定向复测、类型检查和构建；不将隔离协议替身当作真实到账。
- CI Linux x64 候选 manifest 提交 `a6c00b6fa1d472c6e549195d4d6ea9d51bb670ed`，Git tree 与代码及 main 合并均为 `dc87aff9db883f79e48045284ac58a5b05215f45`。包 SHA-256 `dd77e43bf746df7ed585da61e922da44a2316090c1bfb10ff2a7bfec8b8421a0`，本机及目标机均通过 manifest 校验。
- 正式原生 24 页包重新通过官方 wcc/wcsc。构建源 `c893598` 的原生文件与最终代码相同，204 文件指纹为 `58f501c10fc8693400e9cb0a98d5c844bd9fc244c632c2f25ad47bb1600188af`。官方 Stable `2.02.2609240`、基础库请求及解析 `3.17.5`、`urlCheck=true`；真实微信登录取得同一产品验收账号。此轮付款页面未替换 `wx.requestPayment`，设备为开发者工具模拟器。

## 部署

- ECS `106.14.11.96`；`current` 切换为 `/data/server/timenook/releases/20261102-checkout-0ab39d1`。
- 复用目标机同锁文件、同 Node 的 Linux 依赖独立副本，重新生成 Prisma Client `6.19.3` 并实际加载 Linux `fs-ext`；没有在 ECS 编译应用，也没有上传 Mac 原生依赖。Node 为 `22.23.4`。
- 应用迁移 `20261102090000_fixed_package_checkout`，新增版本用途、标价/实付与验收标记约束。API/Worker 在迁移时停止，完成后原子切换并启动。
- 保留既有 `.env`、`.env.internal-acceptance` 及普通商户、身份、OSS/ASR/DeepSeek/书稿装配。仅增加本次 E2E 开关及一个实际产品用户 UUID 名单；值与会话留在受限文件。既有线上装配 `environment=development`、realm `local`、`acceptance=true`，没有使用测试 transport 或 `NODE_ENV=test`。
- 14:15:12 初次启动失败：归档根目录为 700，服务用户及 Nginx 无法读取。修正本发布目录为 755 后，14:16:04 重启成功。两服务 `active/running`、`ExecMainStatus=0`；历史 `NRestarts=9` 保留，此后观察稳定，未重置计数。
- 14:16:11 经真实公网入口，API live/ready、`/admin/`、官网 `/` 与 `/app/` 全部 200。后续本机 readiness 200、匿名订单 401、无签名支付/退款通知均 400。

## 商品与订单运行

以服务用户执行既有服务器运维入口 `catalog-cli.js publish-e2e --operator-label authorized-e2e-20261102`。调用与管理页面同一发布用例，审计记录为服务器发布、`operatorId=null`，没有伪造飞书登录或商业审批。

- E2E 不可变版本序列 1，ID `6326dc9f-cc50-436b-ac4e-2dd71aebd8b2`。真实微信验收会话读取 `purchasable=true`、`purpose=e2e`、`listAmount=99900`、`amount=1`、`isE2e=true`。
- 匿名读取 `version=null`、`checkout=null`、`PACKAGE_PREPARING`；不公开验收条款或 1 分入口。普通真实商业版本仍待材料补齐后发布，符合本次用户决定。
- 真实 API 创建 1 分验收原单后，不预下单即取消，返回 `closed`、无项目；再次准备支付 409。该路径无支付项目或付款权益激活。
- 原生正式套餐页显示 `999.00` 和授权账号实付 `0.01`，称呼、区域和服务说明确认后保存原订单意图、创建订单、向真实普通商户预下单并调用微信原生付款。
- 开发者工具显示“请用开发者本人微信扫描以上二维码进行支付调试”。原单实付核对为 1 分、状态 `pending`、无项目。RPC 驱动调用未正常等待完整扫码过程，但支付调试窗口仍在，不能据此判定微信已付款或订单已失败。保持原订单等待扫码，不另建付款单。

原始截图、会话、身份、订单及商户相关细节位于本机 Git 忽略的受限 `.probe-local/payment-e2e-20261102/`；服务器部署日志位于受限 `shared/release-packages/`。后续付款以服务端经微信验签的通知/主动查单为准。

## 实际到账与付费内容验收

首次扫码超时后，核实原单仍未付款，在原订单上重新准备支付并打开调试二维码；没有创建第二笔付款单。用户随后确认已付 0.01 元。服务端只读核对与本人订单 API 一致：

- 微信付款时间 `2026-11-02T07:09:22.000Z`（15:09:22），币种 CNY、交易实付 1 分；订单标价 99900 分、`isE2e=true`、状态 `paid`。
- 真实支付 Inbox 已验签 1 条、处理 1 条；项目 1、讲述主体 1、首本权益 1、服务条款 1、内部未付款挂靠 0。
- 原生订单页显示付款成功并恢复同一项目，不以客户端支付 RPC 超时判断资金失败。

同一付款项目使用 `TIMENOOK_PAID_PROJECT_INPUT=<受限文件> node scripts/test-native-login.cjs --orders-required --mvp --paid-project` 运行；不另建内部未付款项目。最终原生代码 `feb5ab0b2492d1e147b33e5a8c5f1452d225a4b5`，LTMGjr 的原始结果 `passed=true`、21/21 步骤、6/6 清理：

- 真实微信登录、会话恢复、退出旧会话拒绝、同账号重登、已付订单与同项目校验；开发者工具 Stable `2.02.2609240`，基础库请求及解析 `3.17.5`，`urlCheck=true` 并实际拒绝未配置域名。
- 独立网页讲述账号加入同一项目、用途确认、同机协助；原生选题/暂停继续/回听保存，真实 OSS、豆包 ASR、DeepSeek 追问与故事整理、故事确认。
- 故事后补照片、封存与说明、私有预览、改稿使旧确认失效、本人重新确认；原照片引用保留。JCf9nf、5l1Dea 两次失败分别暴露 #146 的导航与空快照消费问题，聚焦复现后修复，没有追认失败为通过。
- 原生 Tab 返回项目与书稿，生成并下载 8 页 PDF，双方确认同一版本和文件 hash；书中原声使用同一故事版本和源 hash，原生播放进度可见、匿名请求拒绝、临时文件清理成功。
- 清理发起人会话、两项 HTTPS 合成输入、测试会话、SDK 连接及临时项目窗口全部通过；业务资料与唯一付款项目保留。

PDF 为 272290 字节，SHA-256 `8f6780fffb45bf89d48a456e21f667e8b33cf9a3ffd63636765507d8e3c07f8d`；8 页渲染已逐页检查中文、照片/说明及 QR，无明显重叠或裁切。书稿包含保留失败续跑产生的三段虚构故事，仍标注候选/规格待定，不能作为已验收的印厂生产 PDF。

硬件输入明确为虚构 TTS 录音（46.144 秒）及生成 PNG（800×600）；微信身份、交易、HTTPS API、OSS、ASR、DeepSeek、PostgreSQL/Redis 和书稿任务是真实服务。本轮不是目标用户的真人内容/授权体验、双真机、纸书或物流验收。

受限证据：`paid-audit.json`、`paid-project.json`、`paid-mvp-LTMGjr/result.json`、PDF/渲染图片、`pre-refund-audit.json`。付款前后截图与失败原始结果同时保留，不提交会话、身份及私人样本。

## 原单退款验收

同一实际 1 分原单已申请「已经使用，尚未投产」退款；原购买的 E2E 政策固定退款 1 分、制作权益终止、首本取消、资料保留。实际飞书管理员正常登录后，发现 Admin 只认 `synthetic:` 证据，导致已由 API 支持的 `internal:` 核验按钮禁用。#148 仅统一该组件的两种证据前缀与提示；定向浏览器 1/1、Admin 类型/构建通过，Standards 0 / Spec 0，不更改金额、权限、CSRF 或资金执行逻辑。

修复部署后曾被 Mac 锁屏阻断，用户手动解锁后继续正常后台操作，没有读取浏览器 Cookie 或绕过身份。实际飞书管理员在原客服工单核对固定政策 ¥0.01，填写 `internal:e2e-one-fen-paid-verified` 后按钮正常启用；批准、执行均只使用原退款单：

- `approvedAt=2026-11-02T08:00:25.989Z`，批准 1 分，真实管理员记录存在；原单实收 1 分、已退 0、预留 1 分。
- `submittedAt=2026-11-02T08:00:43.646Z`，执行原退款；微信 `completedAt=2026-11-02T08:00:47.000Z`（16:00:47）。状态 `succeeded`，供应商退款号存在，真实 Refund Inbox 已验签 1 条、处理 1 条。后台刷新显示「已退款」，本人接口实收 1、已退 1、预留 0；approve/submit 命令各 1 次，没有重复退款或超实收退费。
- 订单付款事实仍为 `paid`，原交易 1 分及付款时间不变；项目/主体/首本记录仍各 1，内部未付款挂靠 0。按原政策制作状态 `terminated`、生产冻结、首本 `revoked`，不恢复可用首本。
- 退款前后采访 3、录音资产 3、照片资产/衍生行 12、故事 3、书稿版本 1、双方确认 2，数量均未减少。书稿输出保留原 272290 字节/8 页与相同 SHA-256。

退款后首次下载返回 403，原始结果保留。核对发现三项临时协助用途早在 15:52:06–08 到期，独立于 16:00 的退款；当前本人/发起人均无有效读取授权。通过既有受控网页验收入口恢复同一已绑定讲述账号（仍明确为合成验收身份），在正常公开用途接口重新确认后，本人及发起人均可读，本人 `canCollect=false`，退款终止制作没有被解除。16:03:43 下载同一 PDF 返回 200、272290 字节，SHA-256 与退款前完全一致；随后正常 DELETE session 返回 204。短期授权到期与长期资料保留分别生效，没有改 DB 权限或绕过授权。

受限证据新增 `refund-after-submit.json`、`final-refund-audit.json`、`post-refund-pdf-proof.json`（到期拒绝）、`post-refund-authorized-pdf-proof.json` 与 `post-refund-cleanup.json`；不公开用户、订单、供应商编号或管理员标识。

### 退款页修复部署

代码 `4ef1b07742dd747146dfc861b2eb3c427baefbd9`；[CI 41408638266](https://github.com/brycezhang/timenook/actions/runs/41408638266) 的全部选中检查与最终 gate 通过；照片和 Admin 增量均独立审查 Standards 0 / Spec 0。候选 manifest 提交 `e48fc1cdbd0ae1d2363d083bd3c935b7df3b9b5d`，与代码同 tree `d6ff89176737d27678c8c5dcad81c7a3e323f57a`；包 SHA-256 `32b92116f66630763906d179e72e8faff651e521622b2003c8959cc05bf0119d`。本机与服务器验证 321 文件 manifest，未在 ECS 编译应用。

15:54:50 原子切换为 `/data/server/timenook/releases/20261102-acceptance-4ef1b07`。API/Worker、Linux 依赖独立副本及新 Prisma Client 一并使用；锁文件与数据库 schema 和前版相同，无迁移或环境改动。

初次启动出现 EACCES：受限部署日志采用的 `umask 077` 影响了重新生成的 Prisma Client 文件，服务用户无法读 `default.js`。15:55:36 仅恢复生成客户端的标准读取/目录遍历权限，并以实际 `timenook` 用户验证 Prisma/fs-ext 加载后重启。未修改 env、业务资料或凭据权限；后续脚本增加生成前 `umask 022` 与切换前服务用户加载检查。最初公网 API 502 的失败保留；恢复后 API live/ready、Admin 均 200、匿名订单 401。15:56:19 两服务稳定 `active/running`、退出状态 0、`NRestarts=8`；初次部署的 9 次历史重启也保留，不声称从未失败。

## 当前验收边界

Pixel 7 已识别：Android 16、微信 8.0.65；扫码提示“暂无体验权限”。微信后台页面受当前工具 URL 策略限制，未自动修改成员。本机微信已尝试小程序入口，独立窗口工具读取超时，用户反馈电脑端也无法打开，并要求暂用开发者工具验收。

本轮已验证唯一实际付款项目的内容与原单实际退款闭环，符合用户本次「先 1 分受控验收、暂用开发者工具」的范围。普通 999 元公开售卖的真实书籍规格、内容额度、配送与售后时限仍须负责人补齐后发布商业版本；本轮只发布受控 E2E 版本。T29/T30 的真人、双真机、正式商业/生产 PDF、实物等对应项继续保留；不提审微信小程序。
