# 时光里网页产品入口

手机优先的内部验收入口，部署目标为 `https://sgl.wootoon.cn/app/`，营销落地页继续位于根路径。范围与六票进度见[统一流程规格](../../docs/delivery/2026-10-29/mobile-web-spec.md)和[实施票据](../../docs/delivery/2026-10-29/mobile-web-tickets.md)。

## 开发与验证

在仓库根目录执行 `pnpm dev:web`、`pnpm typecheck:web`、`pnpm build:web`。开发默认监听 `127.0.0.1:4330`；独立构建产物位于本应用 `dist/`，静态资源基址为 `/app/`，部署须让产品深链返回本应用入口。

接口使用同源 `/api/v1`，开发及预览通过 `TIMENOOK_WEB_API_TARGET` 指定回环后端，例如 `http://127.0.0.1:3417`。代理剥离一次 `/api`，不代理到其他项目。网页 Cookie 要求 HTTPS；本地可用 `TIMENOOK_WEB_TLS_CERT`、`TIMENOOK_WEB_TLS_KEY` 指向工作区外的测试证书文件。未配置后端时仍可检查公开入口与失败提示，不会回退到演示身份。

`pnpm test:web` 复用仓库浏览器测试配置。测试自动创建隔离 PostgreSQL schema、Redis 前缀、隐私台账及临时 HTTPS，使用受控 CLI 预建账号、签发票据，再由真实浏览器点击兑换、恢复和退出。先生成 Prisma、构建 contracts/API，并编译 API 测试；固定运行时与本地服务沿用[开发说明](../../docs/development.md)。测试不读取微信、商户或 AI 凭据，自动截图／trace／录屏关闭。

## 登录与资料边界

内测登录链接通过受控 CLI 私下发放，页面读取 fragment 后立即清除地址栏，只在用户点击后兑换；票据、CSRF 和用户会话均不写入 localStorage／sessionStorage。服务端通过受保护 Cookie 签发网页会话，产品账号与小程序内部用户共用；真实微信关联由 W02 与平台条件另行验证。

当前 W01 范围是登录、会话和本人项目列表。内测项目准备、统一分步录制、真实内容处理、PDF 及部署由后续票据交付；构建成功不代表这些链路或微信真机已经通过。

静态开发服务器沿用仓库私人文件拒绝列表。真实登录链接、配置、录音、故事和 PDF 保持在 Git 外；私有响应由后端返回 `no-store`，部署不能将其纳入静态缓存。
