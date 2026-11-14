# 渠道礼物与第三方后台实施

2026-11-14。已确认需求，待实施。[父规格 #180](https://github.com/brycezhang/timenook/issues/180) 与四张实施票已发布，均为 ready-for-agent，并已建立 GitHub 原生父子及 blocked-by 关系。范围以[规格](spec.md)及 [ADR 0021](../../../adr/0021-channel-gifts-and-partner-admin.md)为准。

## 拆分

| 票据 | 可操作结果 | 阻塞依赖 |
| --- | --- | --- |
| [CG01 · #181](https://github.com/brycezhang/timenook/issues/181) 超级管理员录单与买方查看 | 飞书管理员只填手机号录单，已有／首次注册用户在小程序看到长期有效的待送礼物 | 无 |
| [CG02 · #182](https://github.com/brycezhang/timenook/issues/182) 第三方账号与受限录单 | 超级管理员生成／撤销第三方账号，第三方用用户名密码登录、录单及查看本人记录，服务端限制访问范围 | CG01 |
| [CG03 · #183](https://github.com/brycezhang/timenook/issues/183) 礼物提醒与送礼开通 | 小程序合并提醒新增礼物，用户确认书名与关系后开通原故事书，送礼／自购及中断恢复可操作 | CG01 |
| [CG04 · #184](https://github.com/brycezhang/timenook/issues/184) 更正与错误作废 | 超级管理员处理全部记录、第三方处理本人记录，更正未建书记录的手机号或作废，买方可见状态同步，建书后的归属锁定 | CG02、CG03 |

每票覆盖其所需数据、接口、界面及定向验证。CG02 和 CG03 可在 CG01 所需契约具备后独立推进；CG04 使用已实现的第三方权限与建书路径验证修改边界。工程依赖以所需契约为准，供应商和真机待验分别记录。

## 交付记录

本轮更新需求文档并拆分 GitHub 票据。原画布页面增量、业务代码、部署及真实验收均由后续实施形成记录。
