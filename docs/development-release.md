# 候选发布包

本工具生成可核对的发布产物；T26/T28 工程已合并，T29 正在执行普通商户装配和受控发布。独立小程序尚未申请下来，微信身份留空，真实收退款与售卖保持关闭。运行证据与剩余正式条件见 [T29 记录](delivery/2026-10-28/t29-release.md)，人工输入见[清单](delivery/2026-10-26/manual-inputs.md)。

## 生成与核验

沿用锁定 Node/pnpm，先完成构建、字体准备与相关检查。源码必须已提交且已跟踪文件无修改；输出必须是源码目录外的新目录。Linux CI 在整仓检查、OpenAPI 和浏览器成功后生成候选包并上传 Actions artifact，保留 7 天。这是构建产物期限，与用户资料 D03 无关。

```sh
pnpm release:candidate --platform linux --output /absolute/new/timenook-release
node scripts/release/package.mjs verify --root /absolute/new/timenook-release --platform linux
```

Mac 可省略 `--platform linux` 生成仅供检查的本机候选；清单如实记录 Darwin/arm64，不能称为 Linux 构建。指定平台与实际构建主机不同会失败；Node 与 `.node-version` 不符也失败。CLI 不加载 `.env`，不读取云端配置或访问供应商。

产物为候选目录、同级 `.tgz` 和 `.tgz.sha256`。`release-manifest.json` 记录源码提交、Node/pnpm 固定版本、构建平台/架构/Node OpenSSL，以及每个文件的相对路径、字节数和 SHA256。目录包含 API/Worker 编译文件、contracts、Vben 静态页、Prisma schema/全部迁移、运行时进程限制工具、固定渲染脚本/字体许可/字体、workspace 包声明、依赖锁及 `ops/` 下的 Nginx/systemd 模板；不复制开发身份、环境文件、私人样本、测试输出或本机 `node_modules`。

示例核验顺序（在受限的新目录中执行）：

```sh
sha256sum -c timenook-release.tgz.sha256
mkdir extracted
tar -xzf timenook-release.tgz -C extracted
node extracted/scripts/release/package.mjs verify --root extracted --platform linux
```

清单验证必须在安装依赖前执行，拒绝缺失、改动和清单外文件；校验和须来自可信 CI artifact，文件 hash 不代替代码审查或来源验证。没有将 Mac 的原生二进制复制到 Linux。

## 目标环境仍需执行

Linux CI 使用锁文件安装依赖、生成 Prisma client 并执行真实 PostgreSQL/Redis API 测试；候选包不携带 `node_modules`。目标主机须核对 OS/架构/OpenSSL/Node/pnpm、可恢复数据库点和资源容量，在新 release 目录执行锁定安装与目标 Prisma 生成，再检验实际引擎、FFmpeg/FFprobe、Chromium、字体与权限。工作区包声明保留以解析锁文件；可使用 `pnpm install --frozen-lockfile --filter timenook --filter @timenook/api...` 安装 API 及根渲染依赖，之后 `pnpm db:generate`。目标环境结果不能由 CI 的 Ubuntu 构建代替。

构建产物仍保留既有业务准入门禁。普通商户支付参数读取及验签已接入，但身份留空、商品未准入时不启用付款。参与/录音/AI/书稿正式配置仍待装配，Worker 不会凭候选包自动启用。正式 D01–D10 与身份/支付/供应商路径具备后，由受控工程改动接入并逐项验收；不把 `NODE_ENV=test` 或合成 transport 用作生产配置。

发布切换、受审迁移、systemd API/Worker/渲染资源、管理静态页面、Nginx 前缀/回调/Cookie、legal-agent 回归、备份/删除台账恢复与 RTO/RPO 仍按 [T29](delivery/2026-10-22/tickets/29-release-recovery.md)执行。此工具仅把待发布文件和版本变成可审查的固定产物，不授权部署或售卖。
