# 产品网页版

`apps/web` 是独立 Vue 3 + TypeScript + Vue Router 应用，部署入口为 `/app/`，同源 API 为 `/api/v1`。正式入口不再导入小程序页面运行器或设计原型。

## 当前可操作范围

- 手机/桌面公开首页、公开样书、完整使用条款与隐私说明。
- 手机号验证码登录，明确同意条款后发送；失败、重发等待、验证码失效与重试。
- Secure/HttpOnly Cookie 会话恢复、退出、跨标签页换号后的资料清理。
- 当前账号的真实项目列表与空态，使用现行项目成员接口 `/participations`。
- 与小程序使用同一个已验证手机号归属同一产品账号，保留昵称与购买/受邀项目。

- 项目详情、故事搜索与入书筛选、故事阅读/版本编辑、编入及移出书稿；并发版本冲突保留未保存的文字。
- 项目名称与昵称修改，网页邀请链接生成、短信登录返回原邀请、明确同意并接受后取得成员资格。

录音、照片、书稿编辑、支付宝购买和印刷等后续切片继续实施。WV03 本身不创建销售订单或修改 payment-service。

## 开发与验证

```sh
pnpm install --frozen-lockfile
pnpm --filter @timenook/contracts build
pnpm --filter @timenook/api db:generate
pnpm --filter @timenook/web typecheck
pnpm --filter @timenook/web build
```

服务端需应用当前 Prisma 迁移；手机号使用规范格式并有唯一约束，重复归属不会自动合并。开发服务器和预览服务器均支持以下配置：

- `TIMENOOK_WEB_TLS_CERT` / `TIMENOOK_WEB_TLS_KEY`：本地 HTTPS 证书路径。
- `TIMENOOK_WEB_API_TARGET`：API 进程地址，代理将 `/api/v1/...` 转发到 `/v1/...`。
- API `WEB_ORIGIN`：实际网页 HTTPS origin；`WEB_SESSION_KEY` 为服务端随机 32 字节 base64 密钥。
- API `ALIYUN_SMS_ACCESS_KEY_ID`、`ALIYUN_SMS_ACCESS_KEY_SECRET`、`ALIYUN_SMS_SIGN_NAME`、`ALIYUN_SMS_TEMPLATE_CODE`：真实短信配置，保存在 Git 外，禁止使用 `VITE_` 前缀。

```sh
pnpm --filter @timenook/web dev
```

未配置短信时发送接口返回失败，不会签发验证码登录会话。无浏览器开关可跳过验证码；旧内测票据、模拟登录/购买和手动微信配对不再通过公开 HTTP 登录入口提供。

浏览器定向验证使用构建后的网页、隔离 PostgreSQL schema 和 Redis 命名空间，仅替换外部短信/微信网络，不开启运行时演示模式：

```sh
pnpm --filter @timenook/contracts build
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
pnpm --filter @timenook/web build
# DATABASE_URL / REDIS_URL 必须指向本机 compose 服务。
pnpm test:web-mvp
```

该命令不加入旧产品网页 CI，也不恢复已退役的浏览器模拟小程序套件。供应商真实投递、部署及真机验收另行记录。

已定方案见 [ADR 0019](../../docs/adr/0019-phone-unified-product-account.md)、[开发计划](../../docs/delivery/2026-11-07/web-vue-development-plan.md)，首阶段证据见[入口与登录记录](../../docs/delivery/2026-11-08/web-mvp-entry.md)，项目、故事与邀请证据见 [WV03 记录](../../docs/delivery/2026-11-08/web-mvp-stories.md)。
