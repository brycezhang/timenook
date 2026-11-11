# 最新设计与小程序实现差异 · 2026-11-11

状态：已完成源码对照与产品文档更新；以下调整均待实施。本轮未修改小程序、API、数据库、共享契约或构建代码，未运行支付、录音或真机验收。

## 对照范围

- 目标：原画布 [canvas.json](../../../designs/timenook-modern-2026-11-10/project/canvas.json)，当前 71 张页面／状态、11 个分组；以用户最后确认的规则为准，配套见[业务流程](../../../designs/timenook-modern-2026-11-10/project/BUSINESS-FLOW.md)、[新需求](../../../designs/timenook-modern-2026-11-10/project/REQUIREMENTS-2026-11-11.md)和[六章六十题](../../../designs/timenook-modern-2026-11-10/project/OUTLINE-QUESTION-BANK.md)。
- 实现：2026-11-11 本地工作区，HEAD `7e2cc95`；检查原生小程序正式入口及其 API、契约、数据模型。没有将设计原型中的样例状态当作后端能力，也没有重新核验线上部署版本。
- 正式入口按 [app.json](../../../miniprogram/app.json) 和 [build.mjs](../../../scripts/build.mjs) 判断。旧 `pages/project`、演示分支及构建排除页面不算当前用户可达流程；源码中仍有旧术语，不等于这些旧页面仍需重做。
- 71 张画板含空态、失败态、弹窗及系统 PDF 示意，不能直接换算为 71 个新路由。录音、支付结果、书稿及制作状态优先复用已有页面。

## 结论

现有基础可以复用：微信手机号登录弹窗、支付建单与查单、项目成员邀请、录音暂停／续录及自动上传、ASR 与故事整理、原声进度条、故事文字与照片编辑、章节与章内故事拖动、完整 PDF、固定版本原声入口、首本制作与物流。

主要业务增量是：指定手机号领取礼物、自购身份及付款去向、礼物三分类、成员关系、六章大纲与目录统一、家人文字提问及混合推荐、项目照片库，以及问题回答与故事归章联动。其余重点是入口、保存时机、白底手机布局与文案对齐。

## 功能调整清单

“新增”指现有正式路径没有对应闭环；“改造”指复用能力但改变业务行为；“界面调整”不代表新建后端服务。编号供后续拆分开发使用，本轮不创建实施票据。

