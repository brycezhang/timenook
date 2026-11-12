# 画板与原生页面对照验收表

状态：已覆盖当前原画布全部 71 张画板。MP01 的 6 张画板已完成 390／320 原生对照，见 [MP01 证据](MP01-evidence.md)；其他画板按实际进度补验，逐行结果与截图链接保存在 [design-map.json](design-map.json)。真实手机号成功授权和真机结果另列待验。

## 验收方式

每行对应一个设计状态，可以由同一原生路由承载多个状态。下表中的原生目标为实施定位，开发后更新为实际路由/组件；角色、状态和进入路径必须保留。自动核对数据见 [design-map.json](design-map.json)，完整原画布见 [canvas.json](../../../../designs/timenook-modern-2026-11-10/project/canvas.json)。

每行补齐：设计参考截图与版本、原生 390px/320px 截图、实际点击步骤与结果、接口/数据前提、缺陷及修复后结论。状态只允许待验证、发现问题、已通过、外部待验；原生功能缺失不得标为外部待验。

画布外层标题包含角色，不把“项目成员／收礼人”等角色说明塞进产品导航。仅系统授权/收银台/PDF 查看器外壳按平台实际控件记录；应用可控 UI 和 PDF 内容仍须对齐设计。保留结构化加载骨架、局部反馈、无语音／无内容、失权等实际必要状态，不因没有独立画板而伪造成功。

原生验收使用构建后的 `dist/miniprogram/` 和真实页面栈，Tab 通过原生切换进入。UI 夹具可以稳定复现视觉，但须另有真实后端业务链路证据；不能仅 setData 或浏览器模拟截图即通过。

## 逐项对应

