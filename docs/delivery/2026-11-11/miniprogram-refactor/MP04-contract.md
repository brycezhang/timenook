# MP04 礼物分类与成员关系契约

当前 API 与 Web／Admin 消费者已实现，原生页面、开发者工具与真机结果另记。

- `GET /participations` 的 `projects` 每项目一条，使用共享 `ProjectMembership`：`categories` 为 `sent`、`received`、`participating` 集合；自购同一条同时含送出和收到。分类只看创建者、订单 `purchaseKind`、指定礼物领取事实和普通邀请事实，不由文字关系推断。
- 列表含 `giverNickname`、购买时冻结的 `giftRelationship`、`isSelfGift`、当前真实 `storyCount`。订单待付款仍由 `/orders` 返回，在送出入口恢复。
- `POST /invitations/:token/accept` 必填 `{ termsVersion, relationship }`。关系是主讲人视角的称呼，去首尾空白、1–32 字，支持自定义。邀请权限仍仅购买者；重复接受不会增加成员或改变项目授权版本。
- `GET /projects/:id/member-profile` 返回 `ProjectMemberProfile`：`projectId,userId,nickname,relationship,isNarrator`。主讲人由 `ProjectSubject.boundUserId` 判断，返回「本人」；其他成员读 `ProjectMember.relationship`。购买者尚未建立成员行时返回 `null`，不影响项目权限。
- `POST /projects/:id/member-profile` 接 `{ relationship }`，为当前成员保存关系；购买者可在首次家人提问时补填。主讲人关系固定为「本人」。不从赠礼关系反推关系，不需要额外确认或授权版本。
- 关系字段已纳入现有 activeData 删除登记及数据库触发器。Web 接受邀请必填关系；后台关联项目同时查询购买、成员、领取与既有服务历史。

已用真实本地 PostgreSQL／Redis 通过邀请关系、角色与后台查询、领取分类、自购同一项目双分类、多人编辑归章／PDF／制作、统一网页账号等定向测试；微信、支付供应商使用既有边界夹具。自述未归章后通过真实 `/plan` 写入章节再继续成书。未部署、上传或进行真实分享。
