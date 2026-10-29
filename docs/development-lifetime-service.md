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

2026-10-29 本地补证：已合并 W01 主干（3f5b026），web-account 14条、前端362条及现有浏览器9条通过；完整typecheck/build（含网页工作区）与25页原生wcc/wcsc通过。跨2100聚焦8条及质量D07窗口/客服临时授权续签2条通过。浏览器使用项目现有Playwright流程（本会话未列Browser技能），在1280×720与390×844核对期限入口移除、恢复同一付款项目、ZIP领取和主动删除；合成身份与网络边界，真实PG/Redis/API/页面和文件产物。最终完整CI与独立Standards/Spec审查由父票统一执行，实际OSS生命周期和线上运行尚无变更证据。

#105 Spec P1修复：替代交付客服访问改为独立、可续签的短期安全grant，首次按原本人核验起算最多30分钟，后台新核验选择15分钟；登录、工单完成和旧授权重放都不续期。新的受控本人核验必须绑定告知版本/用途/接收范围/指定身份与确认渠道/证据和当前主体、绑定、epoch及撤回序号。领取及活动流固定同一grant并检查安全截止，用户ZIP仍expiresAt=null。8天公开HTTP复现已由200转403；新核验后同hash仍可领取，见[完整导出说明](development-complete-export.md#客服替代交付的独立安全授权)。
