# 共用服务配置与云端联调

当前按用户确认的拓扑运行：API、OSS、数据库使用 deed 所在阿里云环境，小程序与网页在本地。OSS 使用独立私有 Bucket `timenook`，AccessKey 继续沿用 deed；数据库复用 deed 连接配置，新库名为 `timenook`。决策见 [ADR 0011](adr/0011-shared-oss-and-deepseek.md)、[ADR 0012](adr/0012-cloud-integration-database.md)、[ADR 0013](adr/0013-dedicated-oss-bucket.md)；最新 [Bucket 切换记录](delivery/2026-10-25/oss-bucket.md)、此前的[云端验证记录](delivery/2026-10-25/cloud-integration.md)与[纯本地测试](delivery/2026-10-25/local-stage.md)分别保留。

## 运行位置

| 用途       | 当前配置                                                                    |
| ---------- | --------------------------------------------------------------------------- |
| ECS        | `106.14.11.96`，与 deed 同机                                                |
| API        | `timenook-api.service`，独立用户 `timenook`，回环 `127.0.0.1:4310`          |
| 公网 API   | `https://timenookapi.threeminreading.com/api/v1`                         |
| 健康检查   | 公网 `/api/health/live`、`/api/health/ready`                      |
| 服务器目录 | `/data/server/timenook/{releases,current,runtime,shared}`                   |
| 服务端凭据 | `/data/server/timenook/shared/.env`，root:timenook、mode 640                |
| 数据库     | deed 同一 RDS 连接主机、账号、密码；数据库 `timenook`，独立业务表和迁移历史 |
| Redis      | 复用 deed 的云端连接；应用键前缀 `timenook-cloud`                           |
| OSS        | 独立私有 Bucket `timenook`，上海 `cn-shanghai`，沿用 deed AccessKey；探针前缀 `timenook/probe/` |
| 网页       | 内测产品 `https://sgl.wootoon.cn/app/`；本地预览仍可通过 Vite 代理到公网 API |
| 小程序     | 本地开发者工具加载 `dist/miniprogram/`，API 基址为上述公网 HTTPS 地址       |

API 使用 `NODE_ENV=development`，这是受控联调服务。2026-10-29 起通过显式 `INTERNAL_ACCEPTANCE_ENABLED=1` 启用独立无付款项目和预建网页账号，使用真实产品授权、OSS/AI/Worker与PDF，不伪造微信或支付。网页同源 `/api/` 代理现有API，实际结果见[统一流程运行验收](delivery/2026-10-29/mobile-web-online.md)。公网文档入口继续由Nginx拒绝，探针仍使用独立短期身份；微信登录和真实支付暂不执行。

2026-10-28 域名配置与线上验证见 [域名配置记录](delivery/2026-10-28/domain-ingress.md)。管理页面 `/admin/`、管理 API/Cookie `/api/v1/admin` 和微信支付通知的实现与验收按 [ADR 0015](adr/0015-dedicated-domain-ingress.md) 执行。

## 本地客户端启动

根目录 Git 忽略文件 `.env.frontend-local` 只包含公开地址：

```dotenv
TIMENOOK_API_BASE_URL=http://127.0.0.1:5173/timenook/v1
TIMENOOK_PREVIEW_API_TARGET=https://timenookapi.threeminreading.com/api
```

```sh
node --env-file=.env.frontend-local node_modules/vite/bin/vite.js --host 127.0.0.1
```

浏览器走本机同源代理。浏览器本地路径仍为 `/timenook/...`；代理剥离该前缀并将目标的 `/api` 前缀加到云端请求。既有本地 fixture target 仍可使用不带前缀的地址。健康/探针接口已加入代理，私人环境文件及 `.probe-local` 仍拒绝访问。

小程序在本地构建，公开基址与浏览器代理地址分别传入：

```sh
TIMENOOK_API_BASE_URL=https://timenookapi.threeminreading.com/api/v1 \
TIMENOOK_AUDIO_PROBE_BUILD=1 pnpm build:frontend
pnpm check:native
```

网页保留明确标识的本机演示；因微信登录暂不执行，演示项目不是云端产品项目。原生录音探针是独立受控入口，不依赖微信登录；身份须由服务器 CLI 生成并通过私有文件交给操作员。真机权限、合法域名和设备采集仍待实际验证。

本机 `.env` 继续只连接可丢弃的本地 PostgreSQL/Redis，供自动化回归使用，不把云端库配置替换进去。

## OSS 与 ASR 配置

