# 独立发布准备证据

基线 `0269b3b834c8a69ee240099621d301ce81e68f1a`，关联 [T29 #30](https://github.com/brycezhang/timenook/issues/30)。本轮在 T24/T25/T27 实施期间仅完成不依赖其新业务契约的候选打包与人工输入整理；不放行 T29 的整体工程依赖或正式验收。

公开测试边界沿 T29 已约定的 release 产物验证：从独立临时 Git 源目录调用真实 Node CLI，实际创建并解压 tar，再核对 manifest/hash；不模拟文件系统、Git 或 tar。每个增量先真实失败再补实现：

| 行为 | RED | GREEN |
| --- | --- | --- |
| 固定 API/Worker/管理端/渲染/迁移和依赖清单，排除本地身份及环境文件 | `/tmp/timenook-release-red.log` | `/tmp/timenook-release-green-1.log` |
| 生成目录误放私人环境文件时拒绝 | `/tmp/timenook-release-red-private.log` | `/tmp/timenook-release-green-private.log` |
| 实际 tar/校验和、独立解压与篡改迁移拒绝 | `/tmp/timenook-release-red-archive.log` | `/tmp/timenook-release-green-archive.log` |
| 拒绝伪称另一个构建平台 | `/tmp/timenook-release-red-platform.log` | `/tmp/timenook-release-green-platform.log` |
| 核验拒绝清单外文件 | `/tmp/timenook-release-red-inventory.log` | `/tmp/timenook-release-green-inventory.log` |
| 未提交源码与不匹配 Node 拒绝 | `/tmp/timenook-release-red-node.log` | `/tmp/timenook-release-green-node.log` |

当前定向 6/6；源码固定后的实际仓库候选包、独立 Standards/Spec 审查及精确提交 CI 在 GitHub 交付记录补充。未接触云数据库、供应商、私人样本或真实资金。实际 Linux artifact、目标 ECS/Prisma/OpenSSL 与恢复验收分别记录，不用本机 Darwin 测试替代。

操作入口见[候选发布包](../../development-release.md)，缺失人工材料见[清单](manual-inputs.md)。T29/T30 与上游真实票保持 OPEN，原生依赖和未完成验收不改写。
