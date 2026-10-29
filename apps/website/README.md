# 时光里营销官网

独立的 Vite + TypeScript 静态应用，位于 TimeNook pnpm Monorepo。需求见[营销官网需求](../../docs/frontend/marketing-requirements.md)，视觉清单见[设计依据](../../docs/frontend/website-design.md)。

## 开发与验证

在仓库根目录执行：

```bash
pnpm install --frozen-lockfile
pnpm dev:website
pnpm typecheck:website
pnpm build:website
pnpm test:website
```

开发默认访问 `http://127.0.0.1:4320`。端口冲突时可使用 `pnpm dev:website --port 4321`。官网独立运行，无需启动 API、数据库、Redis 或小程序预览。

浏览器测试针对构建后的站点，自动启动 4320 端口，在 320×760、390×664、1440×960 验证公开交互、资源、控制台及横向溢出。首次使用 Playwright 的环境需准备 Chromium；CI 已包含安装步骤。截图及测试输出位于 `/tmp/timenook-website-*`，不进入 Git。

## 内容与素材

- `index.html`：完整可索引的原生 HTML 内容与语义结构；当前预览明确设置 `noindex, nofollow`。
- `src/main.ts`：样书翻页、讲述/整理稿切换、下单提示与键盘操作。
- `src/style.css`：沿用小程序的纸面配色、宋体标题和橄榄绿按钮。
- `scripts/prepare-assets.mjs`：仅复制公开素材白名单到生成的 `public/`。原始 Logo 位于 `design/brand/`，人物和书籍图片沿用 `miniprogram/assets/`，故事沿用 `miniprogram/domain/model.ts` 中明确标注的演示内容。

当前下单入口展示小程序尚未开放的提示，不调用微信身份或付款。正式小程序直达套餐页、电脑扫码和真实购买由实际接入验收完成后再启用；官网不接受凭据或私人故事素材。

## 独立打包与发布

```bash
pnpm build:website
pnpm package:website /tmp/timenook-website-release
cd /tmp/timenook-website-release
shasum -a 256 -c website.tgz.sha256
```

输出目录必须不存在。输出为 `website.tgz`、SHA-256 校验文件和标记 `previewOnly: true` 的版本清单，压缩包只包含官网静态构建产物。Linux 可使用 `sha256sum -c website.tgz.sha256` 校验。

CI 为官网单独提供 `timenook-website-preview-<commit>` artifact。包可部署到 `sgl.wootoon.cn` 的独立静态发布目录，并用独立 `current` 软链接切换版本和回滚；无需替换 API/Admin 的发布包。具体生产切换沿用 [ADR 0015](../../docs/adr/0015-dedicated-domain-ingress.md) 和正式验收安排，本次未操作服务器。

对外推广前完成：正式小程序进入方案、真实套餐与购买验收，随后更新下单行为、取消预览的索引限制，并验证目标域名。构建成功或预览可访问不代替这些运行验收。

## 持续集成分流

仅修改本 README 等白名单内普通说明文档时，CI 执行文档链接与票据结构检查。官网代码、素材、依赖或构建配置变化仍执行整仓完整回归；官网检查与 API、管理端浏览器并行，候选产物只在完整汇总通过后发布。执行规则见[持续集成](../../docs/development.md#持续集成)，实际耗时与完整用例计数见[第一阶段验收](../../docs/delivery/2026-10-29/ci-phase1.md)。
