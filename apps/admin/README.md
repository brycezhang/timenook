# TimeNook 管理入口（Vben web-antd）

真实 Vben 5.7.0 `VbenAdminLayout`、preferences、request、styles 和 antdv-next；框架源码来源与必要修改见 [vendor/vben/UPSTREAM.md](../../vendor/vben/UPSTREAM.md)。应用层按 api / layouts / views 组织，不包含参考工程业务、demo 或配置。T07 交付独立登录、TOTP MFA、运行信息与审计查看。T08 新增关系目录、缺参草稿与不可变本地套餐预览，使用 `catalog:read/write/freeze` 权限；正式开售仍关闭。操作与导入格式见 [T08 本地指南](../../docs/delivery/2026-10-22/catalog-local.md)。

构建：`pnpm --filter @timenook/admin build`；产物 `apps/admin/dist/`，公网路径 `/timenook/admin/`。请求固定走同源 `/timenook/v1/admin/`，不读取服务端密钥，不保存 token/password/seed 到浏览器存储。命名空间 `timenook-admin-v1` 仅用于框架外观偏好。

本地开发需要 HTTPS：证书/私钥放 Git 外，文件权限 600；将绝对路径填入 Git 忽略的 `.env.admin-local` 的 `ADMIN_TLS_CERT` / `ADMIN_TLS_KEY`。`ADMIN_ORIGIN=https://localhost:3443` 与 API 一致。先启动 API，再运行 `pnpm dev:admin`。本地证书需由本机信任；自动化浏览器只对临时自签证书使用 ignoreHTTPSErrors。HTTP 开发服务器拒绝启动，以免误以为 Secure Cookie 已完成联调。

先用 `pnpm exec playwright install chromium` 安装锁定 Playwright 版本对应的 Chromium，再在 API build 后运行 `pnpm test:admin-browser`。本地与 CI 使用同一浏览器版本。它使用随机隔离 PostgreSQL schema / Redis 前缀、随机账号/密钥和一次性 HTTPS 证书，经实际 CLI 创建本地身份。自动化不读取真实管理员凭据。密码输入和 MFA 种子可能出现在自动快照中，因此失败快照、trace 和录屏关闭，只主动保存已认证运行页/已清空登录页到 `/tmp`。

CI 运行管理端 typecheck/build 与 Chromium 用户路径。没有部署到共享 ECS，Nginx 静态路径和 `/timenook` 反向代理在 T29 实施；不能以本地 HTTPS 代替正式域名、真实管理员 MFA 初始化与生产验收。
