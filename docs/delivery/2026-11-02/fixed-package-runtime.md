# 固定套餐与 1 分受控验收运行记录

2026-11-02（Asia/Shanghai），关联 #141、#142、#143、[PR #144](https://github.com/brycezhang/timenook/pull/144)。

用户已确认先完成实付 0.01 元受控验收、普通 999 元售卖条款随后补齐；展示标价仍为 999 元。当前商品发布、真实商户预下单和原单取消已通过，实际付款二维码等待开发者本人扫码。尚无已验证到账、实际退款或付费项目内容全链通过结论。

14:27:37 的脱敏结果：

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

## 当前验收边界

Pixel 7 已识别：Android 16、微信 8.0.65；扫码提示“暂无体验权限”。微信后台页面受当前工具 URL 策略限制，未自动修改成员。本机微信已尝试小程序入口，独立窗口工具读取超时，用户反馈电脑端也无法打开，并要求暂用开发者工具验收。

完成实际 1 分付款后，继续用该唯一付款项目运行 `--paid-project`：本人用途、真实供应商录音/照片/转写/故事、双方同版 PDF 与原声；保持明确虚构内容与合成输入，不替代真人目标用户、双真机或实物验收。实际退款仍须以实付 1 分核对，不能用隔离用例追认完成。#141 与 T29/T30 的对应真实验收项继续保留。
