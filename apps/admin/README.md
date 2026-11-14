# TimeNook 管理入口（Vben web-antd）

后台使用 Vben 5.7.0 的 `BasicLayout`、`AuthPageLayout`、权限菜单、面包屑、多标签页和 `Page`，配合 Vue Router、Pinia 和 antdv-next。来源和必要修改见 [UPSTREAM.md](../../vendor/vben/UPSTREAM.md)。飞书白名单、独立 Cookie/CSRF 和服务端审计见 [ADR 0016](../../docs/adr/0016-feishu-admin-login.md)。超级管理员默认进入订单管理，另有录入订单、第三方账号、用户管理和生产单管理。第三方登录进入唯一业务入口「录入订单」。

- **录入订单** `/admin/channel-gifts`。录入第三方渠道购买，查看、核对及更正或作废权限范围内的记录。
- **第三方账号** `/admin/partners`。生成账号时一次展示初始凭据，撤销时二次确认。
- **订单管理** `/admin/orders`。支持查询、筛选、分页和内部备注。订单详情可进入关联用户、项目和生产单，也可处理已有退款与质量售后申请。
- **用户管理** `/admin/users`。支持查询产品账号和讲述者，进入用户详情查看关联订单与项目。无支付订单的项目也可通过用户管理查找，资料服务申请在项目详情处理。
- **生产单管理** `/admin/production`。支持查询、筛选、分页和独立详情。在详情中处理确定书稿的人工交接、完成印制、发货和交付。实际印厂、物流与实物验收单独记录。

三项业务已合并并部署。2026-11-02 的实际飞书登录、订单与用户关联、详情直达及生产单空态见 [#150 实际运行记录](https://github.com/brycezhang/timenook/issues/150#issuecomment-6577052868)。

订单使用 `orders:read` 查询、`orders:write` 追加备注。列表支持 `q/state/pending/page/pageSize`，页长最多 100，排序为创建时间、ID 倒序。独立订单详情显示标价、应付、已验收款和实际成功退款；受控 1 分订单独立标记，购买账号、讲述者主体、项目、生产单分别表达。备注带操作人/时间、Idempotency-Key，并事务审计。契约见 [admin.ts](../../packages/contracts/src/admin.ts)，交付见 [#151 本地记录](../../docs/delivery/2026-11-02/admin/151-engineering.md)。

## 线上验收

2026-11-14，「时光故事管理后台」静态版本 `d3d12e3` 已发布到线上开发环境。Nginx 从 `/data/server/timenook/current/apps/admin/dist` 提供新产物，77 个公网文件与本地构建 SHA-256 一致，API live 和 ready 均返回 200。发布只更新后台静态文件，API 与 Worker 进程无需重启。

Chromium 从公网加载新版本，使用浏览器内合成管理 API 响应复验 1280px 桌面侧栏与正文贴合、390px 选页及点击遮罩收起、订单／用户／生产单查询与重置、详情返回恢复筛选、渠道记录刷新与详情关闭，以及第三方账号列表与前进后退。真实飞书授权和线上业务数据验收待完成。

2026-11-14，当前库的管理员白名单为空，飞书授权回调返回 403。按原权限恢复 `bryce` 已有的飞书绑定后，实际飞书登录成功。逐个点击三个一级菜单均进入对应列表。订单列表和用户列表均可打开实际详情并返回，订单详情可进入关联用户和项目。生产单列表显示空态，使用不存在的编号验证了详情路由及「返回查询位置」。实际生产单的列表到详情跳转待有记录时验收。

## 构建与开发

构建：`pnpm --filter @timenook/admin build`；产物 `apps/admin/dist/`。目标部署为 `https://timenookapi.threeminreading.com/admin/`，请求同源 `/api/v1/admin/`，Cookie Path 为 `/api/v1/admin`，见 [ADR 0015](../../docs/adr/0015-dedicated-domain-ingress.md)。构建、请求与服务端 Cookie 已统一使用该路径，本地 HTTPS 流程与正式环境结果分别记录。不读取服务端密钥，不保存 token/password/seed、权限、私人页面或详情数据到浏览器存储；Pinia 不启用持久化插件，多标签只在当前页面保留路由元数据。命名空间 `timenook-admin-v3` 仅用于框架外观偏好。本次更换命名空间使旧浏览器重新使用固定侧栏默认值。

框架偏好见 [preferences.ts](src/preferences.ts)。按 wutong-admin 使用 Vben 的 `sidebar-nav`、248px 展开与 64px 折叠宽度、56px 顶栏和 `UserDropdown`。桌面侧栏固定并随折叠重新分配正文宽度，窄屏菜单带遮罩并在导航后收起。列表使用 Vben `Page` 和 antdv-next 表格，订单、用户、生产单均可重置筛选。

2026-11-14 本地 HTTPS 验证覆盖 1280px 桌面侧栏展开与折叠、390px 菜单打开与选页收起、账号菜单退出、订单及用户查询和详情返回、渠道录单恢复与更正作废、第三方账号生成与撤销。使用隔离书稿夹具验证生产单查询、详情、返回原筛选及重置。类型检查、构建及 18 项后台浏览器测试通过。

本地开发需要 HTTPS：证书/私钥放 Git 外，文件权限 600；将绝对路径填入 Git 忽略的 `.env.admin-local` 的 `ADMIN_TLS_CERT` / `ADMIN_TLS_KEY`。`ADMIN_ORIGIN=https://localhost:3443` 与 API 一致。先启动 API，再运行 `pnpm dev:admin`。本地证书需由本机信任；自动化浏览器只对临时自签证书使用 ignoreHTTPSErrors。HTTP 开发服务器拒绝启动，以免误以为 Secure Cookie 已完成联调。

先用 `pnpm exec playwright install chromium` 安装锁定 Playwright 版本对应的 Chromium，再在 API build 后运行 `pnpm test:admin-browser`。本地与 CI 使用同一浏览器版本。它使用随机隔离 PostgreSQL schema / Redis 前缀、随机身份绑定/密钥和一次性 HTTPS 证书，经实际 CLI 创建本地白名单身份；仅在测试构造入口替换飞书外部 HTTP。自动化不读取真实管理员凭据。授权码与会话可能出现在自动快照中，因此失败快照、trace 和录屏关闭，只主动保存无凭据页面到 `/tmp`。

CI 运行管理端类型检查、构建和 Chromium 操作路径。线上由 Nginx 提供 `/admin/` 静态入口并反向代理 `/api/`。2026-11-12 后台随 API 一同切换发布版本，见 [0.4.0 发布记录](../../docs/delivery/2026-11-11/miniprogram-refactor/release-0.4.0.md)。
