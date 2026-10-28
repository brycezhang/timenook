# 2026-10-28 域名和入口配置

按用户决定，两个 DNS A 记录均指向共用 ECS `106.14.11.96`：`timenookapi.threeminreading.com` 和 `sgl.wootoon.cn`，阿里云 DNS 默认线路、TTL 10 分钟。`api.threeminreading.com` 已被其他 CDN 服务使用，本轮未修改其 DNS、CDN 或源站。开发阶段的当前目标入口以 [ADR 0015](../../adr/0015-dedicated-domain-ingress.md) 为准。

服务器 Nginx 分别使用 `/etc/nginx/conf.d/timenook-api-domain.conf` 与 `timenook-website.conf`。两个域名通过已有 Certbot webroot 方式取得独立 Let's Encrypt 证书（到期 2027-01-26 UTC）；既有 `/etc/cron.d/lawyerapi-certbot-renew` 对该证书目录运行 renew，并在更新后 reload Nginx；两个域名的 Certbot 模拟续期均成功。HTTP 入口提供 ACME 验证和跳转 HTTPS；官网 HTTPS 当前返回 503，待官网部署时替换。

新 API 的 `/api/` 剥离一次后转至 `127.0.0.1:4310/`，源站设置 `Cache-Control: no-store` 并覆盖客户端来源地址的转发头；`/api/docs`、`/api/openapi.json` 拒绝访问。未部署新应用或改动数据库与服务环境。

## 验证及边界

2026-10-28，公网 TLS 校验通过：新 `/api/health/live`、`/api/health/ready` 和 `/api/v1/recipient-types` 均 200；未登录的 `/api/v1/users/me` 为 401，空登录 POST 为 400；文档和 OpenAPI 入口均 404；官网 HTTPS 503 为预留状态。旧 TimeNook ready 与 deed `/v1/health` 均 200，Nginx、TimeNook API 和 deed API/Worker/Web 均 active。本地 Vite 代理对新域名的 ready、目录、未登录请求分别返回 200、200、401；按新基址构建小程序成功，25 页 wcc/wcsc 编译通过。域名变更未验证微信合法域名、微信设备、真实支付/退款或管理端。

该次核验的云端 release 是 `/data/server/timenook/releases/20261025-packy-045625`，不是当前 main；管理端和支付通知尚未按当前目标实现、部署与验收。小程序按 `TIMENOOK_API_BASE_URL=https://timenookapi.threeminreading.com/api/v1` 构建。上述实际观察不构成保留旧入口或兼容开发构建的要求；后续直接按当前配置实施，分别记录目标能力的验证结果。本次文档更新未操作远端路由。
