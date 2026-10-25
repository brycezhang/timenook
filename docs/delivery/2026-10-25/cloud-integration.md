# 2026-10-25 云端接口与本地客户端联调

API、OSS 与数据库已在 deed 阿里云环境完成本轮受控联调，网页在本机运行。最终 DeepSeek 请求通过 Packy 的 `https://cf.api.fan/v1/chat/completions`；真实合成样本的封存、转写、追问和故事整理均已通过。真实微信登录、支付、设备录音及正式发布/恢复未执行。

## 当前运行交接

| 项目         | 已核实状态                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------------- |
| 主机         | `106.14.11.96`，同 deed ECS                                                                                      |
| 服务/用户    | `timenook-api.service`，用户 `timenook`，enabled/active；回环监听 `127.0.0.1:4310`                               |
| 当前 release | `/data/server/timenook/releases/20261025-packy-045625`；`current` 原子指向此目录                                 |
| 回退 release | `/data/server/timenook/releases/20261025-cloud-043713`，对应启用 Packy 前的配置备份为 `shared/.env.before-packy` |
| 服务端 env   | `/data/server/timenook/shared/.env`，root:timenook、mode 640；不含前端发布内容                                   |
| 数据库       | deed 同一连接主机、端口、账号、密码，实际数据库为 `timenook`；25 条迁移完成                                      |
| Redis        | deed 云端连接，TimeNook 独立 `timenook-cloud` 键前缀                                                             |
| OSS          | deed 同一配置，静态 AK 仅服务端使用，所有对象限定于 `timenook/probe/`                                            |
| ASR          | 用户提供的豆包 key，`volc.seedasr.auc`，候选取源窗口 600 秒                                                      |
| DeepSeek     | deed 同一 Packy key；Base URL `https://cf.api.fan/v1`，候选模型 `deepseek-flash`、输出预算 1024                  |
| AI probe     | `AI_PROBE_ENABLED=candidate`，配置版本 `cloud-packy-2026-10-25`，需要独立短期 probe Bearer                       |
| 本地网页     | `http://127.0.0.1:5173/`，Vite 保持运行；同源代理到云端 `/timenook`                                              |
| 本地小程序   | `dist/miniprogram/` 已以公网 `/timenook/v1` 构建，19 页 wcc/wcsc 编译通过；未进行真机或微信登录                  |

运行时为独立 Node 22.23.4、固定 FFmpeg/FFprobe 8.1.1。API 使用 `NODE_ENV=development`；这保留现有正式业务准入限制，不宣称生产门禁已通过。服务内存限制 512 MiB、CPU 上限一核；最终实际内存/服务状态保存在本机私有日志，未调整 deed 的运行参数。

Nginx 在原域名的 HTTP/HTTPS server 中引用 `/etc/nginx/conf.d/timenook-routes.inc`，只对 `/timenook/` 剥离一次前缀。既有 deed 路由与服务保持运行；公网 TimeNook `/docs`、`/openapi.json` 返回 404。原配置备份为 `/data/server/timenook/shared/lawyer-be.conf.before-timenook`，后续回退须先比较现行配置，避免覆盖其他应用后续修改。

代码基线为 `febab2b88e3b1ffa2bb30de6d681a1074ec7560c` 加本轮工作区修改，**尚未提交或推送**。应用 TypeScript 在本机构建；服务器使用锁文件安装 Linux 依赖、生成目标 Prisma client，第二次发布核对锁文件/包声明/schema 未变后复用已验证依赖。服务器只有 API/契约产物，没有发布网页。最终包 SHA256：`ae3a2cdf1413f9d1cdc5e3b062a29664fc3c38636214972df571f573df37a4cc`，源码与产物指纹位于 release 的 `release-manifest.json`。

## 真实云端验证

| 检查                                                   | 结果                                                                                                                  |
| ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 公网 `/timenook/health/live`、`/timenook/health/ready` | 均 200；ready 同时检查已迁移数据库及 Redis                                                                            |
| deed 公网 `/v1/health` 与 API/Worker/Web 服务          | 200，三项服务均 active                                                                                                |
| 数据库隔离                                             | 与 deed 的连接主机/端口/账号/密码逐项相等，库名为 `timenook`；未修改 deed 库                                          |
| 真实 OSS 上传                                          | 限时、精确 key 的 V4 PostObject，返回 204，key 位于 `timenook/probe/staging/`                                         |
| 真实封存与回听                                         | ECS FFmpeg 校验 8.637 秒合成中文音频，seal 返回 201；鉴权读取 200，下载 SHA256 与上传一致                             |
| 私有访问                                               | 无 Bearer 回听 401，OSS 未签名访问 403                                                                                |
| 豆包适配器独立验证                                     | 同一请求 UUID 提交 accepted、查询 succeeded；均 HTTP 200/业务码 20000000，识别出 38 字合成内容                        |
| Packy 地址与 key                                       | deed 本地、生产均为 `https://cf.api.fan/v1`，TimeNook key 与 deed 生产 Packy key 相同；本机及 ECS 的 `/models` 均 200 |
| Packy 模型                                             | 列表包含 `deepseek-flash`、`deepseek-v4-flash`、`deepseek-v4-pro`；本轮只使用前者                                     |
| 完整 AI HTTP 链路                                      | 新身份/新 run UUID，从公网 audio/AI probe API 完成封存→豆包 accepted→succeeded→Packy question→story                   |
| 追问与整理结果                                         | 两项均 `state=succeeded`、`usable=true`，服务端结构和来源引用校验通过，返回模型均 `deepseek-flash`                    |
| 实际响应 token 计数                                    | 追问 prompt 496 / completion 102 / total 598；整理 448 / 191 / 639。它们是此次响应用量，不是费用或性能承诺            |
| 测试清理                                               | 两轮合成 probe 身份均撤销，对象及数据库元数据清理；最终 probe clips / AI runs 为 0；数据库保留                        |

