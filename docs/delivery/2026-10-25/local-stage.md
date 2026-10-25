# 2026-10-25 阶段性本地测试

代码基线为 `febab2b88e3b1ffa2bb30de6d681a1074ec7560c`（已合并 T19）。本轮只调整共用服务决策、说明及本机 Git 忽略配置，没有修改业务代码、迁移或锁文件，也没有部署、提交、推送或修改 GitHub Issues 状态。

## 已确认配置与实际边界

与 deed 共用 ECS、OSS 配置和 DeepSeek API key 的决定见 [ADR 0011](../../adr/0011-shared-oss-and-deepseek.md)，具体文件与变量见[共用服务配置](../../development-shared-services.md)。OSS 配置来自 deed 生产环境文件，DeepSeek key 来自本机 legal-agent `.env`；本次只读核实的 deed 生产文件没有 `DEEPSEEK_API_KEY`。

私有 `.env.shared-local`、`.env.probe-local` 均为 mode 600 且被 Git 忽略。配置校验确认 DeepSeek 两处副本与来源一致，实际加载配置的微信/支付/云端 OSS/AI 均未启用。豆包 ASR key、资源、窗口，DeepSeek 模型/预算以及 OSS STS 仍待填写；共享对象前缀仍待适配。没有调用真实供应商或读写 deed 的 OSS 对象。

服务器 `106.14.11.96` 上的 deed API/Worker/Web 均 active。经 TLS 校验的公网 `https://lawyerapi.threeminreading.com/v1/health` 返回 200；`https://lawyerapi.threeminreading.com/timenook/health/live` 返回 404。因此本轮结果不表示 TimeNook 已上线。

## 环境与结果

使用 Node 22.23.4、pnpm 10.34.7、现有 `timenook-dev` PostgreSQL/Redis 健康容器，以及 `/tmp/timenook-ffmpeg-8.1.1-minimal/bin` 的固定 FFmpeg/FFprobe。数据库和 Redis 只连接本地回环地址；集成测试使用隔离 schema/prefix、合成素材与供应商替身。

| 阶段                                | 实际结果                                                  | 本机日志（Git 忽略）                                                       |
| ----------------------------------- | --------------------------------------------------------- | -------------------------------------------------------------------------- |
| 依赖、Prisma client 与迁移          | 锁文件安装、generate、migrate deploy 通过                 | `.probe-local/phase-2026-10-25/install.log`、`generate.log`、`migrate.log` |
| 全工作区类型与构建、API 测试编译    | 全部通过                                                  | 同目录 `typecheck.log`、`build.log`、`test-compile.log`                    |
| 前端行为                            | 199/199 通过                                              | 同目录 `frontend.log`                                                      |
| 当前 API 源文件对应回归             | 20 个文件，281/281 通过                                   | 同目录 `api-current.log`                                                   |
| 印刷探针                            | 13/13 通过                                                | 同目录 `print.log`                                                         |
| 微信原生静态编译                    | wcc/wcsc 各 19 页通过，不登录微信                         | 同目录 `native.log`                                                        |
| Chromium 页面/实际 HTTP/Worker 回归 | 7 个文件，27/27 通过                                      | 同目录 `browser.log`                                                       |
| 使用新私有配置启动独立本地 API      | live/ready 均 200，未登录用户访问 401，未启用 AI 路由 404 | 同目录 `local-api.log`、`local-http.json`                                  |

共通过 520 项行为/浏览器测试，另通过类型、构建、迁移与原生编译。未执行 `identity.test.ts`、`payments.test.ts`，前端排除 `session.test.ts` 和 `payment-*.test.ts`；浏览器只运行下列七个内容流程文件。其他业务测试中的合成身份/付款 fixture 只为隔离项目准备数据，不调用真实微信或支付接口。

初次类型检查发现本机 API `node_modules` 缺少锁文件已声明的 `bullmq`，`require.resolve` 复现；执行 `pnpm install --frozen-lockfile` 后解析、类型和构建恢复，未改依赖版本。第一次 API 命令依据编译前已有的 dist 文件列表运行了 148 项；最终重新按当前源码文件清单运行全部选定的 281 项，以 `api-current.log` 为准。

浏览器覆盖个人计划、录音与本地恢复、转写/重试、照片与权限清理、可选追问、故事整理、本人确认及项目进度。使用真实 Page、HTTP、PostgreSQL 和 Worker，外部供应商仍为替身。390px 手机及相关 768px 布局通过现有断言，未发现非预期页面异常；T17 的主动断网/到期用例按预期捕获一条 `net::ERR_TIMED_OUT`，其他相关页面错误断言通过。合成页面截图保存在 `/tmp/timenook-t14-recording-768.png`、`/tmp/timenook-t19-project-390.png` 和 `/tmp/timenook-t19-assisted-story-390.png`。

## 复现入口

先按[开发指南](../../development.md)准备本地依赖。不要把本轮私有共享密钥文件加载进自动化测试，测试只读取本地 `.env`。

```sh
export PATH=/tmp/timenook-ffmpeg-8.1.1-minimal/bin:$PATH
pnpm install --frozen-lockfile
pnpm db:generate
pnpm db:migrate
pnpm typecheck
pnpm build
pnpm --filter @timenook/api exec tsc -p tsconfig.test.json
pnpm test:print
pnpm check:native
```

前端与 API 清单按当前源码选择，排除微信身份及支付专项：

```python
from pathlib import Path
import subprocess

front = [str(p) for p in sorted(Path("tests").glob("*.test.ts"))
         if p.name != "session.test.ts" and not p.name.startswith("payment-")]
subprocess.run(["pnpm", "exec", "tsx", "--test", "--test-timeout=30000", *front], check=True)
api = ["dist-test/test/" + p.stem + ".js"
       for p in sorted(Path("apps/api/test").glob("*.test.ts"))
       if p.name not in {"identity.test.ts", "payments.test.ts"}]
subprocess.run(["node", "--env-file-if-exists=../../.env", "--test", *api],
               cwd="apps/api", check=True)
```

浏览器单 worker 串行执行，测试文件自行准备和回收隔离资源：

```sh
node --env-file-if-exists=.env node_modules/@playwright/test/cli.js test \
  -c playwright.admin.config.mjs --workers=1 \
  tests/admin/personal-plan.spec.mjs \
  tests/admin/interview-recording.spec.mjs \
  tests/admin/transcription.spec.mjs \
  tests/admin/story-photos.spec.mjs \
  tests/admin/optional-followup.spec.mjs \
  tests/admin/story-generation.spec.mjs \
  tests/admin/story-confirmation.spec.mjs
```

真实微信登录/支付、真机录音、OSS STS/权限/前缀、豆包识别质量、DeepSeek 实际模型与费用、正式部署/恢复均未验收；对应责任票保持原状态。本轮独立启动的 API 已停止，本来就在运行的 PostgreSQL/Redis 保留。
