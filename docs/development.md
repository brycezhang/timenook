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
- 当前只交付 T01 工程基础。录音上传、真实微信身份/支付、OSS、豆包/DeepSeek、业务 Worker、管理后台和实体交付仍以各票据验收为准。
