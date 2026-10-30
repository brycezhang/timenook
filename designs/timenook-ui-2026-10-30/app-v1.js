/* TimeNook design proposal. In-memory examples only; no API, microphone or customer data. */
const screens = {
  project: [
    "01 项目首页",
    "首页只呈现当前行动、未完成讲述和故事。历史任务收进详情；待本人确认优先。",
  ],
  choose: [
    "02 选择讲述起点",
    "推荐问题居首；照片、自由讲述、自拟问题保留，但减少同级按钮。",
  ],
  prepare: [
    "03 录音准备",
    "先看清实际问题，再打开麦克风。授权缺失时转到本人用途选择。",
  ],
  record: [
    "04 录音 / 暂停",
    "问题、计时、暂停、结束四个核心元素。录制中离开要保护现有录音。",
  ],
  review: [
    "05 回听与提交",
    "本机保存与上传明确分开。重录二次确认；旧录音在替换成功前保留。",
  ],
  processing: [
    "06 保存与文字处理",
    "逐段区分本机、云端、转写。仅云端封存后可提示跨设备恢复；失败重用原录音。",
  ],
  followup: [
    "07 可选追问",
    "用户主动请求，一次一题，随时跳过；全部选定片段转写就绪后才能整理。",
  ],
  story: [
    "08 故事阅读与确认",
    "大字阅读优先。原声、正式转录与整理稿可核对；确认内容和允许入书是两项独立决定。",
  ],
  edit: [
    "09 校对故事",
    "保留原始录音。保存文字形成新版本，旧确认及受影响的书稿确认失效。",
  ],
  book: [
    "10 成书概览",
    "呈现确切书稿版本、目录与下一步；未允许入书的故事不混进本版。",
  ],
  manuscript: [
    "11 书稿核对",
    "双方确认同一版本，讲述者核对内容，发起人核对排版。书稿变化后重新确认。",
  ],
  print: [
    "12 首本制作 / 地址",
    "地址由发起人确认。门槛逐项可读；提交不等于已生产。内测保持生产关闭。",
  ],
  account: [
    "13 我的",
    "项目、账号与资料服务集中。项目切换清除上一项目的私有页面。",
  ],
  service: [
    "14 资料与服务",
    "长期服务与临时访问授权分开。主动撤回、删除、退款和质量售后分别处理。",
  ],
  invite: [
    "15 邀请与协助",
    "以邀请信呈现关系；邀请不是授权，同机协助不能代替本人决定。",
  ],
  consent: [
    "16 本人参与与资料用途",
    "采集、AI、共享、入书分别决定，不预勾选。拒绝可保留，采集或AI拒绝会限制相应动作。",
  ],
  plan: [
    "17 项目大纲与问题",
    "章节列表代替操作按钮墙。问题可改写、跳过或标为不适用；不影响已保存的实际提问。",
  ],
  login: [
    "18 网页登录 / 失效",
    "短期一次性链接与产品账号分开；清楚解释失效和续发，不在界面露出票据。",
  ],
  marketing: [
    "19 官网 / 内测入口",
    "保留现有品牌、素材与 999 元信息。内测入口独立标注，正式售卖继续受准入约束。",
  ],
};
const sampleText =
  "我小时候住的房子，门前有一棵很大的桂花树。每到秋天，院子里都是甜甜的香味。\n\n放学回来，我总爱把书包往门边一放，搬一张小板凳坐在树下，看外婆择菜。她一边忙着手里的活，一边问我今天在学校学了什么。\n\n那时候的日子过得慢。傍晚，炊烟从屋顶升起来，街坊的招呼声从巷子那头传过来。外婆叫我吃饭，我就知道，一天又快过去了。";
const initial = () => ({
  view: "desktop",
  width: 390,
  network: "normal",
  role: "narrator",
  page: "project",
  topic: "小时候的家，是什么样子的？",
  topicIndex: 0,
  source: "question",
  custom: "",
  filter: "all",
  paused: false,
  seconds: 0,
  recorded: false,
  playing: false,
  progress: 0,
  failed: false,
  version: 2,
  bookVersion: 3,
  confirmed: false,
  inclusion: false,
  narratorBook: false,
  initiatorBook: false,
  address: false,
  bookDirty: false,
  bookIncluded: false,
  assisted: false,
  text: sampleText,
  title: "老屋门前的那棵桂花树",
  consents: {},
  authorized: false,
  questionSkipped: false,
  loginExpired: false,
  storyReady: true,
  photoSelected: false,
});
let state = initial(),
  recordInterval,
  processingTimeout,
  playerInterval,
  toastTimeout;
const app = document.querySelector("#app"),
  picker = document.querySelector("#screen-picker"),
  rolePicker = document.querySelector("#role-picker"),
  device = document.querySelector(".device"),
  sheet = document.querySelector("#sheet");
const esc = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
const icon = (name, light = false) =>
  `<img class="icon" alt="" src="assets/icons/${name}${light ? "-light" : ""}.svg">`;
const btn = (text, action, kind = "primary", extra = "") =>
  `<button class="btn ${kind}" data-action="${action}" ${extra}>${text}</button>`;
const link = (text, action) =>
  `<button class="text-link" data-action="${action}">${text}${icon("chevron-right")}</button>`;
const meta = (text) => `<p class="meta">${text}</p>`;
const step = (n) =>
  `<div class="step-header">${n} / 5 <span>选题 → 录制 → 回听 → 保存 → 核对故事</span></div>`;
const back = (route = "project", text = "返回故事书") =>
  `<button class="back-link" data-go="${route}">${icon("arrow-left")}${text}</button>`;
const heading = (title, sub = "") =>
  `<h2 class="page-title">${title}</h2>${sub ? `<p class="subtitle">${sub}</p>` : ""}`;
const topics = [
  "小时候的家，是什么样子的？",
  "小时候和家人去菜市场，最记得哪些细节？",
  "有没有一位老师，让你一直记到现在？",
];
for (const [key, [label]] of Object.entries(screens))
  picker.insertAdjacentHTML(
    "beforeend",
    `<option value="${key}">${label}</option>`,
  );