| 编号 | 功能／类型 | 当前实现 | 最新目标与具体调整 | 涉及范围／完成条件 |
| --- | --- | --- | --- | --- |
| F01 | 全局视觉与命名／界面调整 | 正式 Tab 仍为“岁月成书”，默认书名仍有“人生故事书”；纸色、米色卡片、衬线标题仍在使用。 | 用户可见品牌统一“时光故事”，“人生”改为“时光”；白色页面、卡片、导航和底部操作区，保留 `#46563C` 与局部浅绿。功能标题只出现一次，必要状态和错误保留。 | 小程序全局样式、导航、可达页面与 API 返回的默认文案；不能批量改写用户自行填写的书名、故事或历史事实。320px／390px 检查无横向溢出，图标触点不小于 44px。见 E01。 |
| F02 | 统一送礼购买／改造 | “新购一本书”先填书名和选填称呼；接口已有关系目录与自定义字段，前端空称呼默认为“我”。公开首页没有独立样书阅读入口。 | 首页／我的统一“送出一份礼物”；关系必选，提供爸爸、妈妈、爷爷、奶奶、自己、自定义，书名必填。公开样书节选可查看。给他人和给自己共用购买流程，支付后分流。 | 首页、new-book、purchase、关系契约及服务端校验；无关系不能购买，自定义称呼可用，套餐与支付事实继续复用。见 E02。 |
| F03 | 登录弹窗与恢复／改造 | 首页与我的已有 `quick-login`，协议未勾选不能授权；购买、邀请及原声的部分入口仍转独立登录承载页。弹窗以“暂不登录”取消。 | 全部相关入口复用原地底部弹窗。最新备注：未勾选时按钮可点击，提示“继续登录表示同意协议”，点击“继续”即确认同意并直接继续微信手机号登录，无需重复勾选或点击登录；取消不提交，已勾选直接登录。关闭原地停留，条款返回后恢复弹窗，成功继续原操作。礼物验证成功仅进入待领取确认，不自动领取。 | quick-login 与购买／邀请／原声的调用方；无重复登录页、无登录后丢失目标故事书或入口参数。保留微信手机号及隐私授权能力；新增协议提示后的同意与登录衔接，画布交互和业务代码均待同步。见 E03。 |
| F04 | 指定手机号领礼／新增 | 只有普通项目邀请，没有礼物记录、指定手机号校验、专属领取接口或页面；普通邀请接受即添加成员，不能替代专属领礼。 | 付款后指定收礼人微信手机号，生成分享卡；验证匹配后明确领取，加入原项目并成为主讲人。领取前改号码重发，旧卡失效；领取后不能修改号码，原领取者重开有效卡进入原书。 | 新增礼物状态、领取人及卡片版本事实，接入分享和项目成员权限；不匹配、旧卡、重复领取均有正确分支。领取不新建项目或权益。见 E04。 |
| F05 | 送给自己／改造 | 当前可用“我”作为称呼购买，但付款后均到订单结果页；创建主人公档案时未按“自己”绑定当前账号。 | 显式选择“自己”，服务端确认付款后绑定当前账号为主讲人，直接进入故事书；不经过手机号设置、分享和领取。 | 支付完成后的项目初始化、主讲人身份和前端去向；同一订单只创建一本书及一份首本权益。见 E02、E04。 |
| F06 | 我的礼物三分类／改造 | memberships 仅返回 `purchased / invited`，项目与待付款订单合并为一个列表。 | 送出／收到／参与三类；自购同一本在送出和收到均显示，标记“送给自己”；普通家人只归参与。待付款在送出类恢复。切换故事书复用分类，展示送礼人昵称及购买时赠礼关系。 | memberships／列表契约、projects、首页与我的；同一本数据不复制，旧订单操作不改当前书内容。不能只把 `invited` 改名为“收到”。见 E04、E05。 |
| F07 | 主讲人视角成员关系／新增 | ProjectMember 保存账号、邀请与条款，没有成员相对主讲人的关系；赠礼关系在订单中。 | 家人接受邀请必填“你是主讲人的谁”；购买者首次提问缺关系时补填，主讲人本人显示“本人”。提问来源保存作者身份、昵称与关系，其他成员编辑问题不替换作者。 | 成员资料、邀请接受和提问发布；保留仅购买者可邀请、所有成员可记录／编辑／制作的权限。关系不产生新权限。见 E04、E06。 |
| F08 | 故事书首页／改造 | 首页为书名、静态开讲提示、故事与书稿独立行，没有实际推荐题、照片总数、原声总时长或家人问题数量。 | 问题与“开始讲述”放同一滚动卡片；故事数、照片数可点击，书名＋副标题＋封面整块进入书稿，删除三枚重复快捷按钮。保留家人提问入口与大纲选题；原声仅作整数分钟统计。 | home、项目概览统计与推荐数据；0 个故事／0 张照片仍能进入空态，统计属于当前项目。分钟四舍五入，非零不足一分钟显示“<1 分钟原声”，播放仍精确到秒。见 E05。 |
| F09 | 六章大纲即目录／改造 | 默认模板仅 3 章各 1 题且为工程样例；问题计划 `PlanRevision` 与书稿目录 `PlanDirectoryVersion` 独立，目录初始为空。前端“话题管理”与“章节目录”分离。 | 初始化通用 6 章×10 题，关系不影响模板。大纲与目录共用章节身份、名称和顺序，章内分问题／故事；增删改、章节排序及问题管理统一。模板版本不覆盖个人编辑。 | 模板、项目初始化、计划／目录服务与对应页面；改名／排序双处一致，空章和未答题不进入 PDF。60 题正文仍需内容审校。见 E07。 |
| F10 | 家人提问闭环／新增 | 已有自拟问题、计划题状态与实际提问快照，缺逐题原作者、成员关系、独立家人列表和跨成员回答故事关联。 | 文字输入问题，可选章节；发布→待回答→语音回答→关联故事。支持稍后回答、跳过、恢复、编辑、删除，已回答卡片可进入故事。章节内发起可带入也可取消，不增加审核或语音提问。 | 问题实体／契约／API、列表／详情／表单与采访关联；回答前后来源一致，删除问题保留故事和录音。复用实际问题快照，不把录音操作人当提问人。见 E06、E07、E08。 |
| F11 | 家人优先混合推荐／新增 | 服务端取可用计划题第一条为默认；前端按数组顺序循环换题，`later` 持续被过滤，没有两类混合、本轮去重或已回答排除闭环。 | 每次进入优先待回答家人题，足量时约 2 家人题穿插 1 大纲题、类内随机、本轮不重复；一类不足另一类补足。已回答／跳过不推荐，稍后回答本次略过、下次进入可再出现。 | 共用推荐逻辑、问题状态和首页／讲述页；换题不重新建故事，切换项目分别保留状态，新增提问不重置已浏览集合。见 E08。 |
| F12 | 录音入口与照片操作／改造 | 首页进入采访先“选题”，再进入准备；暂停／继续／10 分钟自动保存已具备。照片仅在照片起点显示，录音中和暂停时都禁止跳到照片管理。 | 首页带当前题直接到准备；换题才进入大纲目录，支持自由讲述；所有起点可添加／逐张移除本次照片。录音中添加照片先暂停、保留时长并可继续；麦克风与“开始录音”整块可点击。 | interview、草稿选题、照片关联与 RecorderManager 生命周期；补录仍属同一故事且不换题，新故事不恢复上篇采访。原有可靠保存与恢复继续复用。见 E09。 |
| F13 | 项目照片入口／新增聚合能力 | 照片页及上传接口依赖 interviewId，封面候选来自已有可入书故事的照片；不是独立项目照片库。 | 首页照片数进入整本书照片列表；无故事时也能添加照片，选照片后“讲讲这张照片”，随后关联新故事。故事内补图与讲述中关联复用同一素材。 | 项目级素材归属／列表及上传入口、照片展示／选择、首页统计与封面选择；移除本次关联不删除其他故事或已冻结版本中的素材。见 E10。 |
| F14 | 故事归章及暂不入书／改造 | 首次成稿自动加第一章，重新“放入书中”也加第一章；章内选择／排序／移出／跨章移动已可用。无独立未归章清单或故事详情选章入口。 | 有问题章节则归该章；未选、自由讲述或章已删除时保存为未归章故事。详情、未归章清单、任一章节可随时归章；同一故事同时只在一章。暂不入书与未归章分别展示，均可恢复归章。 | stories、章节引用、问题回答关联与页面；修改已回答问题章节时同步移动故事，移动故事后关联问题展示同步。删章保留故事，家人问题保留为未选章。见 E11。 |
| F15 | 故事详情与回听／界面调整 | 原声已支持播放／暂停、进度条、拖动与时间；文字编辑页已仅保存修改。故事页另有“入书原声”、泛化入书开关与较多说明。 | 复用现有播放器，按设计统一卡片；故事详情集中正文、照片、章节、编辑文字与继续讲述。入书动作改为可见的选章语义；失败保留原声和重试，整理中可离开。 | story、edit-story、original-audio；不重新建设音频系统。现有逐段原声选择能力不因画布未独立展示而删除后端数据，可保留为次级操作，不占主流程。见 E12。 |
| F16 | 封面编辑保存时机／改造 | 当前选择封面照片前会先保存书名／寄语，选图页再直接写入封面。离开主编辑页并不一定代表放弃全部修改。 | 封面整卡进入编辑；书名、寄语与照片组成同次编辑，点击保存才生效，直接返回放弃未保存修改。 | cover、cover-photos 与保存调用顺序；选图返回后继续编辑，取消不改封面或书名，保存后使受影响 PDF 待更新。见 E13。 |
| F17 | PDF 预览与收录范围／改造 | 已生成真实 PDF 并用 `wx.openDocument` 打开；空的第 1 版目录会临时收录所有 eligible 故事，版本校验也含同类回退。 | 只收录当前目录引用的故事，去掉空目录自动全收录及对应版本计算；未归章不阻塞已有内容生成，但全书没有入章内容时显示空稿并引导整理。变更需重生成，既有／制作版本保持固定。 | books 的生成、内容 hash、版本校验和 book／manuscript UI；不新增自定义 PDF 阅读器，系统 PDF 内目录只读，书中原声仍扫描二维码鉴权播放。见 E14。 |
| F18 | 制作与寄送／界面调整 | 就绪 PDF、地址、首本权益、提交结果未知、固定制作版本、取消和物流已有流程。地址在 print 页进入后再填写。 | 按画布组织地址→确认制作→进度；重复提交／未知结果查单、取消后修改重提继续复用。提交后查看当次固定稿，不让新版书稿替换正在制作的文件。 | address、print、production；统一功能标题与主操作，避免重复返回。真实权益、支付、生产限制继续执行，样例画布不能绕过。见 E15。 |