最初将 Packy key 发往 DeepSeek 官方域名得到 401，**该结果不代表 key 无效**。用户说明中转服务后，依据 deed 实际配置和 [Packy 官方端点说明](https://docs.packyapi.ai/docs/register/)修正。实际 Base URL 填到 `/v1`，适配器追加 `/chat/completions`；[Packy DeepSeek 接入说明](https://docs.packyapi.ai/docs/advanced/DeepSeekCodex.html)也使用该地址。

样本是本机 TTS 生成的固定中文短文，没有私人录音或真实用户素材。这证明本轮配置与受控协议链路，不证明口音/事实质量、真实用户授权或商业服务条款。独立 ASR 验证与后续完整 AI HTTP 验证使用不同样本记录/请求 UUID；没有跨端点恢复旧任务，没有自动改换供应商。

## 代码与本地回归

共享 OSS 显式区分静态 AK 与 STS，统一给上传/复制/读取/删除/ASR 签名加前缀。静态凭据没有伪造的到期字段；URL 自身仍限时，STS 到期校验兼容。不同前缀进入不同 storageScope。

DeepSeek 新增 `TIMENOOK_PROBE_DEEPSEEK_BASE_URL`，统一规范化、HTTPS 校验及 endpoint 拼接。AiProbe、Stories、Followups 的配置快照都包含有效端点，防止旧任务在地址变更后继续执行；未改变业务合成模式门禁。

| 验证                           | 结果                                                                                                         |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------ |
| 共享 OSS 新行为                | 先 RED 后 GREEN；最终定向 14/14，真实本地 PostgreSQL/Redis 相关回归 61/61                                    |
| 共享 OSS 改动后的当前 API 回归 | 排除微信身份/支付专项，21 个源文件，286/286                                                                  |
| Packy 端点与 URL 约束          | 先 RED 后 GREEN；单测 9/9                                                                                    |
| Packy 端点漂移                 | 三个真实 PG/Redis 场景先 RED 后 GREEN：探针重放/advance 409；故事/追问旧任务 CONFIGURATION_CHANGED，均零外呼 |
| Packy 最终受影响模块           | AI 配置/协议/探针、OSS、故事、追问共七文件 83/83                                                             |
| Vite 转发与私有文件            | 新路由先 RED 后 GREEN，3/3；独立 Standards/Spec 审查无发现，两种 target 的代表路径/Host 及私有路径拒绝均另验 |
| 最终类型与构建                 | 全工作区 typecheck、API/契约 build、API 测试编译成功；客户端构建及 19 页原生编译成功                         |

本机 `.env` 始终保留本地可丢弃数据库/Redis。上述自动化回归没有连接云端 `timenook`，没有调用微信/支付；真实供应商证据只来自单独受控合成测试。此前 520 项纯本地阶段结果仍按[原记录](local-stage.md)的旧代码范围适用，不重复合计成本轮修改后的全量结果。

## 本地网页 QA

Browser plugin not available；使用现有 Playwright 工具检查本地 Vite 页面。目标流程为首页→“先看看，一本故事书的模样”→示例项目页，同时从浏览器调用同源健康代理。

| 检查              | 结果                                                                     |
| ----------------- | ------------------------------------------------------------------------ |
| 页面身份/非空     | 标题“时光里 · 岁月成书”，示例项目内容正常                                |
| 框架覆盖层/控制台 | 无 Vite 错误覆盖层，错误/警告均 0                                        |
| 交互              | 点击示例入口后进入 `/#/project`，故事列表及示例提示正常                  |
| 云端代理          | 浏览器访问 `/timenook/health/ready` 返回 200                             |
| 私有文件          | `.env.probe-local`、`.probe-local` 身份文件均 403                        |
| 视口              | 430×932 与 1280×900；桌面容器保持 390px 预览宽度                         |
| 截图              | [本机私有截图](../../../.probe-local/cloud-2026-10-25/local-preview.png) |

页面中的人物和故事明确为本机示例。微信登录继续跳过，因此这些示例不是云端产品账号或项目；未声称浏览器/真机真实录音、OSS CORS、付款或正式 Worker 通过。

## 运维与证据位置

客户端及配置命令见[共用服务说明](../../development-shared-services.md)。API 重启使用 `systemctl restart timenook-api`；更新服务器 env 后先按现有服务用户与权限校验，再只重启本服务。当前/回退 release 与各自 env 必须配对，不把 Packy 配置套用到不支持 base URL 的旧版本。

原始日志和合成请求响应留在 Git 忽略目录 `.probe-local/cloud-2026-10-25/`，包括 `release.json`、`packy-release-manifest.json`、`packy-activate.log`、`database-final.log`、`services-final.log`、`oss-smoke.json`、`asr-summary.json`、`packy-http-summary.json`、`packy-cleanup.log`、`local-proxy-smoke.json` 与 `typecheck-final.log`。未知提交结果使用原 UUID 查询，新的测试必须新建显式 run；不把未知结果直接当失败重提。

本轮没有修改 GitHub issue 状态，没有完成或关闭 T29/T30。正式微信/支付、真实用户采集、管理员 MFA、服务期限、备份恢复/删除台账、实物和售卖仍按原责任票验收。
