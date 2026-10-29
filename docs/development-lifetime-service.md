# 长期服务实施（#105）

[ADR0017](adr/0017-lifetime-service-and-retention.md) 记录用户已确定的方案；[#105](https://github.com/brycezhang/timenook/issues/105) 为网页内部验收的工程前提，不扩大到后台整体重构、网页收款或部署。

## 当前模型

D02 `service=lifetime`；D03回听、导出申请及原声/转录/故事与版本/照片和必要衍生文件/PDF/已完成ZIP及必要对应资料的retention规则均为lifetime。商业review、额度、首本数量、配送、D06人工时限、D07退款/质量窗口、供应商临时副本和主动删除执行时限仍分别校验。后台不再提供期限菜单、暂停/恢复、到期审核或相关权限，套餐和用户端不显示业务倒计时。

`ProjectServiceTerms.read` 返回 `policyStatus=lifetime`、creation/playback/exportRequests/retention及canRecord；业务expiresAt均null，超过2099也不拒绝。不存在用2099模拟永久的判断。已核验付款激活后无需等待参与事实起算，参与与交付事件只保留真实、幂等的事实。退款suspended/terminated限制仍执行；本人核验删除使对应资料为deleted。未支持的政策pending，不授予能力。

安全会话、邀请、OAuth state、上传/下载临时能力、协助会话、客服查看PDF/地址等授权仍有TTL；当前合法用户可以重新获取临时能力。长期业务资格不授予任何新权限，也不绕过本人版本确认和唯一首本权益。

## 清理边界

Deletions的API定时维护和Worker只重试实际撤回/删除，不按服务时间创建墓碑。CompleteExports首次ready保存expiresAt=null，下载、回执和替代交付重验当前授权和完整来源，不判断包年龄。cleanupTemporary只清理确定无有效ready/delivered引用或packing租约的ZIP，完成包持续保留；主动撤回/删除仍撤销流、阻止任务迟到写入并逐层清理。

开发阶段直接更新初始schema和合成夹具，移除仅为有限服务期的专用测试；没有兼容旧期限、升级旧库、恢复旧备份或回滚演练。未修改OSS生命周期、真实供应商或在线数据。实际部署时另行核实存储规则及原库资料，不能依据本地测试自动删除云端库。

## 本地证据

第一条RED为公开付款订单读取仍返回synthetic-fixed-policy/not_started，与lifetime/active断言冲突；实现后支付激活、事实并发幂等/重启读取及期限管理HTTP移除通过真实本地PG/Redis。

覆盖跨越2100年的制作、Range回听、资料维护/重启及PDF下载；已完成ZIP无业务截止、孤儿清理仍保留有效包。页面用expiresAt=null的包验证下载完整性和当前授权重验。相关删除/流/退款/质量/Worker回归、类型及构建结果在本票交付时记录，不把合成协议或本地结果视为真机、供应商、资金和线上验收。