## 画布覆盖映射

| 原画布分组 | 对应调整 | 处理方式 |
| --- | --- | --- |
| 01 首页与购买 | F01–F03、F05 | 首页与表单重排，补样书；支付和登录组件复用。 |
| 02 礼物设置与分享 | F04 | 新增购买后的收礼设置／礼物卡，不恢复祝福或可选准备页。 |
| 03 礼物领取 | F03、F04 | 新增匹配、明确接受、不匹配、失效和已领取状态。 |
| 04 故事书与我的礼物 | F06–F08 | 首页、三分类与关系表单；复用项目切换和成员访问。 |
| 05 家人提问 | F07、F10、F11 | 新增列表、文字表单、详情、已回答状态。 |
| 06 语音记录 | F09、F11–F13 | 复用同一录音页的准备／录制／暂停／上传／失败状态。 |
| 07 故事与原声 | F13–F15 | 调整故事详情、归章及播放器外观。 |
| 08 大纲目录与选题 | F09、F10、F14 | 统一章节，复用排序组件，补问题与故事关联。 |
| 09 书稿编辑与预览 | F14、F16、F17 | 封面保存与收录逻辑调整，PDF 使用系统查看器。 |
| 10 制作与寄送 | F18 | 现有制作能力按新信息顺序展示。 |
| 11 我的与条款 | F01、F03、F06 | 保留昵称、登录退出、条款；入口改为我的礼物与送礼。 |

