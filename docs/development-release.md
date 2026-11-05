# 候选发布包

本工具生成可核对的发布产物。独立小程序真实身份及普通商户已接入受控线上；2026-11-02 已发布固定标价999元、仅授权名单实付1分的E2E版本，实际到账仍待开发者本人扫码。普通公开售卖条款随后补齐。当前结果见[固定套餐运行记录](delivery/2026-11-02/fixed-package-runtime.md)，其余正式条件见 [T29 记录](delivery/2026-10-28/t29-release.md)。

## 生成与核验

沿用锁定 Node/pnpm，先完成构建、字体准备与相关检查。源码必须已提交且已跟踪文件无修改；输出必须是源码目录外的新目录。Linux CI 的 build job 在自身类型检查、构建、OpenAPI 与打包核验通过后上传候选 Actions artifact，保留 7 天；完整 PR 所选检查仍按工程约定用于合并。这是构建产物期限，与用户资料 D03 无关。

```sh
pnpm release:candidate --platform linux --output /absolute/new/timenook-release
node scripts/release/package.mjs verify --root /absolute/new/timenook-release --platform linux
```

Mac 可省略 `--platform linux` 生成仅供检查的本机候选；清单如实记录 Darwin/arm64，不能称为 Linux 构建。指定平台与实际构建主机不同会失败；Node 与 `.node-version` 不符也失败。CLI 不加载 `.env`，不读取云端配置或访问供应商。

产物为候选目录、同级 `.tgz` 和 `.tgz.sha256`。`release-manifest.json` 记录源码提交、Node/pnpm 固定版本、构建平台/架构/Node OpenSSL，以及每个文件的相对路径、字节数和 SHA256。目录包含 API/Worker 编译文件、contracts、Vben 和产品网页静态页、Prisma schema/全部迁移、运行时进程限制工具、固定渲染脚本/字体许可/字体、workspace 包声明、依赖锁及 `ops/` 下的 Nginx/systemd 模板；不复制开发身份、环境文件、私人样本、测试输出或本机 `node_modules`。产品网页使用候选内的 `apps/web/dist`，部署为网页发布目录的 `app/` 子目录，以同步用户端的生产进度等共享变更。

示例核验顺序（在受限的新目录中执行）：

```sh
sha256sum -c timenook-release.tgz.sha256
mkdir extracted
tar -xzf timenook-release.tgz -C extracted
node extracted/scripts/release/package.mjs verify --root extracted --platform linux
```

清单验证必须在安装依赖前执行，拒绝缺失、改动和清单外文件；校验和须来自可信 CI artifact，文件 hash 不代替代码审查或来源验证。没有将 Mac 的原生二进制复制到 Linux。

## 目标环境仍需执行

Linux CI 使用锁文件安装依赖、生成 Prisma client 并执行真实 PostgreSQL/Redis API 测试；候选包不携带 `node_modules`。目标主机须核对 OS/架构/OpenSSL/Node/pnpm、当前数据库结构、配置及资源容量，在新 release 目录执行锁定安装与目标 Prisma 生成，再检验实际引擎、FFmpeg/FFprobe、Chromium、字体与权限。工作区包声明保留以解析锁文件；可使用 `pnpm install --frozen-lockfile --filter timenook --filter @timenook/api...` 安装 API 及根渲染依赖，之后 `pnpm db:generate`。目标环境结果不能由 CI 的 Ubuntu 构建代替。

同一目标机、相同锁文件和 Node 的已有 Linux 依赖，也可复制为新 release 的独立副本后重新生成 Prisma Client，实际加载 `fs-ext` 并验证服务；生成过程使用独立副本。解压可能将 release 根目录恢复成归档中的 `700`，须在启动前检查并设为服务用户及 Nginx 可遍历的目录权限（本轮为 `755`）。配置和商户文件继续保留各自受限权限。

构建产物保留业务准入门禁。普通商户、参与、录音、AI 与候选书稿已由既有受控配置装配；本轮 E2E 商品另外要求显式开关与用户名单。普通正式版本继续要求完整真实商业材料。Worker 的能力由实际运行配置决定，候选包和配置均须逐项运行验收；不把 `NODE_ENV=test` 或合成 transport 用作生产配置。

发布切换、受审迁移、systemd API/Worker/渲染资源、管理静态页面、Nginx 前缀/回调/Cookie、legal-agent 回归、当前模型重启、主动删除及实际配置仍按 [T29](delivery/2026-10-22/tickets/29-release-recovery.md)执行。此工具仅把待发布文件和版本变成可审查的固定产物，不授权部署或售卖。
