# 集成审查修复

2026-11-12，基线 `13eba8b`。本记录只说明新增修复和对应工程验证，原生逐画板结果继续见 MP12 的实际证据。

- 正式包依赖遍历补齐 WXML `import/include`，保留地址、制作确认和生产进度使用的 `templates/print-book.wxml` 及传递引用；继续移除未引用的旧实现。回归先复现 `ENOENT`，修复后 5 项正式包测试通过。
- 恢复故事详情的「添加照片／照片与说明」处理器，进入当前项目、采访和故事的照片编辑页。点击边界回归先复现处理器缺失，修复后故事页 31 项测试通过。
- `pnpm typecheck:frontend`、`pnpm build:miniprogram` 和 `node scripts/check-native.mjs --built` 通过；官方 wcc/wcsc 编译 37 个正式路由。

这些结果不替代 DevTools 点击、真机、供应商或实物验收；未推送、部署或上传。
