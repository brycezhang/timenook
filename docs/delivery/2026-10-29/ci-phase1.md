# CI 第一阶段：实现与实际运行验收

日期：2026-10-29。对应 [#73](https://github.com/brycezhang/timenook/issues/73)，实现 [PR #74](https://github.com/brycezhang/timenook/pull/74)。

## 实现范围

说明文档白名单补齐普通 apps/*/README.md，其余保守完整检查。API 四个独立 runner、管理端浏览器两个独立 runner，与 build/官网并行。最终 check 名称、PR最终提交+独立双轴审查、main全绿后下一票的门槛保持。无模块影响选测、CD迁移或生产部署。

全部导出用例拆分为四文件，原28个注册/循环块、17个helper的归一AST一致，动态展开35条名称无遗漏重复；实际完整计数由Actions报告确认。每片仍使用真实PostgreSQL/Redis、原业务fixture、独立目录/命名空间；Chromium、固定FFmpeg、字体、历史恢复所需Git历史和候选OpenAPI保留。

## 独立审查

固定候选：50e7b25c64c5d9a874b66d07c4d09e68c8ac0ac9；基线：86017a3f09c1b62fbd4a92a907e4d405e57dff9a。

### Standards

通过，0项发现。浏览器使用官方发现及独立复核；Node匹配非普通文件明确失败；准备依赖与完整历史已补齐。35条CI自测、actionlint通过。

### Spec

通过，0项未解决发现。原两项（失败时上传路径回退、浏览器发现范围收窄）已修复；原验证范围、真实依赖、完整导出断言、候选OpenAPI及门槛保持。

## 实际 Actions

| 运行                                                                                     | 端到端耗时 | 最长并行任务      | 累计 job 时间 | 结果 |
| ---------------------------------------------------------------------------------------- | ---------- | ----------------- | ------------- | ---- |
| 原 main [40707495160](https://github.com/brycezhang/timenook/actions/runs/40707495160)   | 43分16秒   | full 41分20秒     | 42分09秒      | 成功 |
| 最终 PR [40807342123](https://github.com/brycezhang/timenook/actions/runs/40807342123)   | 10分44秒   | API第3片 8分22秒  | 48分51秒      | 成功 |
| 合并 main [40808534825](https://github.com/brycezhang/timenook/actions/runs/40808534825) | 11分36秒   | API第3片 10分01秒 | 48分16秒      | 成功 |

PR分支固定头为50e7b25，Actions实际测试的合成merge SHA为5a1e6a1d491e9fe33959081dd3e6a7bbf7e81f19。PR端到端含约1分钟等待旧候选退出；main合并提交为5ff5e81dd7e542325d5e55d49b1601920c2ede41。端到端按workflow created_at到最后job completed_at计算，累计job时间排除skipped并按各job started_at/completed_at相加。

PR与main两次报告均确认：API 570（四片），frontend 364，print 19，release 6，admin浏览器55（两片），官网15（三种视口）；既有验证用例共1029，全部passed、无skip/todo。另35条CI工具回归分别在changes/build执行。full独立校验和最终check均成功，原名称的候选与官网artifact已生成。

与基线相比，PR等待减少75.2%，约4.0倍提速；累计job运行时间增加约15.9%。main等待减少73.2%，约3.7倍提速；累计job运行时间增加约14.5%。这是完整回归并行后的等待/资源交换。

## 调试记录与边界

首次候选40806628155暴露独立runner缺少PDF测试所需Chromium；修复过程中同时补全完整历史和独立discovery编译依赖。失败候选已取消，不计为验证通过或性能收益。879c302候选被后续50e7b25替换，其运行不作为最终交付证据。

耗时报告只保存白名单元数据，不保存错误正文/请求/页面/附件；阶段失败也保留已有报告。full会重新调用官方发现并核对预期/实际case ID、文件并集、各阶段状态和SHA；缺失、取消、失败、跳过、空集合阻断，最终候选artifact另显式校验SHA256。

单次/少量运行不代表p50/p95或稳定性统计；累计job运行时间不等于账单，实际计费还受平台规则影响。后续继续观察长尾和runner用量。

## README 轻量分流验收

本次验收提交只改本记录、CONTEXT.md 的证据链接和 apps/website/README.md 的 CI 说明；旧白名单会因模块 README 触发 full，新白名单应仅执行 changes/docs/check。普通说明文档的轻量分流不改变代码、素材、依赖和工作流变动的完整回归范围。实际文档 PR/main 运行链接及结果追加在 [#73](https://github.com/brycezhang/timenook/issues/73)，避免为记录本次运行而反复产生新提交。
