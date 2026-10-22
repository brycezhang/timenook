# T01 双轴审查

日期：2026-10-22。固定基线：e0abe7b；首次实现：171492c；修复见本 PR 后续提交。范围为 T01，不以其余 29 张票据的业务功能作为本票缺漏。

## Standards

依据根 AGENTS、CONTEXT、domain/issue-tracker 约定、技术架构及流程接口文档，独立审查发现一项 P2：非法 URL 在 Fastify 路由解析阶段绕过 Nest 错误过滤器，缺少统一错误和 requestId。

已通过 frameworkErrors 与共享 errorResponse 修复。复核使用 Node 22.23.4，确认非法 URL 返回统一 400、服务端 requestId 与响应头一致，无输入回显。修复范围内无新增发现。

## Spec

对照 Issue #2、T01 票据及实施规格，独立审查发现同一非法 URL 问题，并发现超大 JSON 的 HTTP 413 被误标为 INTERNAL_ERROR。

已增加 PAYLOAD_TOO_LARGE 映射和两项 HTTP 回归，先确认失败再实现修复。复核对 /%FF、/%ZZ 使用真实 socket，确认 400、脱敏与 requestId；超大 JSON 注入确认 413 语义。两项发现均闭合，修复范围内无新增发现。

## 验证边界

本地完整检查为 23 项既有前端行为测试加 14 项 API/启动测试；Mac 原生编译已通过。GitHub Linux CI 单独在 PR 显示，不能用本地结果替代。直接 Fastify 类型依赖已对齐 Nest 实际运行的 5.11.3，消除重复版本，未改变运行时版本。
