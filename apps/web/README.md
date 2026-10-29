# 时光里网页产品入口

手机优先的内部验收入口，部署目标为 `https://sgl.wootoon.cn/app/`，营销落地页继续位于根路径。范围与六票进度见[统一流程规格](../../docs/delivery/2026-10-29/mobile-web-spec.md)和[实施票据](../../docs/delivery/2026-10-29/mobile-web-tickets.md)。

## 开发与验证

在仓库根目录执行 `pnpm dev:web`、`pnpm typecheck:web`、`pnpm build:web`。开发默认监听 `127.0.0.1:4330`；独立构建产物位于本应用 `dist/`，静态资源基址为 `/app/`，部署须让产品深链返回本应用入口。

接口使用同源 `/api/v1`，开发及预览通过 `TIMENOOK_WEB_API_TARGET` 指定回环后端，例如 `http://127.0.0.1:3417`。代理剥离一次 `/api`，不代理到其他项目。网页 Cookie 要求 HTTPS；本地可用 `TIMENOOK_WEB_TLS_CERT`、`TIMENOOK_WEB_TLS_KEY` 指向工作区外的测试证书文件。未配置后端时仍可检查公开入口与失败提示，不会回退到演示身份。

`pnpm test:web` 复用仓库浏览器测试配置。测试自动创建隔离 PostgreSQL schema、Redis 前缀、隐私台账及临时 HTTPS，使用受控 CLI 预建账号、签发票据，再由真实浏览器点击兑换、恢复和退出。先生成 Prisma、构建 contracts/API，并编译 API 测试；固定运行时与本地服务沿用[开发说明](../../docs/development.md)。测试不读取微信、商户或 AI 凭据，自动截图／trace／录屏关闭。

## 登录与资料边界

内测登录链接通过受控 CLI 私下发放，页面读取 fragment 后立即清除地址栏，只在用户点击后兑换；票据、CSRF 和用户会话均不写入 localStorage／sessionStorage。服务端通过受保护 Cookie 签发网页会话，产品账号与小程序内部用户共用；真实微信关联由 W02 与平台条件另行验证。

登录和退出使用同源 Web Locks 串行执行，覆盖同一页面与多个标签页，避免迟到响应的 Cookie 覆盖新账号。需要支持 Web Locks 的现代 HTTPS 浏览器，不支持时提示更新浏览器并停止兑换；会话已过期或已在其他标签页退出时，再次退出视为完成。

成功兑换新链接会原子替换原浏览器网页会话，其他设备会话保持独立。旧标签页退出前重新核对当前会话；若账号已在别处切换，仅清空旧页面，不撤销新账号的会话。

W01 提供登录、会话和本人项目列表；W02b 进一步接通 `/app/project/:projectId` 的共用业务页面和 Cookie 媒体传输，见[实现与验证边界](../../docs/development-web-product.md)。W02–W06 已接通显式受控的无付款项目、真实网页授权渠道、内容处理和PDF，实际部署与同一项目的运行结果见[网页验收记录](../../docs/delivery/2026-10-29/mobile-web-online.md)。微信身份和真机结果单独保留。

静态开发服务器沿用仓库私人文件拒绝列表。真实登录链接、配置、录音、故事和 PDF 保持在 Git 外；私有响应由后端返回 `no-store`，部署不能将其纳入静态缓存。