## 建议实施顺序

1. **送出并领取一本书**：F02–F06，配套 F01 的基础样式。可演示他人专属领取和自购直入，两类身份进入同一本书；真实支付待验与本地功能分别记录。
2. **家人提问并留下故事**：F07–F12 及 F14 的回答归章规则，复用语音任务；先打通六章、文字提问、首页推荐、语音回答、来源与正确归章，再补齐相关状态。
3. **照片与故事整理成书**：F13、F14 的管理入口及 F15–F18，完成项目照片、随时归章、封面草稿、PDF 收录与制作；最后统一余下页面的 F01 文案和布局。

F06 依赖真实送出／领取／参与身份，F11 依赖问题来源及状态，F14／F17 依赖统一章节；不能先靠显示文案或前端样例假装这些关联已经成立。以上为实施建议，未作工期承诺。

## 后续验收路径

- 他人送礼：付款成功→指定号码→分享→错误号码不能领→正确号码仍需确认→进入原书；更正号码使旧卡失效，重复领取不复制权益。
- 送给自己：付款后直入；送出／收到打开同一项目；待付款与新购分开恢复。
- 家人参与：仅购买者可邀请，接受时填主讲人视角关系；发布问题只用文字，缺关系先补填，其他成员编辑仍显示原作者。
- 首页开讲：首题优先家人，换题混合且本轮不重复；稍后题本次消失、再次进入可见；已回答／跳过不进入推荐。
- 六章与故事：新建有 6×10 题；增删改和排序在大纲与书稿一致；有章回答入对应章，无章回答保留，任意时点可归章、跨章移动，删问题／删章不删故事或原声。
- 录音与照片：无照片可直接讲；录音中加照片先暂停，继续时不丢时长；结束自动保存，同故事补录，多项目互不串用。项目零照片能添加并以照片起讲。
- 成书：一本书有已归章与未归章故事时，PDF 仅含前者且不被后者阻断；没有已归章故事时不生成空白 PDF。预览是真实 PDF；封面取消不保存，保存后重新生成；已提交稿保持固定。
- 手机布局：320px／390px、长书名／问题／关系、表单键盘和底部安全区；首页问题与开讲一同滚动、数字和整卡入口可点，无重叠／裁切／重复入口。

本轮只完成文档与源码对照；以上是待实施后的验证条件，不记为已通过。现有设计浏览器走查见 [REVIEW.md](../../../designs/timenook-modern-2026-11-10/project/REVIEW.md)，不能替代原生小程序或真机结果。

## 代码依据