| 画板（原角色标题） | 责任票 | 原生目标／状态 | 进入路径 | 必须实操 |
| --- | --- | --- | --- | --- |
| [Main · 01 所有人｜首页](../../../../designs/timenook-modern-2026-11-10/project/Main.dc.html) | MP01 | home：未登录公开首页 | 启动小程序／退出登录 | 样书、送礼、我的入口 |
| [Sample · 02 所有人｜样书预览](../../../../designs/timenook-modern-2026-11-10/project/Sample.dc.html) | MP01 | sample（新增）：公共样书 | 首页→看看样书 | 节选阅读、返回与购买入口 |
| [Login · 03 未登录用户｜登录弹窗](../../../../designs/timenook-modern-2026-11-10/project/Login.dc.html) | MP01 | quick-login 共用组件：登录与未勾选确认弹窗 | 首页／我的／受保护操作→登录 | 关闭、协议返回、继续授权与成功恢复 |
| [MyGuest · 01 未登录用户｜我的 · 未登录](../../../../designs/timenook-modern-2026-11-10/project/MyGuest.dc.html) | MP01 | account：未登录 | 底部我的 | 原地登录、送礼、条款 |
| [MyAccount · 02 已登录用户｜我的 · 已登录](../../../../designs/timenook-modern-2026-11-10/project/MyAccount.dc.html) | MP01 | account：已登录 | 底部我的 | 昵称弹窗、礼物、送礼、退出 |
| [Terms · 03 所有人｜使用条款与隐私说明](../../../../designs/timenook-modern-2026-11-10/project/Terms.dc.html) | MP01 | terms：现行条款 | 登录弹窗／我的→使用条款 | 滚动、返回原弹窗 |
| [NewGift · 04 购买者｜购买礼物 · 选择关系](../../../../designs/timenook-modern-2026-11-10/project/NewGift.dc.html) | MP02 | new-book：给他人 | 统一送礼入口 | 关系必选、自定义、书名及继续 |
| [SelfGift · 05 购买者｜购买礼物 · 送给自己](../../../../designs/timenook-modern-2026-11-10/project/SelfGift.dc.html) | MP02 | new-book：送给自己 | 关系→自己 | 身份含义、确认书名与继续 |
| [Checkout · 06 购买者｜确认购买](../../../../designs/timenook-modern-2026-11-10/project/Checkout.dc.html) | MP02 | purchase：确认购买 | 填写关系和书名→继续 | 套餐事实、付款、重复操作 |
| [PaymentPending · 07 购买者｜待付款](../../../../designs/timenook-modern-2026-11-10/project/PaymentPending.dc.html) | MP02 | order：待付款 | 支付取消／送出类待付款 | 恢复原单、返回 |
| [PaymentUnknown · 08 购买者｜确认付款结果](../../../../designs/timenook-modern-2026-11-10/project/PaymentUnknown.dc.html) | MP02 | order：付款结果未知 | 支付后状态待确认 | 查询原单与正确结果去向 |
| [GiftReady · 01 送礼人｜购买成功](../../../../designs/timenook-modern-2026-11-10/project/GiftReady.dc.html) | MP02 | gift-setup（新增）：给他人购买成功 | 服务端确认他人订单已付 | 指定收礼人、进入原书 |
| [GiftRecipient · 02 送礼人｜指定收礼人](../../../../designs/timenook-modern-2026-11-10/project/GiftRecipient.dc.html) | MP03 | gift-setup（新增）：设置／修改收礼号码 | 购买成功／礼物卡→设置 | 号码输入校验、保存与重发 |
| [GiftShare · 03 送礼人｜发送礼物卡](../../../../designs/timenook-modern-2026-11-10/project/GiftShare.dc.html) | MP03 | gift-share（新增）：当前有效礼物卡 | 号码保存成功 | 分享、更正号码、进入书 |
| [GiftOpen · 01 收礼人｜查看礼物](../../../../designs/timenook-modern-2026-11-10/project/GiftOpen.dc.html) | MP03 | gift-claim（新增）：打开卡片 | 微信分享卡片 | 礼物事实、验证入口 |
| [GiftVerify · 02 收礼人｜验证收礼手机号](../../../../designs/timenook-modern-2026-11-10/project/GiftVerify.dc.html) | MP03 | gift-claim＋quick-login：未验证收礼号码 | 礼物卡→验证 | 原地授权、返回和匹配结果 |
| [GiftMismatch · 03 收礼人｜手机号不匹配](../../../../designs/timenook-modern-2026-11-10/project/GiftMismatch.dc.html) | MP03 | gift-claim（新增）：已验证号码不匹配 | 错误账号验证 | 禁止领取、切换账号 |
| [GiftAccept · 04 收礼人｜确认领取礼物](../../../../designs/timenook-modern-2026-11-10/project/GiftAccept.dc.html) | MP03 | gift-claim（新增）：匹配待明确接受 | 正确账号完成验证 | 明确领取、返回不领取 |
| [GiftInvalid · 05 收礼人｜礼物卡已失效](../../../../designs/timenook-modern-2026-11-10/project/GiftInvalid.dc.html) | MP03 | gift-claim（新增）：旧卡失效 | 打开重发前卡片 | 禁止领取、返回 |
| [GiftClaimed · 06 收礼人｜礼物已领取](../../../../designs/timenook-modern-2026-11-10/project/GiftClaimed.dc.html) | MP03 | gift-claim（新增）：已领取 | 明确领取／原账号重开 | 进入原书、不能重领 |
| [MyProjects · 03 已登录用户｜我的礼物 · 送出](../../../../designs/timenook-modern-2026-11-10/project/MyProjects.dc.html) | MP04 | projects：我送出的 | 我的→我的礼物 | 卡片打开、待付恢复、自购标识 |
| [MyGiftsReceived · 08 已登录用户｜我的礼物 · 收到](../../../../designs/timenook-modern-2026-11-10/project/MyGiftsReceived.dc.html) | MP04 | projects：我收到的 | 我的礼物→收到 | 指定领取、自购同项目 |
| [MyGiftsParticipating · 09 已登录用户｜我的礼物 · 参与](../../../../designs/timenook-modern-2026-11-10/project/MyGiftsParticipating.dc.html) | MP04 | projects：我参与的 | 我的礼物→参与 | 普通邀请分类、进入原书 |
| [SwitchProject · 04 项目成员｜切换故事书](../../../../designs/timenook-modern-2026-11-10/project/SwitchProject.dc.html) | MP04 | projects／切换容器：切换故事书 | 故事书首页→切换 | 三分类、选择与返回当前书 |
| [InviteShare · 05 购买者｜邀请家人](../../../../designs/timenook-modern-2026-11-10/project/InviteShare.dc.html) | MP04 | invite：购买者邀请 | 购买者邀请家人入口 | 分享、权限与返回 |
| [InviteJoin · 06 受邀家人｜加入项目](../../../../designs/timenook-modern-2026-11-10/project/InviteJoin.dc.html) | MP04 | welcome：待接受家人邀请 | 微信普通邀请 | 登录恢复、关系必填、自定义及加入 |
| [BookDirectory · 01 项目成员｜大纲目录 · 六章](../../../../designs/timenook-modern-2026-11-10/project/BookDirectory.dc.html) | MP05 | directory（统一入口）：六章目录 | 首页／书稿→大纲目录 | 章节拖动、新增、进入章 |
| [ChapterOutline · 02 项目成员｜章节内容 · 问题与故事](../../../../designs/timenook-modern-2026-11-10/project/ChapterOutline.dc.html) | MP05 | chapter-outline（新增）：章内问题／故事 | 大纲目录→某章 | 页签、题目状态、故事排序入口 |
| [QuestionDetail · 03 主讲人及协助家人｜大纲问题 · 语音回答](../../../../designs/timenook-modern-2026-11-10/project/QuestionDetail.dc.html) | MP05 | question（新增）：大纲问题待回答 | 章节问题列表→题目 | 回答、稍后、跳过、编辑 |
| [QuestionEdit · 04 项目成员｜编辑大纲问题](../../../../designs/timenook-modern-2026-11-10/project/QuestionEdit.dc.html) | MP05 | question-edit（新增）：新增／编辑大纲题 | 章内新增／题目编辑 | 文字和章节保存、取消 |
| [ChapterEdit · 05 项目成员｜编辑章节](../../../../designs/timenook-modern-2026-11-10/project/ChapterEdit.dc.html) | MP05 | chapter：编辑章名和正文 | 目录／章内→编辑章节 | 保存、取消、删除保留故事 |
| [ChapterStories · 06 项目成员｜本章故事](../../../../designs/timenook-modern-2026-11-10/project/ChapterStories.dc.html) | MP05 | chapter-stories：本章故事 | 章节→本章故事 | 选取、章内拖动、移出、跨章 |
| [HomeEmpty · 01 项目成员｜故事书首页 · 暂无故事](../../../../designs/timenook-modern-2026-11-10/project/HomeEmpty.dc.html) | MP06 | home：有书暂无故事 | 自购成功／领取后进入／切换空书 | 卡片入口、零数量、推荐与开讲 |
| [HomeActive · 02 项目成员｜故事书首页 · 已有故事](../../../../designs/timenook-modern-2026-11-10/project/HomeActive.dc.html) | MP06 | home：已有故事 | 登录已有项目／切换书 | 真实统计、推荐、滚动、整卡入口 |
| [FamilyQuestions · 01 项目成员｜家人提问 · 待回答](../../../../designs/timenook-modern-2026-11-10/project/FamilyQuestions.dc.html) | MP06 | family-questions（新增）：家人题列表 | 首页→家人提问 | 状态筛选、文字提问、问题详情 |
| [FamilyQuestionsEmpty · 02 项目成员｜家人提问 · 暂无问题](../../../../designs/timenook-modern-2026-11-10/project/FamilyQuestionsEmpty.dc.html) | MP06 | family-questions（新增）：暂无家人题 | 空书→家人提问 | 空态与提问入口 |
| [FamilyQuestionNew · 03 项目成员｜提出问题 · 仅文字](../../../../designs/timenook-modern-2026-11-10/project/FamilyQuestionNew.dc.html) | MP06 | family-question-edit（新增）：文字提问 | 家人列表／某章→提问 | 关系补填、可选章、发布和取消 |
| [FamilyQuestionDetail · 04 主讲人及协助家人｜家人问题 · 待回答](../../../../designs/timenook-modern-2026-11-10/project/FamilyQuestionDetail.dc.html) | MP06 | family-question（新增）：待回答／稍后／跳过 | 首页／列表→家人题 | 作者来源、回答、稍后、跳过及恢复 |
| [FamilyQuestionAnswered · 05 项目成员｜家人问题 · 已回答](../../../../designs/timenook-modern-2026-11-10/project/FamilyQuestionAnswered.dc.html) | MP06 | family-question（新增）：已回答 | 已回答列表→问题 | 原作者、关联故事整卡入口 |
| [Photos · 08 项目成员｜项目照片](../../../../designs/timenook-modern-2026-11-10/project/Photos.dc.html) | MP07 | photos：项目照片空态／有照片 | 首页照片数／讲述选图 | 上传、预览、选择、照片起讲 |
| [Stories · 01 项目成员｜故事列表](../../../../designs/timenook-modern-2026-11-10/project/Stories.dc.html) | MP08 | stories：故事列表 | 首页故事数 | 空态、处理中、打开故事 |
| [Story · 02 项目成员｜故事详情](../../../../designs/timenook-modern-2026-11-10/project/Story.dc.html) | MP08 | story：已归章故事 | 列表／回答完成 | 原声进度、照片、文字编辑、补录、归章 |
| [StoryEdit · 03 项目成员｜编辑故事](../../../../designs/timenook-modern-2026-11-10/project/StoryEdit.dc.html) | MP08 | edit-story：文字编辑 | 故事→编辑 | 保存、取消、键盘可操作 |
| [StoryProcessing · 04 项目成员｜整理故事](../../../../designs/timenook-modern-2026-11-10/project/StoryProcessing.dc.html) | MP08 | story：整理中 | 保存录音后 | 状态更新、离开与返回 |
| [StoryFailed · 05 项目成员｜故事整理失败](../../../../designs/timenook-modern-2026-11-10/project/StoryFailed.dc.html) | MP08 | story：整理失败 | 任务返回失败 | 原声可听、错误、重试与补录 |
| [StoryUnassigned · 06 项目成员｜故事详情 · 未归章](../../../../designs/timenook-modern-2026-11-10/project/StoryUnassigned.dc.html) | MP08 | story：未归章故事 | 无章回答保存／移出章 | 原声正文、选章、不强制入书 |
| [UnassignedStories · 07 项目成员｜未归章故事](../../../../designs/timenook-modern-2026-11-10/project/UnassignedStories.dc.html) | MP08 | stories／未归章筛选：未归章列表 | 目录→未归章故事 | 列表打开、选择归章 |
| [AssignStory · 08 项目成员｜选择故事所属章节](../../../../designs/timenook-modern-2026-11-10/project/AssignStory.dc.html) | MP08 | story-chapter（新增）：选择所属章节 | 故事／未归章→选择章节 | 选择任一章、跨章、取消与保存 |
| [RecordReady · 01 项目成员｜开始讲述 · 无照片](../../../../designs/timenook-modern-2026-11-10/project/RecordReady.dc.html) | MP09 | interview：准备／无照片 | 首页当前题→开始讲述 | 问题来源、整块开始、换题、添加照片 |
| [RecordReadyPhoto · 02 项目成员｜开始讲述 · 有照片](../../../../designs/timenook-modern-2026-11-10/project/RecordReadyPhoto.dc.html) | MP09 | interview：准备／有照片 | 照片起讲／准备页加图 | 选图、逐张移除、开始 |
| [Recording · 03 项目成员｜正在录音](../../../../designs/timenook-modern-2026-11-10/project/Recording.dc.html) | MP09 | interview：正在录音 | 准备→开始 | 计时、暂停、结束、加图先暂停 |
| [RecordPaused · 04 项目成员｜录音已暂停](../../../../designs/timenook-modern-2026-11-10/project/RecordPaused.dc.html) | MP09 | interview：录音暂停 | 录制→暂停／添加照片 | 继续、保留时长、结束、照片返回 |
| [Upload · 05 项目成员｜保存录音](../../../../designs/timenook-modern-2026-11-10/project/Upload.dc.html) | MP09 | interview：保存录音 | 结束／到时自动保存 | 局部状态、离开和恢复 |
| [UploadFailed · 06 项目成员｜录音上传失败](../../../../designs/timenook-modern-2026-11-10/project/UploadFailed.dc.html) | MP09 | interview：保存失败 | 上传实际失败 | 原片段保留、重试、不重复故事 |
| [RecordBlocked · 07 项目成员｜麦克风权限](../../../../designs/timenook-modern-2026-11-10/project/RecordBlocked.dc.html) | MP09 | interview：麦克风权限受阻 | 拒绝麦克风权限 | 权限恢复、返回不丢问题 |
| [BookEmpty · 01 项目成员｜书稿概览 · 暂无书稿](../../../../designs/timenook-modern-2026-11-10/project/BookEmpty.dc.html) | MP10 | book：无入章书稿 | 首页封面→空书稿 | 整理内容入口、禁止生成空稿 |
| [BookOverview · 02 项目成员｜书稿概览](../../../../designs/timenook-modern-2026-11-10/project/BookOverview.dc.html) | MP10 | book：书稿概览／就绪 | 首页封面→书稿 | 封面整卡、目录、预览、制作 |
| [BookCover · 03 项目成员｜编辑封面](../../../../designs/timenook-modern-2026-11-10/project/BookCover.dc.html) | MP10 | cover＋cover-photos：封面同次草稿 | 书稿封面整卡 | 选图返回、保存全字段、取消无写入 |
| [BookReader · 04 项目成员｜PDF 书稿预览](../../../../designs/timenook-modern-2026-11-10/project/BookReader.dc.html) | MP10 | manuscript：打开当前 PDF | 书稿→预览 | 真实文档打开、版本/页数 |
| [PdfDocument · 05 项目成员｜PDF 内容 · 微信查看器](../../../../designs/timenook-modern-2026-11-10/project/PdfDocument.dc.html) | MP10 | wx.openDocument 系统查看器：实际 PDF 内容 | 预览→系统打开 | 封面、章节、页码与原声二维码内容 |
| [BookChanged · 07 项目成员｜更新书稿](../../../../designs/timenook-modern-2026-11-10/project/BookChanged.dc.html) | MP10 | book：稿件待更新 | 修改封面／入书内容后 | 重新生成、固定制作稿仍可查 |
| [BookGenerateFailed · 08 项目成员｜书稿生成失败](../../../../designs/timenook-modern-2026-11-10/project/BookGenerateFailed.dc.html) | MP10 | book：PDF 生成失败 | 生成任务失败 | 错误与重试 |
| [ReaderFailed · 09 项目成员｜PDF 打开失败](../../../../designs/timenook-modern-2026-11-10/project/ReaderFailed.dc.html) | MP10 | manuscript：PDF 打开失败 | 下载／打开失败 | 重试、返回 |
| [OriginalAudio · 06 项目成员｜扫码原声回听](../../../../designs/timenook-modern-2026-11-10/project/OriginalAudio.dc.html) | MP10 | original-audio：扫码固定版本原声 | 书中二维码入口 | 登录恢复、权限、进度条与时间 |
| [BookAddress · 01 项目成员｜收货地址](../../../../designs/timenook-modern-2026-11-10/project/BookAddress.dc.html) | MP11 | address：收货地址 | 就绪书稿→制作 | 选择/填写地址、校验、键盘 |
| [BookPrintConfirm · 02 项目成员｜确认制作](../../../../designs/timenook-modern-2026-11-10/project/BookPrintConfirm.dc.html) | MP11 | print：确认制作 | 地址→继续 | 版本与地址事实、提交 |
| [BookProduction · 03 项目成员｜制作进度](../../../../designs/timenook-modern-2026-11-10/project/BookProduction.dc.html) | MP11 | production：制作中 | 提交制作成功 | 固定稿、进度、允许时取消 |
| [BookShipped · 04 项目成员｜书籍已寄出](../../../../designs/timenook-modern-2026-11-10/project/BookShipped.dc.html) | MP11 | production：已寄出 | 制作进度更新 | 真实物流、固定稿 |
| [BookDelivered · 05 项目成员｜书籍已送达](../../../../designs/timenook-modern-2026-11-10/project/BookDelivered.dc.html) | MP11 | production：已送达 | 物流更新送达 | 送达事实与固定稿 |
| [BookCancelled · 06 项目成员｜制作已取消](../../../../designs/timenook-modern-2026-11-10/project/BookCancelled.dc.html) | MP11 | production：已取消 | 确认取消成功 | 按权益修改重提 |
| [PrintUnknown · 07 项目成员｜确认提交结果](../../../../designs/timenook-modern-2026-11-10/project/PrintUnknown.dc.html) | MP11 | print／production：提交结果未知 | 提交响应未知 | 查原操作、防止重复制作 |

## 必要补充状态

- 登录协议未勾选的继续确认：同步原画布和原生组件，点击继续直接进入授权；不增加登录中间路由。
- 昵称编辑弹窗、照片空态、问题稍后/跳过/恢复、推荐池耗尽重开一轮，分别在所属画板内验证。
- 原生麦克风/相册授权、单段到时、保存恢复、故事无语音/无内容、素材权限失效，保留真实边界并在关联模块记录。
- 家人邀请失效使用原流程内提示，不恢复已删除独立失效页。
- 图标触点至少 44px，主按钮约 52px；检查长文本、输入键盘、底部安全区和独立滚动，首页问题与开始讲述必须共同滚动。