function stopTimers() {
  clearInterval(recordInterval);
  clearInterval(playerInterval);
  clearTimeout(processingTimeout);
  state.playing = false;
}
function toast(text) {
  clearTimeout(toastTimeout);
  const el = document.querySelector("#toast");
  el.textContent = text;
  el.style.display = "block";
  toastTimeout = setTimeout(() => (el.style.display = "none"), 3200);
}
function modal(title, body, actions = "") {
  document.querySelector("#sheet-content").innerHTML =
    `<button class="close-sheet" data-action="close" aria-label="关闭">${icon("x")}</button><h2 id="sheet-title">${title}</h2>${body}<div class="stack mt">${actions || btn("知道了", "close")}</div>`;
  sheet.showModal();
}
function go(page) {
  if (state.page === "record" && page !== "review") {
    modal(
      "先保留这段讲述？",
      "<p>录音尚未提交。可以继续讲，也可以先停下来回听。本原型仅演示操作。</p>",
      btn("停下来，先回听", "stop-record") +
        btn("继续录音", "close", "secondary"),
    );
    return;
  }
  stopTimers();
  state.page = page;
  location.hash = page;
  render();
  if (page === "record") startTimer();
  if (page === "processing") {
    if (!state.progress) state.progress = 1;
    process();
  }
}
function time() {
  return `${String(Math.floor(state.seconds / 60)).padStart(2, "0")}:${String(state.seconds % 60).padStart(2, "0")}`;
}
function startTimer() {
  clearInterval(recordInterval);
  recordInterval = setInterval(() => {
    if (!state.paused) {
      state.seconds++;
      const node = document.querySelector("#timer");
      if (node) node.textContent = time();
    }
  }, 1000);
}
function sharedNav() {
  return [
    ["project", "book-open", "故事书"],
    ["book", "file-text", "成书"],
    ["account", "user", "我的"],
  ];
}
function render() {
  const rootPage = ["project", "book", "account"].includes(state.page);
  const active =
    state.page === "book" ||
    state.page === "manuscript" ||
    state.page === "print"
      ? "book"
      : state.page === "account" || state.page === "service"
        ? "account"
        : "project";
  document.querySelector("#network-picker").value = state.network;
  device.dataset.view = state.view;
  device.style.setProperty("--preview-width", state.width + "px");
  document.querySelector("#width-picker").value = String(state.width);
  document.querySelectorAll("[data-view]").forEach((el) => {
    if (el.tagName === "BUTTON")
      el.setAttribute("aria-pressed", String(el.dataset.view === state.view));
  });
  document.querySelector("#viewport-label").textContent = {
    desktop: "桌面网页 · 自适应布局",
    web: `手机网页 · ${state.width} px · 同源产品入口`,
    mini: `微信小程序 · ${state.width} px · 原生导航区域仅留位`,
  }[state.view];
  picker.value = state.page;
  rolePicker.value = state.role;
  document.querySelector("#design-note").textContent =
    screens[state.page]?.[1] || "";
  app.innerHTML = `<header class="app-header"><button class="app-brand" data-go="project">${state.view === "mini" ? (rootPage ? "时光里" : screens[state.page][0].slice(3)) : "时光里"}<small>岁 月 成 书</small></button><div class="header-right"><button class="header-projects" data-action="projects">我的故事书</button><span class="identity"><span class="avatar">${state.role === "narrator" ? "林" : "许"}</span>${state.role === "narrator" ? "讲述者本人" : "发起人"}</span></div></header><div class="app-layout"><nav class="app-side" aria-label="主导航"><p class="side-title">当前人生项目<br>妈妈的一生</p>${sharedNav()
    .map(
      ([route, ic, text]) =>
        `<button class="side-link ${active === route ? "active" : ""}" data-go="${route}">${icon(ic)}${text}</button>`,
    )
    .join(
      "",
    )}<div class="side-bottom">慢慢说，不必赶。<br>制作、回听与下载长期有效。</div></nav><main class="content-scroll" id="content"><section class="page ${["project", "book", "marketing"].includes(state.page) ? "" : "narrow"} ${state.page === "marketing" ? "marketing" : ""}" data-screen-label="${screens[state.page][0]}">${pages[state.page]()}</section></main></div>${
    rootPage
      ? `<nav class="bottom-tabs" aria-label="底部导航">${sharedNav()
          .map(
            ([route, ic, text]) =>
              `<button data-go="${route}" class="${active === route ? "active" : ""}">${icon(ic)}<span>${route === "project" ? "妈妈的一生" : text}</span></button>`,
          )
          .join("")}</nav>`
      : ""
  }`;
  bindForm();
}
const pages = {
  project() {
    return `<div class="project-heading"><div><p class="eyebrow">一位讲述者，一本人生书</p>${heading("妈妈的一生", "${name}").replace("${name}", "讲述者 林女士 · 发起人 小许")}<div class="stage-line"><span class="active">讲述往事</span><i></i><span>核对书稿</span><i></i><span>制作与寄送</span></div></div><img class="book-thumbnail" src="assets/book.jpg" alt="人生书效果示意"></div><div class="overview-grid"><div class="today-card"><div class="section-kicker">${icon("sprout")}今天，聊一件记得的小事</div><h3>小时候的家，<br>是什么样子的？</h3>${btn(icon("mic", true) + (state.role === "initiator" ? "本人在场，协助讲述" : "开始一段讲述"), state.role === "initiator" ? "assisted" : "choose")}${link("看着照片，讲一讲", "photo-start")}</div><div class="resume-card"><span class="pill pending">${state.recorded ? "这段讲述已录好" : "接着上次"}</span><h3>${state.recorded ? "刚才的往事" : "老屋门前的桂花树"}</h3><p class="meta">${state.recorded ? "留在这台设备，等待提交" : "原声已保存 · 故事待本人核对"}</p>${link(state.recorded ? "回听与提交" : "去核对这篇故事", state.recorded ? "review" : "story")}</div></div><div class="row mt"><h3 class="section-title">留下来的故事</h3>${link("邀请与协助", "invite")}</div><div class="story-tabs"><button class="${state.filter === "all" ? "active" : ""}" data-action="filter-all">全部故事 2</button><button class="${state.filter === "pending" ? "active" : ""}" data-action="filter-pending">待本人确认 ${state.confirmed ? 0 : 1}</button></div>${!state.confirmed || state.filter === "all" ? `<button class="story-row" data-go="story"><span class="number">01</span><span class="grow"><span class="story-name">${esc(state.title)}</span><span class="meta" style="display:block">童年的小城 · 第 ${state.version} 版</span></span><span class="pill ${state.confirmed ? "" : "pending"}">${state.confirmed ? (state.inclusion ? "允许入书" : "已确认 · 暂不入书") : "待本人确认"}</span>${icon("chevron-right")}</button>` : '<p class="empty">这一刻，没有待确认的故事。<br>想起来时，再慢慢讲。</p>'}${state.filter === "all" ? `<button class="story-row" data-action="other-story"><span class="number">02</span><span class="grow"><span class="story-name">第一次独自出远门</span><span class="meta" style="display:block">青春的选择 · 第 1 版</span></span><span class="pill">允许入书</span>${icon("chevron-right")}</button>` : ""}<div class="row mt">${link("查看大纲与问题", "plan")}${link("保存与处理详情", "tasks")}</div><p class="footnote">自己的节奏就很好。制作、回听与下载长期有效。</p>`;
  },
  choose() {
    return `${back()}${step(1)}${heading("今天，想从哪里说起？", "一个问题、一张照片，或一段突然想起的往事。皆可。")}<div class="question-card mt"><p class="eyebrow">童年的小城</p><h3 class="question">${esc(state.topic)}</h3>${btn("就从这个问题开始", "prepare")}${link("换一个问题", "change-question")}</div><button class="choice-row" data-action="photo-start">${icon("image")}<span class="grow"><strong>看着照片讲一讲</strong><p>从已有照片中选一张，事后也能补图。</p></span>${icon("chevron-right")}</button><button class="choice-row" data-action="free">${icon("mic")}<span class="grow"><strong>我有自己想说的</strong><p>自由讲述，或写下一个自己的问题。</p></span>${icon("chevron-right")}</button><div class="mt">${link("看看我的大纲与问题", "plan")}</div>`;
  },
  prepare() {
    return `${back("choose", "另选一个起点")}${step(2)}<p class="eyebrow">准备好了，就开始</p><h2 class="question">${esc(state.topic)}</h2><p class="subtitle">可以聊聊当时的人、地方，或一件记得的小事。想到哪儿，说到哪儿。</p>${state.photoSelected ? `<figure class="mt"><img src="assets/family.jpg" alt="用于原型的亲情效果示意" style="max-height:200px;border-radius:7px;object-fit:cover;width:100%"><figcaption class="sample-indicator">现有生成素材，仅作选图布局示意</figcaption></figure>` : ""}<div class="record-center"><button class="record-button" data-action="start-record" aria-label="开始说（录音交互示意）">${icon("mic", true)}</button><p>开始说</p><p class="recorder-hint mt-sm">中途可以暂停，说完后先听一听。<br>确认提交前，录音仅留在这台设备。</p></div><div class="safe-note">${icon("shield-check")}<span>当前采集与 AI 处理用途${state.authorized ? "已同意" : "未获同意"}。${link("查看本人用途选择", "consent")}</span></div><div class="mt">${link("麦克风打不开？", "mic-help")}</div>`;
  },
  record() {
    return `${back("project", "先停下来")}${step(2)}<p class="eyebrow">${state.paused ? "休息一下，随时继续" : "只管慢慢说"}</p><h2 class="question">${esc(state.topic)}</h2><div class="record-center"><div class="record-timer" id="timer">${time()}</div><p class="meta"><span class="status-dot"></span>${state.paused ? "已暂停" : "录音中"} · 交互示意</p><button class="record-button live" data-action="pause" aria-label="${state.paused ? "继续说" : "暂停一下"}">${icon(state.paused ? "mic" : "pause", true)}</button><p>${state.paused ? "继续说" : "暂停一下"}</p><p class="recorder-hint mt-sm">${state.paused ? "想好再说，不用着急。" : "录音尚未保存，请先不要关闭页面。"}</p></div>${btn("说完了，先听一听", "stop-record", "primary", 'style="width:100%"')}`;
  },
  review() {
    return `${back()}${step(3)}${heading("先听一听，再留下。", "不急着提交，也可以重新录一遍。")}<h3 class="question" style="font-size:24px">${esc(state.topic)}</h3><div class="audio-player mt"><button class="play-button" data-action="play" aria-label="${state.playing ? "暂停回听示意" : "回听录音示意"}">${icon(state.playing ? "pause" : "play")}</button><div class="grow"><p style="font-size:14px">这段讲述</p><input aria-label="回听示意进度" id="audio-progress" class="audio-progress" type="range" min="0" max="100" value="0"><p class="meta">00:00 / ${state.seconds ? time() : "01:36"}</p></div></div><p class="sample-indicator">回听为交互示意，没有真实音频。</p><div class="safe-note mt">${icon("shield-check")}<span>已保存在这台设备<br><small>还未上传，换设备暂时看不到。</small></span></div><div class="stack mt">${btn("提交这段讲述", "submit")}${btn("重新录这一段", "rerecord", "secondary")}</div><p class="footnote">提交后才会上传并转写。更改文字不会覆盖原始录音。</p>`;
  },
  processing() {
    const p = state.progress;
    return `${back()}${step(4)}${heading(state.failed ? "上传暂时中断了。" : p === 3 ? "这段讲述，已保存。" : "正在妥善保存这段讲述。", state.failed ? "录音还在这台设备，恢复网络后可继续上传，无需重录。" : p === 3 ? "原声已保存，转写已就绪。可以整理成故事，也可以再补充一点。" : "本机保存、云端保存与文字处理会分别显示。")}<ol class="progress-list"><li class="done"><span class="step-count">1</span><div><strong>保存在这台设备</strong><p>示例片段 · ${state.seconds ? time() : "01:36"}</p></div></li><li class="${p >= 2 ? "done" : ""}"><span class="step-count">2</span><div><strong>${state.failed ? "等待继续上传" : p >= 2 ? "云端已保存" : "正在上传并核对保存结果"}</strong><p>${p >= 2 ? "封存结果已确认，可返回项目后继续。" : "此时请保留本机录音，暂不要清理浏览器资料。"}</p></div></li><li class="${p === 3 ? "done" : ""}"><span class="step-count">3</span><div><strong>${p === 3 ? "文字已转写" : p >= 2 ? "正在转写文字" : "等待原声保存完成"}</strong><p>正式转录仍需要本人核对，尚不代表故事已确认。</p></div></li></ol>${state.failed ? btn("继续上传原录音", "retry", "primary", 'style="width:100%"') : p === 3 ? `<div class="stack">${btn("整理成故事", "organize")}${btn("我想再补充一点", "followup", "secondary")}</div>` : `<p class="sample-indicator" role="status">原型正在演示保存流程，约数秒后更新。</p>`}<div class="mt">${link(p >= 2 ? "先返回故事书" : "暂留本机，稍后继续", "project")}</div>${p === 3 ? link("查看正式转录", "transcript") : ""}`;
  },
  followup() {
    return `${back("processing", "返回保存进度")}${step(4)}${heading("还想说一点吗？", "追问由你决定。想跳过，也完全可以。")}<div class="question-card mt"><p class="eyebrow">一条可选追问 · 示例</p><h3 class="question">外婆坐在树下择菜时，<br>你们会聊些什么？</h3>${link("按自己的问法改写", "rewrite-question")}</div><div class="stack mt">${btn("我想接着说", "followup-record")}${btn("跳过，整理这篇故事", "organize", "secondary")}</div><p class="footnote">只有已选片段全部转写就绪，才会一起整理。</p>`;
  },
  story() {
    return `${back()}<div class="row"><p class="eyebrow">童年的小城 / 示例整理稿</p><span class="pill ${state.confirmed ? "" : "pending"}">${state.confirmed ? (state.inclusion ? "允许入书" : "已确认 · 暂不入书") : "待本人确认"}</span></div><h2 class="page-title mt-sm">${esc(state.title)}</h2><p class="meta">第 ${state.version} 版 · 原声保留，文字可以校对</p><div class="reading-tools">${link("核对原声与转录", "transcript")}${link("校对这篇故事", "edit")}${link("照片与来源", "sources")}</div><article class="story-body">${state.text
      .split("\n\n")
      .map((p) => `<p>${esc(p)}</p>`)
      .join(
        "",
      )}</article><p class="sample-indicator">以上为项目既有虚构示例，经缩写用于版式评审。</p><div class="decision-panel"><h3 class="section-title">这版故事，由你决定。</h3><p class="subtitle">内容核对与入书许可分别选择。</p>${state.role === "narrator" ? `<label class="check-row"><input id="confirm-content" type="checkbox" ${state.confirmed ? "checked" : ""}><span>我确认第 ${state.version} 版内容<small>已阅读全文，内容与我的讲述相符。</small></span></label><label class="check-row"><input id="allow-book" type="checkbox" ${state.consents.book !== "yes" ? "disabled" : ""} ${state.inclusion ? "checked" : ""}><span>我允许第 ${state.version} 版用于人生书<small>可以确认内容，同时选择暂不入书。</small></span></label>${state.consents.book !== "yes" ? `<p class="meta">当前未同意入书用途，可先确认内容。</p>${link("调整本人资料用途", "consent")}` : ""}<label class="input-label" for="evidence">本次核对与选择说明</label><textarea id="evidence" class="input" placeholder="请本人记录这次核对与选择的说明"></textarea><div class="mt">${btn("保存这次的两项决定", "decide", "primary", 'style="width:100%"')}</div>` : `<div class="safe-note mt">${icon("shield-check")}<span>故事确认和入书许可由讲述者本人决定。</span></div><div class="mt">${btn("邀请本人核对", "invite")}${link("本人在场，申请当次协助", "assisted")}</div>`}<p class="footnote">保存新文字或照片版本后，需要本人重新确认。改稿不覆盖原声。</p></div>`;
  },
  edit() {
    return `${back("story", "返回故事")}${heading("把记忆里的细节，写准确。", "保存会形成新版本，保留原声；旧确认及受影响的书稿确认将失效。")}<label class="input-label" for="edit-title">故事标题</label><input id="edit-title" class="input" value="${esc(state.title)}" maxlength="80"><label class="input-label" for="edit-body">故事正文</label><textarea id="edit-body" class="input" style="min-height:310px">${esc(state.text)}</textarea><div class="stack mt">${btn("保存为新版本", "save-edit")}${btn("放弃修改，返回故事", "story", "secondary")}</div>`;
  },
  book() {
    return `<div class="book-hero"><figure class="book-art"><img src="assets/book.jpg" alt="妈妈的一生实体书效果示意"><figcaption>实体书效果示意 · 非实际打样</figcaption></figure><div class="stack"><p class="eyebrow">把平凡的日子，装订成礼物</p>${heading("妈妈的一生", "书稿第 " + state.bookVersion + " 版 · 示例书稿")}<p class="subtitle">目录、照片和原声，一起留下来。</p><span class="pill" style="align-self:start">${state.bookIncluded ? 2 : 1} 篇故事可入书</span>${btn("查看书稿，核对这一版", "manuscript")}${link("调整书封与目录", "directory")}</div></div>${state.bookDirty ? `<div class="alert mt">故事或入书选择已变化，当前第 ${state.bookVersion} 版保留原内容。请先生成新版，再重新核对。<div class="mt-sm">${btn("生成新版书稿（演示）", "generate-book")}</div></div>` : ""}<div class="row mt"><h3 class="section-title">本版目录</h3><span class="meta">示例排版</span></div><div class="toc">${state.bookIncluded ? `<div class="toc-row"><span>一 / 童年的小城</span><small>01</small></div><div class="toc-row"><span>${esc(state.title)}</span><small>03</small></div>` : ""}<div class="toc-row"><span>二 / 青春的选择</span><small>05</small></div><div class="toc-row"><span>第一次独自出远门</span><small>07</small></div></div><div class="quiet-panel mt"><h3 class="section-title">离成书，还有哪一步？</h3><div class="confirmation-row">${icon("check")}<span class="grow">讲述者确认本版内容</span><span class="pill ${state.narratorBook ? "" : "pending"}">${state.narratorBook ? "已确认" : "待确认"}</span></div><div class="confirmation-row">${icon("file-text")}<span class="grow">发起人确认本版排版</span><span class="pill ${state.initiatorBook ? "" : "pending"}">${state.initiatorBook ? "已确认" : "待确认"}</span></div><div class="mt">${link("查看首本制作条件", "print")}</div></div><p class="footnote">未确认或未允许入书的故事不进入新书稿。历史确定版本保留各自的内容与授权边界。</p>`;
  },
  manuscript() {
    return `${back("book", "返回成书")}${heading("读一读，这一版的岁月。", `书稿第 ${state.bookVersion} 版 · 示例排版 · 核对的是同一版内容与排版。`)}<div class="book-page"><p class="eyebrow">青春的选择</p><h3>第一次独自出远门</h3><p>第一次离开熟悉的地方时，我把行李检查了一遍又一遍。后来走过很多路，回头想起来，最清楚的还是出发那天。</p><p class="folio">07 / 版式示例</p></div><div class="row mt-sm">${link("上一篇", "preview-prev")}${link("下一篇", "preview-next")}</div><div class="decision-panel"><h3 class="section-title">确认书稿第 ${state.bookVersion} 版</h3><p class="subtitle">${state.role === "narrator" ? "请本人核对本版完整内容。" : "请发起人核对本版排版、目录及照片呈现。"}</p><label class="check-row"><input id="book-confirm" type="checkbox" ${(state.role === "narrator" ? state.narratorBook : state.initiatorBook) ? "checked" : ""}><span>我已核对本版${state.role === "narrator" ? "完整内容" : "排版"}<small>本原型只含节选。正式确认必须提供完整 PDF。</small></span></label>${btn("保存本版确认（演示）", "confirm-book", "primary", 'style="width:100%"')}${link("查看另一方确认与制作条件", "print")}</div>`;
  },
  print() {
    const ready =
      state.narratorBook &&
      state.initiatorBook &&
      state.address &&
      !state.bookDirty;
    return `${back("book", "返回成书")}${heading("把这本书，送到身边。", `首本制作 · 书稿第 ${state.bookVersion} 版`)}<div class="confirmation-row"><span class="grow">讲述者确认同版内容</span><span class="pill ${state.narratorBook ? "" : "pending"}">${state.narratorBook ? "已确认" : "待确认"}</span></div><div class="confirmation-row"><span class="grow">发起人确认同版排版</span><span class="pill ${state.initiatorBook ? "" : "pending"}">${state.initiatorBook ? "已确认" : "待确认"}</span></div><div class="confirmation-row"><span class="grow">发起人确认收货地址</span><span class="pill ${state.address ? "" : "pending"}">${state.address ? "已确认" : "待确认"}</span></div>${state.role === "initiator" ? `<label class="input-label" for="address">收货地址</label><textarea id="address" class="input" placeholder="设计演示请填写虚构地址，不填写真实个人信息"></textarea>${link("确认这份示例地址", "save-address")}` : `<div class="safe-note mt">${icon("shield-check")}<span>收货地址由发起人核对。</span></div>`}<div class="alert mt">当前为内测项目，没有真实付款与实体书生产。首本唯一权益、当前授权和生产状态仍需服务端核验。</div><div class="stack mt">${btn("查看制作申请摘要（演示）", "print-summary", "primary", ready ? "" : "disabled")}${btn("返回核对书稿", "manuscript", "secondary")}</div><p class="footnote">正式状态：PDF 书稿完成 → 已生产 → 已发货。印厂接单不等于已生产，实物完成由运营核实。</p>`;
  },
  account() {
    return `<div class="account-card"><span class="avatar">${state.role === "narrator" ? "林" : "许"}</span><div>${heading(state.role === "narrator" ? "林女士" : "小许")}<p class="meta">${state.role === "narrator" ? "讲述者本人" : "发起人"} · 当前项目：妈妈的一生</p></div></div>${menu("我的项目", "一位讲述者，一本人生书", "projects")}${menu("本人参与与资料用途", "查看和调整用途选择", "consent")}${menu("原声与完整资料", "回听、下载与导出申请", "service")}${menu("首本制作与订单", "查看当前实际进度", "print")}${menu("帮助与服务", "退款、质量售后、撤回和删除", "service")}${menu("账号与跨端绑定", "同一产品账号，授权资料互通", "account-link")}<p class="footnote">制作、回听与下载长期有效。登录、临时下载及客服授权分别有安全有效期。</p>${link("退出当前账号", "logout")}`;
  },
  service() {
    return `${back("account", "返回我的")}${heading("你的资料，始终由你决定。", "长期服务不改变本人授权与主动撤回、删除的选择。")}${menu("回听原声", "按当前授权访问确定版本", "audio-service")}${menu("下载书稿 PDF", "原声、转录与故事分别保留", "download-service")}${menu("申请完整资料包", "本人选接收人，客服核验后交付", "export-service")}${menu("退款与质量售后", "原订单和实际交付事实分别核实", "care-service")}${menu("撤回资料用途", "先停止相应用途，查询处置进度", "withdraw-service")}${menu("申请资料删除", "核验本人意愿与范围后执行", "delete-service")}`;
  },
  invite() {
    return `${back()}${heading("把邀请，送给故事的主人。", "可以分开操作，也可以陪在身边。")}<div class="invite-letter"><p class="eyebrow">一封小小的邀请 / 示例</p><h3 class="question">妈妈，<br>想听你慢慢说。</h3><p>那些讲过的、还没讲过的往事，都值得留成一本书。不必一次说完，想到哪儿，我们就从哪里开始。</p><p style="text-align:right">小许</p></div><div class="stack mt">${btn("预览本人参与页面", "consent")}${btn("本人在场，我来协助操作", "assisted", "secondary")}</div><p class="footnote">网页用项目邀请链接；小程序用微信分享。邀请本身不代表采集、AI 处理、共享或入书授权。</p>`;
  },
  consent() {
    return `${back()}${heading("先说清楚，再慢慢讲。", "由讲述者本人分别选择。不同意某项，相应功能会受到限制，但不会替你默认同意。")}${[
      ["collect", "采集与保存讲述", "录音和照片按本人同意的范围收集与保存。"],
      ["ai", "AI 转写与整理", "保存后调用服务转写和整理，内容仍需本人核对。"],
      ["share", "向发起人共享", "允许发起人在所选范围查看和协助。"],
      [
        "book",
        "用于人生书",
        "这是用途选择；每篇确定故事版本仍需单独决定是否入书。",
      ],
    ]
      .map(
        ([key, title, desc]) =>
          `<section class="consent-item"><strong>${title}</strong><p>${desc}</p><div class="consent-options"><label><input type="radio" name="consent-${key}" value="yes" ${state.consents[key] === "yes" ? "checked" : ""}>同意</label><label><input type="radio" name="consent-${key}" value="no" ${state.consents[key] === "no" ? "checked" : ""}>不同意</label></div></section>`,
      )
      .join(
        "",
      )}<div class="mt">${btn("保存本人用途选择（演示）", "save-consent", "primary", 'style="width:100%"')}</div><p class="footnote">同机协助仍需本人在场并按规则留证。产品账号、操作人和讲述者分别记录。</p>`;
  },
  plan() {
    return `${back()}${heading("想讲的，慢慢排。", "这份大纲可以调整。只修改未来问题，不会改掉已经录下的实际提问。")}<div class="toc mt"><div class="toc-row"><span>一 / 童年的小城</span><small>2 个问题</small></div>${menu("小时候的家，是什么样子的？", "下一个问题", "plan-question")}${state.questionSkipped ? `<p class="meta">菜市场的回忆 · 已标记稍后回答</p>` : menu("和家人去菜市场，记得些什么？", "可以改写、稍后回答或跳过", "plan-skip")}<div class="toc-row"><span>二 / 青春的选择</span><small>1 个问题</small></div>${menu("第一次离家，你还记得吗？", "未来问题", "plan-question")}</div><div class="mt">${btn("添加一个自己的问题", "free", "secondary")}</div>`;
  },
  login() {
    return `<div style="padding-top:38px"><p class="eyebrow">时光里 · 岁月成书</p>${heading(state.loginExpired ? "这份登录链接已失效。" : "打开你的故事书。", state.loginExpired ? "链接可能已使用、过期或被撤销。请联系本次内测负责人重新取得入口。" : "内测参与者通过短期一次性链接进入自己的账号与项目。")}<div class="stack large-space">${btn(state.loginExpired ? "了解如何重新取得入口" : "进入我的故事书（演示）", state.loginExpired ? "login-help" : "project")}${btn(state.loginExpired ? "查看有效链接状态" : "查看链接失效状态", "toggle-login", "secondary")}</div><p class="footnote">这里不显示真实登录票据。正式登录仍通过服务端验证账号和当前授权。</p></div>`;
  },
  marketing() {
    return `<div class="marketing-hero"><div><p class="eyebrow">时光里 / 岁月成书</p><h2 class="page-title mt-sm">把爸妈的故事，<br>留成一本书。</h2><p class="subtitle mt">那些听过的、还没听过的往事，<br>从一次轻松的讲述开始。</p><div class="stack mt">${btn("先看看样书", "sample-book")}${btn("进入内测项目", "login", "secondary")}</div><p class="footnote">正式套餐 999 元 · 一个人生项目与一本实体书<br>当前内测不收款，不安排实体书生产。</p></div><div><img class="marketing-photo" src="assets/book.jpg" alt="人生书效果示意"><p class="sample-indicator">实体书效果示意，非真实打样</p></div></div><div class="divider"></div><h3 class="section-title">一句回忆，一页人生。</h3><p class="subtitle">讲述 → 核对故事 → 双方确认书稿 → 首本制作</p><div class="quiet-panel mt"><div class="row"><h3 class="section-title">岁月成书</h3><span class="price">999<small> 元</small></span></div><p class="subtitle">含一本实体书、书稿 PDF、原声与完整资料导出服务。</p>${link("查看正式购买开放情况", "sale-gate")}</div><p class="footnote">© 2026 千言一语文化传媒有限公司<br>以上内容为设计方案；已有品牌 Logo 与影像素材继续沿用。</p>`;
  },
};
function menu(title, desc, action) {
  return `<button class="menu-row" data-action="${action}"><span style="text-align:left"><span>${title}</span>${desc ? `<span class="meta" style="display:block">${desc}</span>` : ""}</span>${icon("chevron-right")}</button>`;
}
function bindForm() {
  document
    .querySelector("#confirm-content")
    ?.addEventListener("change", (e) => {
      if (!e.target.checked)
        document.querySelector("#allow-book").checked = false;
    });
}
function process() {
  clearTimeout(processingTimeout);
  if (state.failed || state.page !== "processing" || state.progress >= 3)
    return;
  processingTimeout = setTimeout(() => {
    state.progress++;
    render();
    process();
  }, 1700);
}
const actions = {
  close() {
    sheet.close();
  },
  service() {
    go("service");
  },
  choose() {
    go("choose");
  },
  prepare() {
    go("prepare");
  },
  review() {
    go("review");
  },
  project() {
    go("project");
  },
  story() {
    go("story");
  },
  book() {
    go("book");
  },
  manuscript() {
    go("manuscript");
  },
  print() {
    go("print");
  },
  consent() {
    go("consent");
  },
  invite() {
    go("invite");
  },
  plan() {
    go("plan");
  },
  login() {
    go("login");
  },
  edit() {
    go("edit");
  },
  followup() {
    go("followup");
  },
  "start-record"() {
    if (state.role === "initiator" && !state.assisted) {
      actions.assisted();
      return;
    }
    if (!state.authorized) {
      toast("请先完成采集与 AI 用途选择。");
      go("consent");
      return;
    }
    state.paused = false;
    state.seconds = 0;
    go("record");
  },
  pause() {
    state.paused = !state.paused;
    render();
  },
  "stop-record"() {
    sheet.close();
    stopTimers();
    state.recorded = true;
    state.page = "review";
    location.hash = "review";
    render();
  },
  rerecord() {
    modal(
      "重新录这一段？",
      "<p>当前录音先保留。新录音保存成功后，再替换这一段。</p>",
      btn("开始重新录", "confirm-rerecord") +
        btn("保留原录音", "close", "secondary"),
    );
  },
  "confirm-rerecord"() {
    sheet.close();
    state.paused = false;
    state.seconds = 0;
    go("record");
  },
  play() {
    state.playing = !state.playing;
    clearInterval(playerInterval);
    const pressed = state.playing;
    render();
    if (pressed) {
      let v = 0;
      playerInterval = setInterval(() => {
        const r = document.querySelector("#audio-progress");
        if (!r) {
          clearInterval(playerInterval);
          return;
        }
        v += 2;
        r.value = v;
        if (v >= 100) {
          clearInterval(playerInterval);
          state.playing = false;
          render();
        }
      }, 150);
    }
    toast("回听交互示意，无真实音频。");
  },
  submit() {
    state.progress = 1;
    state.failed = state.network === "failed";
    go("processing");
    process();
  },
  "simulate-failure"() {
    clearTimeout(processingTimeout);
    state.failed = true;
    state.progress = 1;
    render();
  },
  retry() {
    state.failed = false;
    state.network = "normal";
    render();
    process();
  },
  organize() {
    if (state.progress < 3) {
      toast("全部选定片段转写就绪后，才能整理。");
      go("processing");
      process();
      return;
    }
    state.storyReady = true;
    go("story");
    toast("示例整理稿已打开，请本人核对。");
  },
  "change-question"() {
    state.topicIndex = (state.topicIndex + 1) % topics.length;
    state.topic = topics[state.topicIndex];
    render();
  },
  "photo-start"() {
    modal(
      "选一张照片，慢慢讲。",
      `<p>真实产品从本人有权使用的照片中选取。本原型仅用已有生成素材示意。</p><img src="assets/family.jpg" alt="亲情效果示意" style="margin-top:20px;border-radius:7px"><p class="meta">效果示意，非真实用户照片</p>`,
      btn("用这张示例图开始", "use-photo"),
    );
  },
  "use-photo"() {
    sheet.close();
    state.photoSelected = true;
    state.source = "photo";
    state.topic = "看着这张照片，你最想说起哪段往事？";
    go("prepare");
  },
  free() {
    modal(
      "从自己想说的开始。",
      `<label class="input-label" for="custom-question">这次想聊什么？</label><textarea id="custom-question" class="input" placeholder="例如，第一次离家的那一天"></textarea><label class="input-label" for="custom-intent">想记录什么</label><input id="custom-intent" class="input" placeholder="例如，当时的心情与陪伴我的人">`,
      btn("从这个问题开始", "use-custom") +
        btn("不写问题，自由讲述", "use-free", "secondary"),
    );
  },
  "use-custom"() {
    const q = document.querySelector("#custom-question").value.trim(),
      intent = document.querySelector("#custom-intent").value.trim();
    if (!q || !intent) {
      toast("请写下问题与想记录的内容。");
      return;
    }
    state.topic = q;
    state.source = "custom";
    sheet.close();
    go("prepare");
  },
  "use-free"() {
    state.topic = "此刻想起的往事，就从这里说起。";
    state.source = "free";
    sheet.close();
    go("prepare");
  },
  "followup-record"() {
    state.topic = "外婆坐在树下择菜时，你们会聊些什么？";
    state.progress = 0;
    go("prepare");
  },
  "rewrite-question"() {
    modal(
      "按自己的问法来。",
      `<textarea id="rewrite" class="input mt">外婆坐在树下择菜时，你们会聊些什么？</textarea>`,
      btn("保存这次实际问题", "save-question"),
    );
  },
  "save-question"() {
    const q = document.querySelector("#rewrite").value.trim();
    if (!q) {
      toast("问题不能为空。");
      return;
    }
    state.topic = q;
    sheet.close();
    go("prepare");
  },
  transcript() {
    modal(
      "原声与正式转录",
      `<p class="sample-indicator">示例，没有真实录音。正式产品在当前授权下播放原声。</p><p>来源：片段 1 · 童年的小城</p><div class="quiet-panel mt-sm"><p>“我小时候住的那个房子，门前有一棵很大的桂花树……放学回来，就搬个小板凳坐在树下，看外婆择菜。”</p></div><p>正式转录和整理稿均可能有误。你可以对照原声校对，原录音始终独立保留。</p>`,
    );
  },
  sources() {
    modal(
      "本版照片与来源",
      "<p>本版关联 1 段示例原声；没有入书照片。添加照片须形成新的故事版本并重新确认。</p>",
    );
  },
  decide() {
    const confirmed = document.querySelector("#confirm-content").checked,
      inclusion = document.querySelector("#allow-book").checked,
      evidence = document.querySelector("#evidence").value.trim();
    if (inclusion && state.consents.book !== "yes") {
      toast("请先明确同意入书用途。");
      return;
    }
    if (inclusion && !confirmed) {
      toast("允许入书前，请先确认这版内容。");
      return;
    }
    if (!evidence) {
      toast("请记录本人这次核对与选择的说明。");
      return;
    }
    const changed =
      state.confirmed !== confirmed || state.inclusion !== inclusion;
    state.confirmed = confirmed;
    state.inclusion = inclusion;
    if (changed) {
      state.narratorBook = false;
      state.initiatorBook = false;
      state.bookDirty = true;
    }
    render();
    toast(
      confirmed
        ? inclusion
          ? "本版已确认，并允许入书（演示）。"
          : "本版已确认，暂不入书（演示）。"
        : "已保存不确认与不入书的选择（演示）。",
    );
  },
  "save-edit"() {
    const title = document.querySelector("#edit-title").value.trim(),
      body = document.querySelector("#edit-body").value.trim();
    if (!title || !body) {
      toast("标题和正文都需要填写。");
      return;
    }
    if (title === state.title && body === state.text) {
      toast("内容没有变化。");
      go("story");
      return;
    }
    state.title = title;
    state.text = body;
    state.version++;
    state.bookDirty = true;
    state.confirmed = false;
    state.inclusion = false;
    state.narratorBook = false;
    state.initiatorBook = false;
    go("story");
    toast("新版本已保存，旧确认已失效（演示）。");
  },
  "confirm-book"() {
    if (state.bookDirty) {
      toast("故事已变化，请先返回成书页生成新版。");
      return;
    }
    if (!document.querySelector("#book-confirm").checked) {
      toast("请先核对并选择本版确认。");
      return;
    }
    if (state.role === "narrator") state.narratorBook = true;
    else state.initiatorBook = true;
    toast(
      `已保存${state.role === "narrator" ? "讲述者内容" : "发起人排版"}确认（演示）。`,
    );
    go("print");
  },
  "save-address"() {
    const address = document.querySelector("#address").value.trim();
    if (address.length < 8) {
      toast("请填写至少 8 个字的虚构完整地址。");
      return;
    }
    state.address = true;
    render();
    toast("已确认示例地址，不连接真实订单。");
  },
  "print-summary"() {
    modal(
      "本版制作申请摘要",
      `<p>书稿第 ${state.bookVersion} 版<br>讲述者内容确认：完成<br>发起人排版确认：完成<br>发起人地址确认：完成</p><p>当前内测未付款，生产关闭。本原型不提交制作申请。</p>`,
    );
  },
  "save-consent"() {
    const choices = {};
    for (const key of ["collect", "ai", "share", "book"]) {
      const val = document.querySelector(
        `input[name="consent-${key}"]:checked`,
      )?.value;
      if (!val) {
        toast("请分别选择四项资料用途，可以选择不同意。");
        return;
      }
      choices[key] = val;
    }
    state.consents = choices;
    state.authorized = choices.collect === "yes" && choices.ai === "yes";
    toast("用途选择已保存（演示）。");
    go(state.authorized ? "prepare" : "project");
  },
  tasks() {
    modal(
      "保存与处理详情",
      '<p>最近一段原声已封存，文字已就绪。当前有 1 篇示例故事待本人核对。</p><details class="mt"><summary>查看历史任务</summary><p>录音转写：已完成<br>故事整理：已完成<br>旧书稿：素材已变化，需重新生成</p></details>',
      btn("核对当前故事", "close-story"),
    );
  },
  "close-story"() {
    sheet.close();
    go("story");
  },
  "other-story"() {
    modal(
      "第一次独自出远门",
      "<p>示例故事第 1 版 · 已确认并允许入书。这份提案的完整核对交互集中在「老屋门前的那棵桂花树」。</p>",
    );
  },
  "filter-all"() {
    state.filter = "all";
    render();
  },
  "filter-pending"() {
    state.filter = "pending";
    render();
  },
  "mic-help"() {
    modal(
      "麦克风打不开？",
      "<p>请检查浏览器或微信的麦克风权限。权限被拒绝后，可前往平台设置重新开启。</p><p>如果录音已保存在本机，优先恢复原录音。本原型不申请麦克风权限。</p>",
    );
  },
  assisted() {
    modal(
      "本人在场，协助操作",
      "<p>请先核对当前操作人与讲述者。协助不自动取得本人授权；采集、故事确认与书稿确认分别按当次规则留证。</p>",
      btn("本人在场，进入本次协助（演示）", "confirm-assisted") +
        btn("查看本人用途选择", "close-consent", "secondary"),
    );
  },
  "confirm-assisted"() {
    state.assisted = true;
    sheet.close();
    go("choose");
  },
  "generate-book"() {
    state.bookVersion++;
    state.bookDirty = false;
    state.bookIncluded = state.confirmed && state.inclusion;
    state.narratorBook = false;
    state.initiatorBook = false;
    render();
    toast("新书稿已生成，请双方核对同版（演示）。");
  },
  "close-consent"() {
    sheet.close();
    go("consent");
  },
  projects() {
    modal(
      "我的故事书",
      `<button class="menu-row" data-action="current-project"><span>妈妈的一生<br><small>当前示例项目</small></span>${icon("check")}</button><p>正式产品只展示当前账号获授权的项目。</p>`,
    );
  },
  "current-project"() {
    sheet.close();
    go("project");
  },
  directory() {
    modal(
      "调整书封与目录",
      '<p>书名、书封照片与目录调整将生成新书稿。原有确定书稿保留原内容，新版需双方重新确认。</p><label class="input-label" for="book-title">书名（布局示意）</label><input class="input" id="book-title" value="妈妈的一生"><p class="meta">只从本人已确认且允许入书的故事和照片中安排。</p>',
    );
  },
  "plan-question"() {
    modal(
      "改写未来的问题",
      `<textarea id="plan-q" class="input mt">${esc(state.topic)}</textarea>`,
      btn("保存未来问题", "save-plan"),
    );
  },
  "save-plan"() {
    const v = document.querySelector("#plan-q").value.trim();
    if (!v) {
      toast("请填写问题。");
      return;
    }
    state.topic = v;
    sheet.close();
    toast("未来问题已调整，已有原声及实际提问不变（演示）。");
  },
  "plan-skip"() {
    modal(
      "这道问题，先放一放。",
      "<p>稍后回答不代表禁问。标为不适用与明确禁问在正式产品中分别记录。</p>",
      btn("标记稍后回答", "skip-plan") +
        btn("标记不适用（示意）", "skip-plan", "secondary"),
    );
  },
  "skip-plan"() {
    state.questionSkipped = true;
    sheet.close();
    render();
  },
  "account-link"() {
    modal(
      "同一账号，两端继续。",
      "<p>网页与小程序资料归属同一个产品账号。绑定前核对目标账号；有冲突时不自动合并。</p><p>微信配置和真实账号互通须单独验证。设计提案不执行绑定。</p>",
    );
  },
  logout() {
    modal(
      "退出当前账号？",
      "<p>正式产品退出会撤销会话，并清理当前设备中的私有页面与缓存。本原型只演示返回登录页。</p>",
      btn("退出（演示）", "confirm-logout") +
        btn("继续使用", "close", "secondary"),
    );
  },
  "confirm-logout"() {
    sheet.close();
    state = initial();
    state.page = "login";
    render();
    location.hash = "login";
  },
  "toggle-login"() {
    state.loginExpired = !state.loginExpired;
    render();
  },
  "login-help"() {
    modal(
      "重新取得内测入口",
      "<p>请联系本次验收负责人续发短期登录链接。不要公开分享个人登录链接，它与项目邀请链接用途不同。</p>",
    );
  },
  "sample-book"() {
    go("manuscript");
  },
  "sale-gate"() {
    modal(
      "正式购买暂未开放",
      "<p>套餐信息用于介绍。真实微信、商户、售卖准入及相关验收通过后，才开放正式下单。</p>",
    );
  },
  "preview-prev"() {
    toast("当前是设计节选的第一篇。");
  },
  "preview-next"() {
    toast("当前提案仅展示这一页节选；正式确认须阅读完整 PDF。");
  },
  "audio-service"() {
    modal(
      "按当前授权回听原声",
      "<p>原声长期保留，是否可访问取决于当前本人授权。临时播放入口失效时，可重新取得有效入口。</p>",
    );
  },
  "download-service"() {
    modal(
      "下载确定版本的书稿",
      "<p>正式产品下载真实完整 PDF；设计提案不生成或下载生产文件。</p>",
    );
  },
  "export-service"() {
    modal(
      "申请完整资料包",
      '<p>本人明确选择接收人，客服核验受理后交付原声、转录、故事、照片、PDF 和对应清单。</p><label class="input-label" for="recipient">接收人</label><select id="recipient" class="input"><option>本人</option><option>发起人（需本人明确选择）</option></select><p class="meta">本原型不创建工单。临时下载授权与长期业务资格分别处理。</p>',
    );
  },
  "care-service"() {
    modal(
      "退款与质量售后",
      "<p>退款按原销售政策及实际支付、权益和生产状态处理；质量售后关联原订单和实际交付版本。退款不自动删除资料。</p>",
    );
  },
  "withdraw-service"() {
    modal(
      "撤回某项资料用途",
      "<p>先明确要停止的用途，再执行相关访问、处理、入书及生产联动，并提供处置进度。不会把撤回误写为全部资料删除。</p>",
    );
  },
  "delete-service"() {
    modal(
      "申请删除资料",
      "<p>明确删除范围、核验本人意愿后进入人工流程。系统分别记录活动数据、文件与外部副本处置。本设计原型不执行删除。</p>",
    );
  },
};
document.addEventListener("click", (e) => {
  const target = e.target.closest("[data-go],[data-action],button[data-view]");
  if (!target || target.disabled) return;
  if (target.dataset.view) {
    state.view = target.dataset.view;
    render();
    return;
  }
  if (target.dataset.go) {
    go(target.dataset.go);
    return;
  }
  actions[target.dataset.action]?.();
});
picker.addEventListener("change", (e) => go(e.target.value));
rolePicker.addEventListener("change", (e) => {
  state.role = e.target.value;
  render();
});
document.querySelector("#reset").addEventListener("click", () => {
  stopTimers();
  sheet.close();
  state = initial();
  location.hash = "project";
  render();
  toast("已重置原型示例。");
});
document.querySelector("#width-picker").addEventListener("change", (e) => {
  state.width = Number(e.target.value);
  device.style.setProperty("--preview-width", e.target.value + "px");
  render();
});
document.querySelector("#network-picker").addEventListener("change", (e) => {
  state.network = e.target.value;
});
window.addEventListener("hashchange", () => {
  const page = location.hash.slice(1);
  if (screens[page] && page !== state.page) go(page);
});
sheet.addEventListener("click", (e) => {
  if (e.target === sheet) sheet.close();
});
const entry = location.hash.slice(1);
if (screens[entry]) state.page = entry;
render();
if (state.page === "record") startTimer();
