# T04 独立双轴审查

范围为 #5 的本地合成照片、固定 PDF 与受控纸面原声入口。真实 OSS、双端、印厂及实物验收尚未完成，D01 未冻结，票据保持打开。

初审基线 `221e9af67c6005e9e155cb2af411bf44aff83500`，固定提交 `79e481a4b0dcca87ddabe2ad0b609872beea4cd0`。命令：`git diff 221e9af67c6005e9e155cb2af411bf44aff83500...79e481a4b0dcca87ddabe2ad0b609872beea4cd0`。提交列表仅 `79e481a feat(probe): verify photo PDF and controlled paper audio entry (#5)`，29 个文件。

规范来源包括 AGENTS、CONTEXT、GLOSSARY、docs/agents 下的流程约定、工程对齐、技术架构/接口、本地开发及探针说明，以及版本、授权和共用路径 ADR。仓库未找到 CODING_STANDARDS 或 CONTRIBUTING。两名独立审查者分别完成 Standards 与 Spec，后者另行读取 live #5 和引用的规格/PRD。

## Standards

初审 **0 项硬规范违约，0 项需报告的判断性异味**。已逐项核对 12 种 Fowler smell；仓库规范优先，异味仅作为判断，未报告工具已强制的检查。

S0 与正式业务边界清楚，入口沿用独立身份及存储范围检查，唯一约束与锁有真实 PostgreSQL 测试。候选参数、运行证据与外部待验收项分别记录。仅只读审查，没有重复全量测试。

## Spec

初审 **1 项，最高 P2**；属于已实现但行为错误。未发现其他已确认缺失或范围扩张。

- 透明 PNG 的预览与实际 PDF 底色不一致。`photo-worker.mjs` 第 86–95 行直接生成 JPEG，使透明区域变黑；印刷 PNG 保留 alpha，在白底 PDF 中呈白。独立审查者使用合成 RGBA 样本走公开 CLI→PDF→PNG，预览同区域 RGB 为 `[0,0,0]`，PDF 为 `[255,255,255]`，两步均成功。违反 PRD 第 267 行“印刷清晰度由预览与运营检查”，会误导校对。要求统一衍生图候选底色，保留原图，增加实际 PDF 像素回归。

复现只用系统临时目录，已清理；外部供应商、设备和实物限制不计为本轮宣称已实现的代码缺陷。

## 修复与复审

修复提交 `fccc1dc92c25beed6c26677375c3562abcf66075`；增量命令 `git diff 79e481a4b0dcca87ddabe2ad0b609872beea4cd0...fccc1dc92c25beed6c26677375c3562abcf66075`。

- Standards 复审：预览与印刷衍生图在共享 `pixelSource` 统一合成到候选白底，原图保持不变；独立颜色期望、实际 PDF 像素与文档边界一致。新增 0，剩余 0，无最高严重项。
- Spec 复审：独立运行透明/半透明回归 1/1 通过，验证原图字节、预览/印刷独立 RGB 期望和实际 PDF 像素。原 P2 关闭，新增 0，剩余 0，无最高严重项。

实现者在修复后运行一次最终 `pnpm check`：141/141（frontend 49 / API 79 / print 13），类型与构建通过。主 Agent 核对原始 `23-pnpm-check-alpha.log` 与清理读回，并查看补充 PDF 的全部 3 页，未见缺字、裁切、重叠，白/粉/蓝色块正常。未改变迁移、依赖或 HTTP 合同，先前 OpenAPI 与管理端浏览器 2/2 仍适用。远端最终提交的 CI 门禁以 [PR #38](https://github.com/brycezhang/timenook/pull/38) 为准。

最终汇总：Standards 剩余 0，最高严重度无；Spec 剩余 0，最高严重度无。审查通过不能替代真实云端、设备、印厂与实物验收。