| 标识 | 本次实际核对的位置 |
| --- | --- |
| E01 | [app.json](../../../miniprogram/app.json)、[custom-tab-bar](../../../miniprogram/custom-tab-bar/index.wxml)、[tokens.wxss](../../../miniprogram/styles/tokens.wxss)、[senior.wxss](../../../miniprogram/styles/senior.wxss)。后加载样式已有橄榄绿 `#46563C`，主色本身无需重选。 |
| E02 | [new-book](../../../miniprogram/pages/new-book/index.ts)、[购买表单](../../../miniprogram/pages/new-book/index.wxml)、[purchase](../../../miniprogram/pages/purchase/index.ts) 的 onLoad／checkout、[orders](../../../apps/api/src/payments/orders.ts) 的 create 与付款入账建项目。 |
| E03 | [quick-login](../../../miniprogram/components/quick-login/index.wxml)、[home](../../../miniprogram/pages/home/index.ts)、[account](../../../miniprogram/pages/account/index.ts)、[login](../../../miniprogram/pages/login/index.ts)、[welcome](../../../miniprogram/pages/welcome/index.ts)、[original-audio](../../../miniprogram/pages/original-audio/index.ts)。 |
| E04 | [participation](../../../apps/api/src/identity/participation.ts) 的 invite／preview／apply／memberships／status；[schema.prisma](../../../apps/api/prisma/schema.prisma) 的 ProjectMember、ProjectSubject、PaymentOrder；没有专属礼物领取实体或接口。 |
| E05 | [首页模板](../../../miniprogram/pages/home/index.wxml)、[project-overview](../../../apps/api/src/projects/project-overview.ts)、[projects](../../../miniprogram/pages/projects/index.ts) 及其 [WXML](../../../miniprogram/pages/projects/index.wxml)。 |
| E06 | [成员契约](../../../packages/contracts/src/participation.ts)、[问题契约](../../../packages/contracts/src/index.ts) 的 PlanQuestion／ActualPlanQuestion；capturedBy 是实际提问操作人，不能代替家人问题原作者。 |
| E07 | [builtin-template](../../../apps/api/src/projects/builtin-template.ts)、[project-plans](../../../apps/api/src/projects/project-plans.ts) 的 createProject／reviseDirectory；基线中的 [plan](https://github.com/brycezhang/timenook/blob/149b1b6ea7721c68984f5e81ada4caba9a7e4c01/miniprogram/pages/plan/index.ts)、[topic](https://github.com/brycezhang/timenook/blob/149b1b6ea7721c68984f5e81ada4caba9a7e4c01/miniprogram/pages/topic/index.ts)，以及 [directory](../../../miniprogram/pages/directory/index.ts)。前两页已由 MP05 的统一大纲目录替换，历史链接保留当时的差异证据。 |
| E08 | [interviews](../../../apps/api/src/projects/interviews.ts) 的 recordingPlan；[interview](../../../miniprogram/pages/interview/index.ts) 的 chooseAnother／selectQuestion。 |
| E09 | [interview 模板](../../../miniprogram/pages/interview/index.wxml)、[interview 控制器](../../../miniprogram/pages/interview/index.ts) 的 photos／togglePause／authorizeRecording；[录音上限](../../../packages/contracts/src/recording.ts)。 |
| E10 | [photos 页面](../../../miniprogram/pages/photos/index.ts) 的 readCollection／onShow、[照片 API](../../../apps/api/src/media/photos.ts) 的 interviews/:interviewId/photos 路由、[books](../../../apps/api/src/books/books.ts) 的 coverPhotoOptions。 |
| E11 | [stories](../../../apps/api/src/stories/stories.ts) 中入书切换与首次 revision 的 `chapters[0].storyRefs.push`；[chapter-stories](../../../miniprogram/pages/chapter-stories/index.ts) 的 persist 和 [sort-list](../../../miniprogram/components/sort-list/index.ts)。 |
| E12 | [story](../../../miniprogram/pages/story/index.wxml) 的 slider、[story 控制器](../../../miniprogram/pages/story/index.ts) 的 seekLive、[original-audio](../../../miniprogram/pages/original-audio/index.wxml)、[edit-story](../../../miniprogram/pages/edit-story/index.wxml)。 |
| E13 | [cover](../../../miniprogram/pages/cover/index.ts) 的 choose→persist 与 [cover-photos](../../../miniprogram/pages/cover-photos/index.ts) 的 save。 |
| E14 | [books](../../../apps/api/src/books/books.ts) 的 `stored.version === 1` 空目录回退及 `directory.version === 1` 校验回退；[manuscript](../../../miniprogram/pages/manuscript/index.ts) 的 openPdf；[book-audio](../../../apps/api/src/books/book-audio.ts)。 |
| E15 | [print](../../../miniprogram/pages/print/index.ts)、[address](../../../miniprogram/pages/address/index.ts)、[production](../../../miniprogram/pages/production/index.ts)、[first-copy](../../../apps/api/src/books/first-copy.ts)、[fulfillment](../../../apps/api/src/books/fulfillment.ts)。 |

## 本轮文档同步

已更新当前业务流程、PRD、业务词汇、前端设计依据及项目上下文；历史交付记录和旧截图不改写。当前已确认规则与待实施项以上述正文区分，后续交付再补代码与运行证据。

文档校验：本轮涉及文档的本地链接与 `git diff --check` 通过；开始／结束前对照小程序、应用、契约及脚本的文件摘要，源码无修改。未运行应用测试、真实支付、设备录音或印刷验收。
