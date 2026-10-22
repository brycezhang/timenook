---
status: accepted
date: 2026-10-20
---

# 使用NestJS模块化单体，独立运行耗时任务

身份授权、订单权益、个人计划、故事确认、书稿及生产使用同一业务代码库和阿里云RDS PostgreSQL。API、业务Worker与PDF渲染分进程部署，采用NestJS/Fastify、Prisma、BullMQ/ioredis；发布组织见[ADR 0007](0007-aliyun-and-wutong-stack.md)。

两角色与首本实体书的范围适合集中业务规则，支付激活、版本确认、撤回与投产使用同库事务。模块拥有各自写规则，管理端通过相同用例操作；数据库任务与Outbox支持调度恢复，消费者实现幂等，队列仅负责调度。

文件转写、追问和整理异步执行，PDF独立限制资源。出现明确的故障隔离或资源瓶颈时，先扩展相应进程，再按实测证据评估拆分。

详见[技术架构](../architecture/技术架构.md)、[流程与接口](../architecture/流程与接口.md)。
