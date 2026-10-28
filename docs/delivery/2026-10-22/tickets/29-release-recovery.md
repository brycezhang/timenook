# T29 · 在共用 ECS 发布独立服务并完成恢复演练

GitHub：[#30](https://github.com/brycezhang/timenook/issues/30) · 状态以 GitHub 为准。
阶段：S4

## 交付结果

把全部业务链部署到 legal-agent 同一阿里云 ECS，使用独立 API 域名 `https://timenookapi.threeminreading.com/api/v1`；TimeNook 应用及数据独立，运维可识别失败、回滚发布并恢复服务。开发阶段直接按当前配置实现和验证，无旧入口或开发版本的兼容与迁移要求。

## 验收条件

- [ ] CI 生成锁定依赖的 release 包及迁移产物，验证目标 Linux/Prisma/OpenSSL；ECS/Nginx/systemd 分离 API、Worker 与渲染资源。
- [ ] 按 ADR 0009/0015 核实共用主机、Nginx 生效配置、端口归属及容量；验证独立域名下 `/api/` 剥离前缀转发、客户端/回调基址，并回归 legal-agent 服务。运行用户、目录、环境文件及资源配额独立。
- [ ] 验证 RDS/Tair/OSS 权限、TLS、健康检查、Tair Lua/阻塞命令/续租/noeviction；密钥只在服务端独立配置。
- [ ] 演练发布回滚、数据库备份恢复且先重放删除台账、Redis 丢失重建、供应商失败及队列积压；记录 RTO/RPO 实测。
- [ ] 按 request/project/task/revision/book/fulfillment 标识串联脱敏日志，告警覆盖支付无权益、Outbox、任务费用、错版、访问与工单超时。
- [ ] 集中承接 T06/T07 的正式域名及管理部署验证：实际管理员受控建号/MFA、密钥保管与恢复、生产 PostgreSQL/Redis 重启；独立域名下用户 `/api/v1`、运营与 Cookie Path `/api/v1/admin`、管理页面 `/admin/`、支付/退款 `/api/v1/webhooks/wechat-pay/...` 与健康路径 `/api/health/...` 正确，API 前缀只剥离一次。检查静态资源、客户端/通知/OpenAPI 基址及同机 legal-agent 服务。
- [ ] 验证 T10/T26 服务期限调度在暂停、重启、积压与恢复后补扫，重复事件不延长权益或重复执行清理；正式参数和时钟有依据，资料副本清理结果逐层留证。

## 实现边界

沿用现有 ECS/Nginx/systemd 和单体进程角色；集中验正式环境、共用路由与恢复。引用 T15/T26 机制证据，仅补目标环境增量，不建设部署平台或重复业务故障矩阵。

## 测试决策

- 覆盖模块：部署、调度、IdentityAccess 正式管理、恢复。
- 主入口：真实进程/公网路由/云资源及隔离恢复演练。通用约定见[父规格测试决策](../spec.md#测试决策)。
- 现有范例：[health.test.ts](../../../../apps/api/test/health.test.ts)、[startup.test.ts](../../../../apps/api/test/startup.test.ts)、[access.spec.mjs](../../../../tests/admin/access.spec.mjs)；仅作测试方式参考。

## 阻塞依赖

- [T17 · 生成可跳过的单条追问并处理迟到结果](17-optional-followup.md)
- [T26 · 执行资料删除及备份恢复防复活](26-deletion-ledger.md)
- [T28 · 闭环质量售后与原单重印](28-quality-care.md)

## 工程前提与外部条件

工程前提：T17/T26/T28 及传递上游的工程成果全部合并并验证；前序票的正式环境检查在本票集中完成，不要求其先等待本票关闭。

与 legal-agent 共用 ECS，TimeNook 使用独立域名及 TLS 入口，业务库、队列、Bucket 和运维身份按既定方案隔离；生产部署前使用可审核发布包及目标环境授权。主机与路径目标见 [ADR 0009](../../../adr/0009-shared-ecs-api-path.md) 和 [ADR 0015](../../../adr/0015-dedicated-domain-ingress.md)，部署时重新验证；只读观察不代表部署验收。

执行[完成规则](../spec.md#依赖完成规则)与[证据复用](../spec.md#验收复用与唯一归属)；本票勾选与真实状态保持原有证据口径。

## 验收映射

R13、X03、上线门槛。依据：[实施规格](../spec.md)及其中链接的已定稿 PRD/架构/ADR。
