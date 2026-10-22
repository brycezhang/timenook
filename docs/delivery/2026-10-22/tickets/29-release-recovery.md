# T29 · 在共用 ECS 发布独立服务并完成恢复演练

GitHub：[#30](https://github.com/brycezhang/timenook/issues/30) · 状态以 GitHub 为准。
阶段：S4

## 交付结果

把全部业务链部署到 legal-agent 同一阿里云 ECS，复用 API 域名并以 `/timenook` 分流；TimeNook 应用及数据独立，运维可识别失败、回滚发布并恢复服务。

## 验收条件

- [ ] CI 生成锁定依赖的 release 包及迁移产物，验证目标 Linux/Prisma/OpenSSL；ECS/Nginx/systemd 分离 API、Worker 与渲染资源。
- [ ] 按 ADR 0009 核实共用主机、Nginx 生效配置、端口归属及容量；验证 `/timenook/` 剥离前缀转发、客户端/回调基址，并回归 legal-agent 既有路由和服务。运行用户、目录、环境文件及资源配额独立。
- [ ] 验证 RDS/Tair/OSS 权限、TLS、健康检查、Tair Lua/阻塞命令/续租/noeviction；密钥只在服务端独立配置。
- [ ] 演练发布回滚、数据库备份恢复且先重放删除台账、Redis 丢失重建、供应商失败及队列积压；记录 RTO/RPO 实测。
- [ ] 按 request/project/task/revision/book/fulfillment 标识串联脱敏日志，告警覆盖支付无权益、Outbox、任务费用、错版、访问与工单超时。

## 阻塞依赖

- [T17 · 生成可跳过的单条追问并处理迟到结果](17-optional-followup.md)
- [T26 · 执行资料删除及备份恢复防复活](26-deletion-ledger.md)
- [T28 · 闭环质量售后与原单重印](28-quality-care.md)

## 外部条件与完成边界

与 legal-agent 共用的 ECS/域名/TLS 入口、隔离的 RDS/Tair/OSS 配置与运维身份；生产部署前使用可审核发布包及目标环境授权。已核实的主机与路径目标见 [ADR 0009](../../../adr/0009-shared-ecs-api-path.md)，部署时重新验证；只读观察不代表部署验收。

关闭前记录提交/PR、执行命令及结果、对应证据。只有本地适配器通过时写明“模拟已通过，真实验收待完成”，保持本票未关闭。凭据通过受限的 Git 忽略环境文件或平台密钥管理提供，不附在 issue 或日志中。

## 验收映射

R13、X03、上线门槛。依据：[实施规格](../spec.md)及其中链接的已定稿 PRD/架构/ADR。
