# CG04 更正与录入错误作废

2026-11-14，#184。本地工程交付，不部署或关闭票据。基于集成 `6ce05e5` 消费 CG01 记录、CG02 真实后台角色/会话与 CG03 单次建书契约。

## 已实现

后台「渠道购买记录 → 详情」支持更正手机号和录入错误作废。超级管理员可处理全部记录，第三方只可处理本人录入记录；详情与历史手机号对第三方脱敏。两种操作必填原因，持久化操作人、时间、原号码及新号码；原记录保留。

- `GET /v1/admin/channel-gifts/:id` 返回当前记录及操作历史。
- `POST /v1/admin/channel-gifts/:id/correct` 接收 `{buyerPhone, reason}`；重新按已验证手机号关联现有账号或等待注册，清空提醒已处理状态。原买方立即失去记录及开通权。
- `POST /v1/admin/channel-gifts/:id/void` 接收 `{reason}`；已关联买方仍可读到已作废状态，不再计入提醒或开通。
- 操作复用后台会话、CSRF 与事务审计，服务端校验当前角色及原录入人。与 CG03 激活共用 `lockChannelGiftIn`，已建书或已作废均拒绝。更正先取得手机号锁，再锁礼物行，与并发注册保持锁顺序。
- 后台请求失败后重新读取真实详情及列表。另一个窗口完成建书后，旧编辑表单提交失败会显示已锁定并移除更正/作废按钮。

新增 `channel_gift_operations` 保留操作事实；迁移 `20261114160000_channel_gift_operations` 在渠道记录及激活迁移之后应用。

## 验证

接口首轮 RED：新增公开 HTTP 测试在缺失更正接口返回 404，随后实现通过。真实本地 PostgreSQL/Redis，隔离 schema；飞书/微信身份供应商使用既有外部协议 fixture。13 项相关 API 测试通过，其中 5 项本票测试覆盖必填原因、现有/未注册新归属、并发注册、旧买方失权、新提醒、作废保留、第三方换 ID 拒绝、撤销旧会话、建书并发互斥和已建书拒绝。断言通过公开 HTTP 查询详情、礼物、提醒和项目，不读取内部数据库验证结果。

合入 CG02 最终交付 `193edf9` 后，受影响的 `orders.spec.mjs` 全部 5 项 HTTPS 浏览器测试通过（26.8 秒），本票双方页面无未处理运行错误。后台类型检查、API 测试编译及 API/Admin 构建通过。

本票 HTTPS Playwright 流程通过：真实超级管理员页生成账号 → 第三方密码页登录 → 录单 → 详情更正及脱敏操作记录 → 买方 HTTP 可见及提醒 → 作废与买方状态同步 → 超级管理员更正第三方另一笔记录 → 买方 HTTP 真正激活 → 旧后台表单更正被拒并读回锁定状态。第三方重载也显示锁定，390×844 无页面横向溢出；截图 `/tmp/timenook-cg04-locked-detail.png` 已目视检查。浏览器插件未提供，使用仓库既有 Playwright 测试。

验证命令（环境从本机 mode 600 私密文件加载，内容不入库）：

```
pnpm --filter @timenook/contracts build
pnpm db:generate
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
node --test --test-timeout=120000 dist-test/test/channel-corrections.test.js dist-test/test/channel-gifts.test.js dist-test/test/admin-partners.test.js dist-test/test/channel-activation.test.js
pnpm --filter @timenook/api build
pnpm --filter @timenook/admin typecheck
pnpm --filter @timenook/admin build
pnpm exec playwright test -c playwright.admin.config.mjs tests/admin/console/orders.spec.mjs -g 'super admin and original partner'
```

后台浏览器 fixture 复用已编译的支付协议 fixture、真实商品快照及独立隐私日志，只用于本地测试以开放真实买方激活接口。渠道激活不调用支付供应商。

## 验收边界

买方原生失效页面处理及作废列表复用 CG03 的页面控制器测试和原生交付证据；本票浏览器买方部分使用真实 HTTP，并非手机微信 UI。真实运营账号、真机手机号/分享及目标环境部署另验。渠道退款不属于本票。