服务器 `.env` 显式设置：

```dotenv
AUDIO_PROBE_ENABLED=oss
TIMENOOK_PROBE_OSS_CREDENTIAL_MODE=static
TIMENOOK_PROBE_OSS_KEY_PREFIX=timenook/probe
TIMENOOK_PROBE_OSS_BUCKET=timenook
TIMENOOK_PROBE_OSS_REGION=cn-shanghai
TIMENOOK_PROBE_OSS_ACCESS_KEY_ID=
TIMENOOK_PROBE_OSS_ACCESS_KEY_SECRET=
TIMENOOK_PROBE_DOUBAO_API_KEY=
TIMENOOK_PROBE_DOUBAO_RESOURCE_ID=volc.seedasr.auc
TIMENOOK_PROBE_DOUBAO_FETCH_WINDOW_SECONDS=600
```

Bucket 已独立为 `timenook`，地域为上海；AccessKey 继续从 deed 服务器环境映射，豆包 key/资源已从用户填写的本机 `.env.probe-local` 安全同步，密钥不在上面列出。本机 `.env.shared-local` 的 `ALI_OSS_BUCKET` 和 `.env.probe-local` 的 `TIMENOOK_PROBE_OSS_BUCKET` 均为 `timenook`；不能重新从 deed 覆盖 Bucket 名。600 秒仅为本次合成样本的候选取源窗口，不是服务时延承诺。后续更新本机文件不会自动同步服务器，须单独更新服务端私有配置并重启本项目服务。

静态模式强制 `timenook` 或其子路径作为前缀，禁止混入 `SECURITY_TOKEN`、`EXPIRES_AT`。长期 AK 只在服务端签名；客户端只获得精确暂存 key 的限时表单，最终 key 不开放上传。上传签名最多 120 秒，ASR 取源 URL 另按配置限时；静态凭据没有虚构的 STS 过期时间。可选 STS 模式继续支持原到期校验。

所有读/写/复制/删除、ASR 签名均加项目对象前缀，storageScope 同时包含前缀，清理不能跨前缀。未改 deed 的 Bucket 生命周期或 CORS 规则；浏览器直接向 OSS 上传的 CORS 配置仍需按实际客户端另验。本轮真实 OSS 上传通过 Node HTTP 客户端验证，不将它当作浏览器/真机上传证明。

## Packy 中转的 DeepSeek

DeepSeek 通过 Packy 的 OpenAI 兼容 Chat Completions 接口调用。deed 本地及服务器 `OPENAI_BASE_URL` 均为 `https://cf.api.fan/v1`，TimeNook 的 `TIMENOOK_PROBE_DEEPSEEK_API_KEY` 与 deed 生产 Packy key 一致。

```dotenv
TIMENOOK_PROBE_DEEPSEEK_BASE_URL=https://cf.api.fan/v1
TIMENOOK_PROBE_DEEPSEEK_MODEL=deepseek-flash
TIMENOOK_PROBE_DEEPSEEK_MAX_TOKENS=1024
```

Base URL 填到 `/v1`，适配器追加 `/chat/completions`。Packy [官方端点说明](https://docs.packyapi.ai/docs/register/)与上述地址一致；[DeepSeek 接入说明](https://docs.packyapi.ai/docs/advanced/DeepSeekCodex.html)也列出同一地址。已实际查询 `https://cf.api.fan/v1/models` 返回 200，可用模型包括 `deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-pro`。1024 是本轮合成样本的明确候选输出预算，未冻结为商业参数。

此前的 401 来自向 DeepSeek 官方域名误发 Packy key，不能据此判断 key 失效。现已增加显式 Base URL 配置和 HTTPS 校验；端点进入探针及生成任务的配置快照，变更后旧任务不能跨端点重放。

豆包已使用相同发布版本的 `DoubaoFileAsr` 适配器在 ECS 上完成真实合成语音提交/查询；初次验证未经过 AI probe HTTP。Packy 修正后的完整 AI 探针验证、启用状态与实际输出见[云端验证记录](delivery/2026-10-25/cloud-integration.md)。正式采访 Worker、微信身份、模型质量/条款/费用仍按原责任票验收。

根目录 `.env.probe-local`、`.env.shared-local` 与 `.env.frontend-local` 均被 Git 忽略；不把密钥发到聊天、写进文档或打包进前端。模型/供应商细节见 [AI probe](development-ai-probe.md)，录音与身份操作见[音频 probe](development-audio-probe.md)。
