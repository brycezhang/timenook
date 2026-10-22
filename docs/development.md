# 本地开发与验证

工程使用 Node **22.23.4**、pnpm **10.34.7**。版本文件、packageManager 和锁文件是安装依据；开发机已有 Node 25 / pnpm 11 时先切换项目工具链。

## 从新 checkout 启动

```bash
nvm install
nvm use
npm install --global pnpm@10.34.7
pnpm install --frozen-lockfile
cp .env.example .env
chmod 600 .env
pnpm services:up
pnpm db:generate
pnpm db:migrate
pnpm check
```

复制环境文件仅用于首次初始化，已有配置时保留原文件。示例中的密码只用于回环地址绑定的可丢弃本地容器；生产使用独立配置，示例数据库密码被生产启动校验拒绝。密钥和私人样本保持在 Git 外。

Docker Compose 项目名为 timenook-dev，PostgreSQL 监听 127.0.0.1:54329，Redis 监听 127.0.0.1:63791；使用独立卷，均为锁定 digest 的官方镜像。首次验证为 PostgreSQL 16.13 / Redis 7.4.8。Redis 使用 AOF 和 noeviction，本地成功不代表目标 Tair 已验证。

初始迁移只建立一条服务 schema revision，用来区分“数据库可连接”和“迁移已完成”；业务实体在各自 ticket 引入。重复执行 migrate deploy 不重建数据。

## 开发入口

```bash
pnpm dev             # 现有小程序页面源码的浏览器预览，127.0.0.1:5173
pnpm dev:api         # 构建并启动 API，127.0.0.1:3417；修改后重新运行
pnpm api:openapi     # 输出 apps/api/dist/openapi.json
pnpm check:native    # Mac 微信开发者工具的 wcc / wcsc 验证
pnpm services:down   # 停止本项目容器，保留开发数据卷
```

API 默认绑定本机。GET /health/live 返回进程存活；GET /health/ready 同时检查已迁移 PostgreSQL 和 Redis，失败返回 503。响应带服务端生成的 requestId 及 x-request-id；请求方传入的标识不覆盖服务端标识。错误不包含数据库/Redis 连接串或内部异常。

非生产环境提供 /docs 和 /openapi.json；生产关闭文档路由。进程处理 SIGINT/SIGTERM 并释放数据库/Redis 连接。缺少数据库或 Redis 配置、无效环境/端口/URL 时拒绝启动。依赖服务临时故障时 liveness 保持可用，readiness 失败并允许后续探测恢复。

## 工作区与检查边界

- 根包继续拥有现有 miniprogram、preview、scripts 和 tests，保留微信开发者工具 project.config.json 的路径。apps/api 为 API；packages/contracts 仅共享公开响应类型，不含 Prisma 实体或服务端凭据。
- pnpm check 验证前端类型、原有行为测试、小程序构建、Vite 生产预览构建，以及真实 PostgreSQL/Redis 上的 API 行为。执行前先启动本地容器并完成迁移和 client generate。
- API 测试使用 HTTP 注入和真实本地依赖；连接失败使用不可连接地址，迁移缺失使用不存在的 schema。测试不触碰生产数据。
- GitHub Check 使用 Ubuntu 24.04、同一 Node/pnpm 和镜像 digest，执行迁移、检查和 OpenAPI 导出。微信原生编译器只能在安装开发者工具的 Mac 上单独执行，Linux CI 不将其记为已通过。
- T01 工程基础、T09 内置模板模块及 T06 本地身份链路已实现；真实微信身份/支付、录音上传、OSS、豆包/DeepSeek、业务 Worker、管理后台和实体交付仍以各票据验收为准。

## T06 微信身份与小程序模式

API 内部路径为 `POST /v1/sessions/wechat`（只接受 `{ code }`）、`GET /v1/users/me` 和 `DELETE /v1/sessions/:sessionId`。登录返回 `user.id` 和 `session.id/token/expiresAt`；后两者需 `Authorization: Bearer <token>`，撤销仅允许本人会话，跨账号和未知会话均返回 404。成功撤销为 204；其余成功/错误沿用统一 envelope 和 requestId。账号恢复是重新 `wx.login` 回到同一 `(AppID, openid)` 账号，不含手机号、项目或支付权限。

正式微信配置只用 `TIMENOOK_WECHAT_APP_ID` 与 `TIMENOOK_WECHAT_APP_SECRET`，必须属于 TimeNook 独立小程序，不复用 legal-agent 或 wutong 身份。开发未配置时登录为 503；生产缺失、只配置一项或占位内容均拒绝启动。代码没有可启用模拟身份的环境开关；外部网络替身仅能在 `environment=test` 的测试构造入口传入，生产和开发均拒绝该入口。正式凭据尚未提供，本地测试不是双账号微信验收。

会话由 32 随机字节生成，仅在签发时返回明文；服务端保存 SHA-256 摘要、失效时间及撤销时间，默认有效期 7 天，可用 `SESSION_TTL_SECONDS` 配置 1–2592000 秒。微信 code 先在 PostgreSQL 以 AppID+摘要唯一预占，10 分钟后可清理，覆盖微信文档的 5 分钟有效期；包括供应商超时在内的未知结果不重新使用同一 code，客户端下一次登录重新调用 `wx.login`。不持久化或返回 `session_key`/`unionid`。

Redis 对每个可信来源地址执行原子 120 次/分钟登录限流；依赖失败返回 503。Fastify 仅信任 `127.0.0.1`/`::1` 代理的转发链；部署时 Nginx 必须追加真实连接地址或覆盖 `X-Forwarded-For`，并保持 TimeNook 仅监听回环。外部直接请求伪造该头不会改变限流来源。Nginx 尚未修改，部署门槛仍属于 T29。

小程序默认保留本机演示。首页「切换到真实服务」只开放登录/恢复/退出，真实模式禁止演示 store 的读取和写入，也不开放模拟购买。会话存储按完整 API 基址分开，和 `timenook.frontend.v1` 演示资料隔离；不会导入、删除或声称云端保存了演示资料。401 清掉当前会话，网络错误保留待恢复会话且显示失败；退出先清本机身份，远端撤销失败明确显示未确认。迟到响应不恢复已退出身份、不覆盖新账号。

构建小程序时显式传入公开 API 基址：

```bash
TIMENOOK_API_BASE_URL=http://127.0.0.1:3417/v1 pnpm build:frontend
```

构建脚本不会自动读取 `.env` 中的公开基址；只传入上述非敏感值，不把 Secret 打包进小程序。空基址明确提示尚未配置。浏览器预览保留同页模式入口，但没有原生 `wx.login`，不模拟真实身份；可返回演示模式继续原 15 页体验。

ADR 0009 的部署目标为 `https://lawyerapi.threeminreading.com/timenook/v1`，Nginx 剥离 `/timenook` 后转发内部 `/v1`。该路径尚未部署；不得把设置基址或本地 HTTP 测试当作公网可用。真机需独立 AppID、开发权限及微信合法 request 域名配置。

T07 独立管理员的配置、受控建号、MFA、会话重启规则和本地 HTTPS 管理端见 [管理端开发](development-admin.md)。

T02 非生产录音probe的身份、私有存储模拟、OSS候选适配器、受控页及清理见[音频probe开发](development-audio-probe.md)。本地/契约测试不代表双端及真实OSS验收；[T02证据](delivery/2026-10-22/evidence/T02.md)分开记录。
