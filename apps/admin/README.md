# TimeNook 管理入口（Vben web-antd）

真实 Vben 5.7.0 `VbenAdminLayout`、preferences、request、styles 和 antdv-next；框架源码来源与必要修改见 [vendor/vben/UPSTREAM.md](../../vendor/vben/UPSTREAM.md)。应用层按 api / layouts / views 组织，不包含参考工程业务、demo 或配置。后台采用飞书白名单登录、运行信息与审计查看，不另设密码或 MFA，见 [ADR 0016](../../docs/adr/0016-feishu-admin-login.md)。T08 新增关系目录、缺参草稿与不可变本地套餐预览，使用 `catalog:read/write/freeze` 权限；正式开售仍关闭。操作与导入格式见 [T08 本地指南](../../docs/delivery/2026-10-22/catalog-local.md)。

构建：`pnpm --filter @timenook/admin build`；产物 `apps/admin/dist/`。目标部署为 `https://timenookapi.threeminreading.com/admin/`，请求同源 `/api/v1/admin/`，Cookie Path 为 `/api/v1/admin`，见 [ADR 0015](../../docs/adr/0015-dedicated-domain-ingress.md)。构建、请求与服务端 Cookie 已统一使用该路径，本地 HTTPS 流程与正式环境结果分别记录。不读取服务端密钥，不保存 token/password/seed 到浏览器存储。命名空间 `timenook-admin-v1` 仅用于框架外观偏好。

本地开发需要 HTTPS：证书/私钥放 Git 外，文件权限 600；将绝对路径填入 Git 忽略的 `.env.admin-local` 的 `ADMIN_TLS_CERT` / `ADMIN_TLS_KEY`。`ADMIN_ORIGIN=https://localhost:3443` 与 API 一致。先启动 API，再运行 `pnpm dev:admin`。本地证书需由本机信任；自动化浏览器只对临时自签证书使用 ignoreHTTPSErrors。HTTP 开发服务器拒绝启动，以免误以为 Secure Cookie 已完成联调。

先用 `pnpm exec playwright install chromium` 安装锁定 Playwright 版本对应的 Chromium，再在 API build 后运行 `pnpm test:admin-browser`。本地与 CI 使用同一浏览器版本。它使用随机隔离 PostgreSQL schema / Redis 前缀、随机身份绑定/密钥和一次性 HTTPS 证书，经实际 CLI 创建本地白名单身份；仅在测试构造入口替换飞书外部 HTTP。自动化不读取真实管理员凭据。授权码与会话可能出现在自动快照中，因此失败快照、trace 和录屏关闭，只主动保存无凭据页面到 `/tmp`。

CI 运行管理端 typecheck/build 与 Chromium 用户路径。Nginx `/admin/` 静态入口及 `/api/` 反向代理的目标部署由 T29 留证；本地 HTTPS 结果与正式域名、真实管理员飞书登录和生产验收分别记录。
