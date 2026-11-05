# TimeNook 管理入口（Vben web-antd）

实际使用 Vben 5.7.0 `BasicLayout`、`AuthPageLayout`、菜单、面包屑、多标签页和 `Page`，配合 Vue Router、Pinia、antdv-next；来源和必要修改见 [UPSTREAM.md](../../vendor/vben/UPSTREAM.md)。飞书白名单、独立 Cookie/CSRF 及服务端审计沿用 [ADR 0016](../../docs/adr/0016-feishu-admin-login.md)。只有订单、用户、生产单三个一级菜单；登录默认订单，无对应权限时回到可访问入口。用户/生产操作按后续业务票接入，当前关联入口明确显示尚未开放。

订单使用 `orders:read` 查询、`orders:write` 追加备注。列表支持 `q/state/pending/page/pageSize`，页长最多 100，排序为创建时间、ID 倒序。独立订单详情显示标价、应付、已验收款和实际成功退款；受控 1 分订单独立标记，购买账号、讲述者主体、项目、生产单分别表达。备注带操作人/时间、Idempotency-Key，并事务审计。契约见 [admin.ts](../../packages/contracts/src/admin.ts)，交付见 [#151 本地记录](../../docs/delivery/2026-11-02/admin/151-engineering.md)。

构建：`pnpm --filter @timenook/admin build`；产物 `apps/admin/dist/`。目标部署为 `https://timenookapi.threeminreading.com/admin/`，请求同源 `/api/v1/admin/`，Cookie Path 为 `/api/v1/admin`，见 [ADR 0015](../../docs/adr/0015-dedicated-domain-ingress.md)。构建、请求与服务端 Cookie 已统一使用该路径，本地 HTTPS 流程与正式环境结果分别记录。不读取服务端密钥，不保存 token/password/seed、权限、私人页面或详情数据到浏览器存储；Pinia 不启用持久化插件，多标签只在当前页面保留路由元数据。命名空间 `timenook-admin-v2` 仅用于框架外观偏好。

本地开发需要 HTTPS：证书/私钥放 Git 外，文件权限 600；将绝对路径填入 Git 忽略的 `.env.admin-local` 的 `ADMIN_TLS_CERT` / `ADMIN_TLS_KEY`。`ADMIN_ORIGIN=https://localhost:3443` 与 API 一致。先启动 API，再运行 `pnpm dev:admin`。本地证书需由本机信任；自动化浏览器只对临时自签证书使用 ignoreHTTPSErrors。HTTP 开发服务器拒绝启动，以免误以为 Secure Cookie 已完成联调。

先用 `pnpm exec playwright install chromium` 安装锁定 Playwright 版本对应的 Chromium，再在 API build 后运行 `pnpm test:admin-browser`。本地与 CI 使用同一浏览器版本。它使用随机隔离 PostgreSQL schema / Redis 前缀、随机身份绑定/密钥和一次性 HTTPS 证书，经实际 CLI 创建本地白名单身份；仅在测试构造入口替换飞书外部 HTTP。自动化不读取真实管理员凭据。授权码与会话可能出现在自动快照中，因此失败快照、trace 和录屏关闭，只主动保存无凭据页面到 `/tmp`。

CI 运行管理端 typecheck/build 与 Chromium 用户路径。Nginx `/admin/` 静态入口及 `/api/` 反向代理的目标部署由 T29 留证；本地 HTTPS 结果与正式域名、真实管理员飞书登录和生产验收分别记录。
