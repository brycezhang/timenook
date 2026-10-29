# 网页会话接入共用业务页面

[W02b #109](https://github.com/brycezhang/timenook/issues/109) 是 [W02 #97](https://github.com/brycezhang/timenook/issues/97) 的独立客户端切片，消费已合入的 W01 网页会话和 W03a 分步页面。它接通项目页面及媒体传输；无付款项目、真实网页授权渠道、供应商和同域实际发布仍由父票接续。

## 页面与会话

网页登录后，项目列表可打开 `/app/project/:projectId`。该入口复用 `preview/runtime.ts` 和原生 WXML、WXSS、Page 控制器；原浏览器预览继续使用同一运行模块。网页产品强制 live 模式，省去预览工具栏及模拟设备外框；原生购买和微信登录继续由各自平台处理。

`SessionClient` 的 Cookie 传输由网页入口安装。网页会话证明仅在内存中，业务请求不构造 Bearer 凭据，也不把票据、Cookie 或 CSRF 写入本地存储。每项受保护操作与登录、退出共用同源 Web Lock，先向服务器核对 User、Session 和 CSRF，再传输业务请求；状态变更携带实际 Cookie 和 CSRF。

跨标签页账号变化会通过不含凭据的广播清空旧页面；每项受保护操作仍以服务器重验为准。离开页面会清空视图、停止页面活动及请求，迟到结果无法恢复旧资料；结束本机页面不等于撤销服务端会话。退出仍执行服务端撤销。浏览器往返缓存恢复时重新加载，以当前会话重新创建页面。

## 文件与保存

录音和照片上传复用同一目标地址与过期检查。隔离本地存储通过同源 Cookie/CSRF 传输；OSS 使用服务端限时表单，向 OSS 请求不携带网页 Cookie。下载文件作为实际临时 Blob 交给既有校验、播放和清理流程；本机原始录音仍由原账号、API、项目及实际问题清单隔离。

停止录制、本机保存、回听和明确提交继续由共享页面负责。此票不改原件 hash、可靠保存后转写、可选追问、确定版本确认或授权规则，也不替代浏览器真实 MP3、私有 OSS 与真实 ASR 的责任票。

## 验证范围

新增真实 HTTPS、PostgreSQL/Redis、受控账号 CLI 和 Cookie/CSRF 的浏览器用例，覆盖共用业务请求、恢复和退出、跨标签页换号、离页迟到响应、项目深链刷新、分步准备以及原件提交后回取 hash/MIME/长度。页面检查使用生产构建的手机和桌面入口；传输接口探针使用独立 HTTPS 开发服务，原 W01 生产构建回归保持不变。Browser plugin 未提供，使用仓库 Playwright 流程。

录音声音在此传输用例中仅替换原生设备输入，实际 Page、本机 IndexedDB、HTTP、文件校验及封存均执行。测试项目沿用明确隔离的既有付款协议夹具，授权预先通过原生协议建立；不把它作为无付款项目、真实网页本人授权来源、真实资金或微信设备的证据。非 test 网页产品装配仍默认拒绝，须完成 W02/W04 受控运行及长期服务规则后再启用。

```sh
pnpm exec playwright test tests/admin/web-product-session.spec.mjs -c playwright.admin.config.mjs
pnpm test:frontend
pnpm typecheck:frontend
pnpm typecheck:web
pnpm build:frontend
pnpm build:web
pnpm check:native
```

固定候选、最终 PR/main CI、实际配置和未验条件在交付记录中分别保存，不能由本地通过推定公网已经可用。
