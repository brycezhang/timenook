<script setup lang="ts">
import {
  ref,
  computed,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick,
} from "vue";
import Icon from "./Icon.vue";
import GuestHome from "./GuestHome.vue";
import LoginPanel from "./LoginPanel.vue";
import SampleBook from "./SampleBook.vue";
import {
  initialProjects,
  chapters,
  topics,
  type Story,
  type Project,
} from "./data";
type Page =
  "home" | "stories" | "book" | "projects" | "profile" | "story" | "record";
type Modal =
  | "invite"
  | "new"
  | "cover"
  | "nickname"
  | "terms"
  | "address"
  | "login"
  | "sample"
  | null;
type AccountPreview = "guest" | "empty" | "member";
const signedIn = ref(false);
const projects = ref<Project[]>([]);
const selectedId = ref("");
const hasProjects = computed(() => signedIn.value && projects.value.length > 0);
const accountPreview = computed<AccountPreview>(() =>
  !signedIn.value ? "guest" : hasProjects.value ? "member" : "empty",
);
const loginOutcome = ref<"member" | "empty" | "error">("member");
const loginAccepted = ref(false);
const loginBusy = ref(false);
const loginError = ref("");
const termsFromLogin = ref(false);
let loginTimer: ReturnType<typeof setTimeout>;
let pendingDestination: Page | "new" | "invite" = "home";
const project = computed(() =>
  projects.value.find((p) => p.id === selectedId.value)!,
);
const page = ref<Page>("home");
const currentStoryId = ref("s1");
const currentStory = computed(() =>
  project.value.stories.find((s) => s.id === currentStoryId.value),
);
const included = computed(() =>
  project.value.stories.filter((s) => s.included),
);
const totalMinutes = computed(() =>
  project.value.stories.reduce((n, s) => n + s.minutes, 0),
);
const nav = [
  { id: "home", label: "岁月成书", icon: "layout-dashboard" },
  { id: "stories", label: "我的故事", icon: "notebook-pen" },
  { id: "book", label: "我的书稿", icon: "book-open" },
  { id: "projects", label: "我的项目", icon: "layers-2" },
  { id: "profile", label: "我的", icon: "user-round" },
] as const;
const title = computed(
  () =>
    nav.find((n) => n.id === page.value)?.label ??
    (page.value === "record" ? "讲述一个故事" : "故事详情"),
);
const query = ref("");
const filter = ref("全部故事");
const storyFilter = ["全部故事", "已编入书稿", "未编入书稿"];
const visibleStories = computed(() =>
  project.value.stories.filter(
    (s) =>
      (s.title.includes(query.value) || s.chapter.includes(query.value)) &&
      (filter.value === "全部故事" ||
        s.included === (filter.value === "已编入书稿")),
  ),
);
const inviteNotice = ref("");
const modal = ref<Modal>(null);
const dialog = ref<HTMLDialogElement>();
const modalTitle = computed(
  () =>
    ({
      invite: "一起把故事写完整",
      new: "新建一个项目",
      cover: "编辑封面",
      nickname: "修改昵称",
      terms: "使用条款",
      address: "填写收货地址",
      login: "登录，继续你的故事",
      sample: "翻开一本人生故事书",
    })[modal.value ?? "terms"],
);
const toast = ref("");
let toastTimer: ReturnType<typeof setTimeout>;
function inform(message: string) {
  toast.value = message;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (toast.value = ""), 3500);
}
const nickname = ref("时光记录者");
const draftNickname = ref("");
const draftTitle = ref("");
const draftSubtitle = ref("");
const newSubject = ref("妈妈");
const newTitle = ref("");
const address = ref({ name: "", phone: "", region: "", street: "" });
const hasAddress = ref(false);
const customQuestion = ref("");
const topicIndex = ref(0);
const question = computed(
  () => customQuestion.value.trim() || topics[topicIndex.value].question,
);
const recording = ref<
  "ready" | "starting" | "recording" | "paused" | "saved" | "error"
>("ready");
const seconds = ref(0);
const audioUrl = ref("");
const recordingError = ref("");
const timer = computed(
  () =>
    `${Math.floor(seconds.value / 60)
      .toString()
      .padStart(2, "0")}:${(seconds.value % 60).toString().padStart(2, "0")}`,
);
let mediaRecorder: MediaRecorder | undefined;
let stream: MediaStream | undefined;
let interval: ReturnType<typeof setInterval> | undefined;
let alive = true;
const bookReady = ref(false);
const bookGenerating = ref(false);
const readingBook = ref(false);
let generationTimer: ReturnType<typeof setTimeout>;
const editing = ref(false);
const editTitle = ref("");
const editBody = ref("");
function go(target: Page) {
  if (
    ["recording", "paused", "starting"].includes(recording.value) &&
    target !== "record"
  ) {
    inform("请先结束这段录音，再切换页面。");
    return;
  }
  if (editing.value) {
    inform("请先保存或取消故事修改。");
    return;
  }
  if (!signedIn.value && !["home", "profile"].includes(target)) {
    requestLogin(target);
    return;
  }
  page.value = target;
  readingBook.value = false;
  location.hash = target;
  window.scrollTo({ top: 0, behavior: "instant" });
}
function openStory(story: Story) {
  currentStoryId.value = story.id;
  go("story");
}
function selectProject(id: string) {
  signedIn.value = true;
  selectedId.value = id;
  query.value = "";
  filter.value = "全部故事";
  bookReady.value = false;
  go("home");
}
function openModal(kind: Modal) {
  if (kind === "login") {
    requestLogin();
    return;
  }
  if (!signedIn.value && kind && !["terms", "sample"].includes(kind)) {
    requestLogin(kind === "new" ? "new" : "invite");
    return;
  }
  inviteNotice.value = "";
  termsFromLogin.value = kind === "terms" && modal.value === "login";
  draftTitle.value = hasProjects.value ? project.value.title : "";
  draftSubtitle.value = hasProjects.value ? project.value.subtitle : "";
  draftNickname.value = nickname.value;
  modal.value = kind;
  nextTick(() => {
    if (!dialog.value?.open) dialog.value?.showModal();
  });
}
function closeModal() {
  clearTimeout(loginTimer);
  loginBusy.value = false;
  dialog.value?.close();
  modal.value = null;
}
function dialogClosed() {
  clearTimeout(loginTimer);
  loginBusy.value = false;
  modal.value = null;
}
function requestLogin(destination: Page | "new" | "invite" = "home") {
  pendingDestination = destination;
  loginAccepted.value = false;
  loginError.value = "";
  termsFromLogin.value = false;
  modal.value = "login";
  nextTick(() => {
    if (!dialog.value?.open) dialog.value?.showModal();
  });
}
function setAccountPreview(mode: AccountPreview) {
  resetRecording();
  clearTimeout(generationTimer);
  bookGenerating.value = false;
  bookReady.value = false;
  readingBook.value = false;
  editing.value = false;
  query.value = "";
  filter.value = "全部故事";
  editTitle.value = "";
  editBody.value = "";
  address.value = { name: "", phone: "", region: "", street: "" };
  hasAddress.value = false;
  signedIn.value = mode !== "guest";
  projects.value = mode === "member" ? structuredClone(initialProjects) : [];
  selectedId.value = mode === "member" ? "mother" : "";
  currentStoryId.value = "s1";
  const url = new URL(location.href);
  url.searchParams.set("state", mode);
  history.replaceState(null, "", url);
}
function changeAccountPreview(event: Event) {
  const input = event.target as HTMLSelectElement;
  if (
    ["recording", "paused", "starting"].includes(recording.value) ||
    editing.value
  ) {
    input.value = accountPreview.value;
    inform("请先结束录音或保存修改，再切换预览状态。");
    return;
  }
  closeModal();
  setAccountPreview(input.value as AccountPreview);
  go("home");
}
function finishLogin() {
  if (!loginAccepted.value || loginBusy.value) return;
  loginError.value = "";
  loginBusy.value = true;
  loginTimer = setTimeout(() => {
    loginBusy.value = false;
    if (loginOutcome.value === "error") {
      loginError.value = "这次登录未完成，请重试。";
      loginOutcome.value = "member";
      return;
    }
    const destination = pendingDestination;
    setAccountPreview(loginOutcome.value);
    if (destination === "new") {
      go("home");
      openModal("new");
    } else if (destination === "invite" && hasProjects.value) {
      go("home");
      openModal("invite");
    } else {
      closeModal();
      go(destination === "invite" ? "projects" : destination);
    }
  }, 650);
}
function startNewBook() {
  if (!signedIn.value) requestLogin("new");
  else openModal("new");
}
function logoutPreview() {
  setAccountPreview("guest");
  go("home");
}
function handleBackdrop(event: MouseEvent) {
  if (event.target === dialog.value) closeModal();
}
function createProject() {
  const title = newTitle.value.trim();
  const subject = newSubject.value.trim();
  if (!title || !subject) return;
  const id = crypto.randomUUID();
  projects.value.push({
    id,
    title,
    subject,
    subtitle: "每一段讲述，都是值得珍藏的时光。",
    stories: [],
  });
  selectProject(id);
  newTitle.value = "";
  closeModal();
  inform("已创建示例项目");
}
function saveCover() {
  if (!draftTitle.value.trim()) return;
  project.value.title = draftTitle.value.trim();
  project.value.subtitle = draftSubtitle.value.trim();
  bookReady.value = false;
  closeModal();
  inform("封面已更新");
}
function saveNickname() {
  if (!draftNickname.value.trim()) return;
  nickname.value = draftNickname.value.trim();
  closeModal();
  inform("昵称已更新");
}
function startEdit() {
  if (!currentStory.value) return;
  editTitle.value = currentStory.value.title;
  editBody.value = currentStory.value.paragraphs.join("\n\n");
  editing.value = true;
}
function saveEdit() {
  if (!currentStory.value || !editTitle.value.trim() || !editBody.value.trim())
    return;
  currentStory.value.title = editTitle.value.trim();
  currentStory.value.paragraphs = editBody.value.trim().split(/\n\s*\n/);
  editing.value = false;
  bookReady.value = false;
  inform("故事修改已保存");
}
function toggleInclusion() {
  if (!currentStory.value) return;
  currentStory.value.included = !currentStory.value.included;
  bookReady.value = false;
  inform(
    currentStory.value.included ? "已编入书稿" : "已移出书稿，故事仍然保留",
  );
}
function startStory() {
  resetRecording();
  customQuestion.value = "";
  go("record");
}
function resetRecording() {
  clearInterval(interval);
  if (mediaRecorder) {
    mediaRecorder.onstop = null;
    mediaRecorder.onerror = null;
    mediaRecorder.ondataavailable = null;
    if (mediaRecorder.state !== "inactive") mediaRecorder.stop();
  }
  stream?.getTracks().forEach((t) => t.stop());
  mediaRecorder = undefined;
  stream = undefined;
  recording.value = "ready";
  seconds.value = 0;
  recordingError.value = "";
  if (audioUrl.value) URL.revokeObjectURL(audioUrl.value);
  audioUrl.value = "";
}
async function startRecording() {
  recordingError.value = "";
  recording.value = "starting";
  try {
    if (!navigator.mediaDevices?.getUserMedia)
      throw Error("请使用支持录音的浏览器，并通过 HTTPS 或 localhost 打开。");
    const input = await navigator.mediaDevices.getUserMedia({ audio: true });
    if (!alive) {
      input.getTracks().forEach((t) => t.stop());
      return;
    }
    stream = input;
    mediaRecorder = new MediaRecorder(input);
    const chunks: BlobPart[] = [];
    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size) chunks.push(e.data);
    };
    mediaRecorder.onstop = () => {
      if (!alive) return;
      if (audioUrl.value) URL.revokeObjectURL(audioUrl.value);
      audioUrl.value = URL.createObjectURL(
        new Blob(chunks, { type: mediaRecorder?.mimeType ?? "audio/webm" }),
      );
      recording.value = "saved";
      clearInterval(interval);
      stream?.getTracks().forEach((t) => t.stop());
    };
    mediaRecorder.onerror = () => {
      recordingError.value = "录音中断，请检查麦克风后重试。";
      recording.value = "error";
      clearInterval(interval);
      stream?.getTracks().forEach((t) => t.stop());
    };
    mediaRecorder.start();
    recording.value = "recording";
    interval = setInterval(() => {
      if (recording.value === "recording") seconds.value++;
      if (seconds.value >= 300) finishRecording();
    }, 1000);
  } catch (e) {
    recording.value = "error";
    recordingError.value =
      e instanceof DOMException && e.name === "NotAllowedError"
        ? "麦克风未获授权，请在浏览器设置中允许后重试。"
        : e instanceof Error
          ? e.message
          : "麦克风暂时无法使用，请重试。";
  }
}
function pauseRecording() {
  if (recording.value === "recording") {
    mediaRecorder?.pause();
    recording.value = "paused";
  } else {
    mediaRecorder?.resume();
    recording.value = "recording";
  }
}
function finishRecording() {
  if (mediaRecorder?.state !== "inactive") mediaRecorder?.stop();
}
function generateBook() {
  if (!included.value.length) {
    inform("先讲述一个故事，再来生成书稿。");
    return;
  }
  bookGenerating.value = true;
  generationTimer = setTimeout(() => {
    bookGenerating.value = false;
    bookReady.value = true;
    inform("示例书稿已就绪，可打开阅读");
  }, 1200);
}
function saveAddress() {
  hasAddress.value = true;
  closeModal();
  inform("示例收货地址已保存");
}
function readHash() {
  const value = location.hash.slice(1) as Page;
  if (["home", "stories", "book", "projects", "profile"].includes(value))
    go(value);
}
onMounted(() => {
  const state = new URLSearchParams(location.search).get("state");
  if (state === "member" || state === "empty") setAccountPreview(state);
  readHash();
  window.addEventListener("hashchange", readHash);
});
onBeforeUnmount(() => {
  alive = false;
  window.removeEventListener("hashchange", readHash);
  clearTimeout(toastTimer);
  clearTimeout(loginTimer);
  clearTimeout(generationTimer);
  resetRecording();
});
watch(modal, (value) => document.body.classList.toggle("dialog-open", !!value));
</script>

<template>
  <a class="skip-link" href="#main-content">跳到主要内容</a>
  <aside class="sidebar">
    <a class="brand" href="#home" @click.prevent="go('home')"
      ><span class="brand-mark"><Icon name="book-open" :size="23" /></span
      ><span>时光故事<small>让回忆，有迹可循</small></span></a
    >
    <button v-if="hasProjects" class="project-switch" @click="go('projects')">
      <span class="project-initial">{{ project.subject.slice(0, 1) }}</span
      ><span class="truncate">{{ project.title }}<small>当前项目</small></span
      ><Icon name="chevrons-up-down" :size="15" />
    </button>
    <button v-else class="guest-sidebar-card" @click="startNewBook">
      <Icon name="book-open" :size="25" /><span
        >一本书，珍藏一生<small>从一段讲述开始</small></span
      ><Icon name="plus" :size="16" />
    </button>
    <p class="nav-caption">{{ signedIn ? "我的创作空间" : "时光故事" }}</p>
    <nav aria-label="主导航">
      <a
        v-for="item in nav"
        :key="item.id"
        :href="`#${item.id}`"
        :class="{
          active:
            page === item.id || (item.id === 'stories' && page === 'story'),
        }"
        :aria-current="page === item.id ? 'page' : undefined"
        @click.prevent="go(item.id)"
        ><Icon :name="item.icon" /><span>{{ item.label }}</span
        ><span v-if="hasProjects && item.id === 'stories'" class="nav-count">{{
          project.stories.length
        }}</span></a
      >
    </nav>
    <div class="sidebar-bottom">
      <div class="quiet-note">
        <Icon name="heart" :size="19" />
        <p>不必一次讲完，<br />好故事，值得慢慢来。</p>
      </div>
      <button
        class="sidebar-profile"
        @click="signedIn ? go('profile') : requestLogin()"
      >
        <span class="avatar"
          ><template v-if="signedIn">时</template
          ><Icon v-else name="user-round" :size="17" /></span
        ><span
          >{{ signedIn ? nickname : "登录 / 开始记录"
          }}<small>{{
            signedIn ? "我的账号" : "让故事，在这里继续"
          }}</small></span
        ><Icon name="chevron-right" :size="16" />
      </button>
    </div>
  </aside>
  <div class="workspace">
    <header class="topbar">
      <div class="breadcrumb">
        <span class="desktop-only">创作空间</span
        ><Icon name="chevron-right" :size="14" class="desktop-only" /><span>{{
          title
        }}</span>
      </div>
      <a class="mobile-brand" href="#home" @click.prevent="go('home')"
        >时光故事</a
      >
      <div class="topbar-actions">
        <span class="preview-badge">设计预览</span>
        <details class="preview-controls">
          <summary><Icon name="settings" :size="15" />状态预览</summary>
          <div class="preview-controls-panel">
            <label
              >账号状态<select
                aria-label="预览账号状态"
                :value="accountPreview"
                @change="changeAccountPreview"
              >
                <option value="guest">未登录</option>
                <option value="empty">已登录 · 暂无项目</option>
                <option value="member">已登录 · 已有项目</option>
              </select></label
            ><label
              >登录演示结果<select
                v-model="loginOutcome"
                aria-label="登录演示结果"
              >
                <option value="member">成功 · 已有项目</option>
                <option value="empty">成功 · 暂无项目</option>
                <option value="error">失败一次，再重试成功</option>
              </select></label
            >
            <p>仅切换示例状态，不连接真实账号。</p>
          </div>
        </details>
        <button
          v-if="hasProjects"
          class="icon-button desktop-only"
          aria-label="邀请家人"
          @click="openModal('invite')"
        >
          <Icon name="user-round-plus" /></button
        ><button
          v-if="signedIn"
          class="avatar top-avatar"
          aria-label="打开我的账号"
          @click="go('profile')"
        >
          时</button
        ><button v-else class="button header-login" @click="requestLogin()">
          登录
        </button>
      </div>
    </header>
    <main
      id="main-content"
      :class="['main-content', { 'reading-layout': page === 'story' }]"
      tabindex="-1"
      :data-screen-label="title"
    >
      <GuestHome
        v-if="page === 'home' && !hasProjects"
        :signed-in="signedIn"
        :nickname="nickname"
        @start="startNewBook"
        @login="requestLogin()"
        @sample="openModal('sample')"
        @terms="openModal('terms')"
      />
      <template
        v-else-if="
          !hasProjects && ['stories', 'book', 'projects'].includes(page)
        "
        ><div class="page-heading">
          <div>
            <p class="eyebrow">你的创作空间</p>
            <h1>{{ title }}</h1>
          </div>
        </div>
        <section class="empty-state panel account-empty">
          <Icon
            :name="
              page === 'book'
                ? 'book-open'
                : page === 'stories'
                  ? 'notebook-pen'
                  : 'layers-2'
            "
            :size="42"
          />
          <h2>
            {{
              page === "book"
                ? "你的第一本书，还在等故事"
                : page === "stories"
                  ? "先有一个项目，再留下第一篇故事"
                  : "还没有人生项目"
            }}
          </h2>
          <p>新建一本故事书，开始为重要的人记录。</p>
          <button class="button" @click="startNewBook">
            <Icon name="plus" :size="17" />开始一本故事书
          </button>
          <p class="empty-invitation">
            收到家人的邀请？从他们分享的邀请链接加入。
          </p>
        </section></template
      >
      <template v-else-if="page === 'home'">
        <div class="page-heading">
          <div>
            <p class="eyebrow">每一段平凡的往事，都值得被记住</p>
            <h1>把往事，慢慢写成书。</h1>
            <p class="muted">从一次讲述开始，让熟悉的声音和故事长久相伴。</p>
          </div>
          <button
            class="button outline invite-button"
            @click="openModal('invite')"
          >
            <Icon name="user-round-plus" :size="17" />邀请家人
          </button>
        </div>
        <section class="project-hero">
          <div class="hero-copy">
            <span class="badge"><span class="status-dot"></span>正在记录</span>
            <div>
              <p class="overline">一本关于{{ project.subject }}的故事书</p>
              <h2>{{ project.title }}</h2>
              <p class="muted">{{ project.subtitle }}</p>
            </div>
            <div class="hero-stats">
              <div>
                <strong>{{ project.stories.length }}</strong
                ><span>篇故事</span>
              </div>
              <div>
                <strong>{{ totalMinutes }}</strong
                ><span>分钟原声</span>
              </div>
              <div>
                <strong>{{ included.length }}</strong
                ><span>篇已入书</span>
              </div>
            </div>
            <div class="hero-actions">
              <button class="button" @click="startStory">
                <Icon name="mic" :size="18" />开始讲述</button
              ><button class="button ghost" @click="go('book')">
                查看书稿<Icon name="arrow-up-right" :size="17" />
              </button>
            </div>
          </div>
          <div class="hero-image">
            <img
              v-if="project.id === 'mother'"
              src="assets/book.jpg"
              alt="妈妈的一生，精装故事书效果示意"
            />
            <div v-else class="mini-cover hero-text-cover">
              <span>时光故事</span>
              <h2>{{ project.title }}</h2>
              <Icon name="sprout" :size="28" /><small>爱与岁月的故事</small>
            </div>
            <span>装帧效果示意</span>
          </div>
        </section>
        <div class="home-lower">
          <section class="recent-section">
            <div class="section-heading">
              <h2>
                最近的故事<span class="small-count">{{
                  project.stories.length
                }}</span>
              </h2>
              <button class="text-button" @click="go('stories')">
                查看全部<Icon name="arrow-right" :size="16" />
              </button>
            </div>
            <div v-if="project.stories.length" class="recent-list">
              <button
                v-for="(story, index) in project.stories.slice(0, 3)"
                :key="story.id"
                class="recent-story"
                @click="openStory(story)"
              >
                <span class="story-number">0{{ index + 1 }}</span>
                <div class="story-summary">
                  <span class="story-chapter">{{ story.chapter }}</span>
                  <h3>{{ story.title }}</h3>
                  <p>
                    {{ story.date }}<span>·</span>{{ story.minutes }} 分钟讲述
                  </p>
                </div>
                <Icon name="chevron-right" :size="18" />
              </button>
            </div>
            <div v-else class="empty-state compact">
              <Icon name="notebook-pen" :size="32" />
              <h3>第一篇故事，等你来讲</h3>
              <p>不必想好开头，聊一段熟悉的往事就好。</p>
              <button class="button outline" @click="startStory">
                开始第一个故事
              </button>
            </div>
          </section>
          <aside class="prompt-card">
            <span class="prompt-icon"><Icon name="sprout" :size="22" /></span>
            <p class="overline">今天，不妨聊聊</p>
            <h2>{{ topics[topicIndex].question }}</h2>
            <p>{{ topics[topicIndex].hint }}</p>
            <button class="text-button" @click="startStory">
              从这里开始<Icon name="arrow-up-right" :size="16" /></button
            ><button
              class="change-topic"
              @click="topicIndex = (topicIndex + 1) % topics.length"
            >
              <Icon name="refresh-cw" :size="14" />换个话题
            </button>
          </aside>
        </div>
        <footer class="page-footer">
          <Icon name="lock-keyhole" :size="14" /><span
            >故事与原声，仅对项目成员可见</span
          >
        </footer>
      </template>

      <template v-else-if="page === 'stories'">
        <div class="page-heading">
          <div>
            <p class="eyebrow">{{ project.title }}</p>
            <h1>每一段，都是人生。</h1>
            <p class="muted">
              {{ project.stories.length }} 篇故事，{{ totalMinutes }}
              分钟值得珍藏的声音。
            </p>
          </div>
          <button class="button" @click="startStory">
            <Icon name="plus" :size="18" />再记一个故事
          </button>
        </div>
        <div class="story-toolbar">
          <div class="segmented" aria-label="筛选故事">
            <button
              v-for="item in storyFilter"
              :key="item"
              :class="{ selected: filter === item }"
              :aria-pressed="filter === item"
              @click="filter = item"
            >
              {{ item }}
            </button>
          </div>
          <label class="search-field"
            ><Icon name="search" :size="17" /><input
              v-model="query"
              type="search"
              aria-label="搜索故事"
              placeholder="搜索故事…"
          /></label>
        </div>
        <div v-if="visibleStories.length" class="story-grid">
          <button
            v-for="(story, index) in visibleStories"
            :key="story.id"
            class="story-card"
            @click="openStory(story)"
          >
            <div class="story-card-top">
              <span class="story-chapter">{{ story.chapter }}</span
              ><span class="badge" :class="{ neutral: !story.included }">{{
                story.included ? "已编入书稿" : "未编入书稿"
              }}</span>
            </div>
            <span class="card-index">{{
              String(index + 1).padStart(2, "0")
            }}</span>
            <h2>{{ story.title }}</h2>
            <p class="story-excerpt">{{ story.paragraphs[0] }}</p>
            <div class="story-card-footer">
              <span>{{ story.date }}</span
              ><span
                ><Icon name="audio-lines" :size="15" />{{
                  story.minutes
                }}
                分钟</span
              ><Icon name="arrow-up-right" :size="17" />
            </div>
          </button>
        </div>
        <div v-else class="empty-state">
          <Icon name="notebook-pen" :size="36" />
          <h2>{{ query ? "没有找到这段故事" : "故事，从开口的那一刻开始" }}</h2>
          <p>
            {{
              query
                ? "试试其他关键词，或查看全部故事。"
                : "选一个想聊的话题，慢慢说就好。"
            }}
          </p>
          <button
            class="button outline"
            @click="query ? (query = '') : startStory()"
          >
            {{ query ? "清除搜索" : "开始讲述" }}
          </button>
        </div>
      </template>

      <template v-else-if="page === 'story' && currentStory">
        <div class="reader-toolbar">
          <button class="text-button" @click="go('stories')">
            <Icon name="arrow-left" :size="17" />返回故事
          </button>
          <div class="row">
            <span class="badge" :class="{ neutral: !currentStory.included }">{{
              currentStory.included ? "已编入书稿" : "未编入书稿"
            }}</span
            ><button
              v-if="!editing"
              class="button outline small-button"
              @click="startEdit"
            >
              <Icon name="pencil" :size="16" />编辑故事
            </button>
          </div>
        </div>
        <article v-if="!editing" class="story-reader">
          <p class="eyebrow">
            {{ currentStory.chapter }}<span> / </span>人生里的一个片段
          </p>
          <h1>{{ currentStory.title }}</h1>
          <p class="reading-meta">
            {{ project.subject }}的讲述<span>·</span>{{ currentStory.date
            }}<span>·</span>{{ currentStory.minutes }} 分钟原声
          </p>
          <div class="reading-rule"></div>
          <img
            v-if="currentStory.photo"
            :src="currentStory.photo"
            class="inline-photo"
            alt="家人相伴的时刻，示例照片"
          />
          <div class="prose">
            <p v-for="paragraph in currentStory.paragraphs" :key="paragraph">
              {{ paragraph }}
            </p>
          </div>
          <p class="story-end">— {{ project.subject }}的故事，还在继续 —</p>
        </article>
        <form v-else class="story-editor panel" @submit.prevent="saveEdit">
          <label
            >故事标题<input
              v-model="editTitle"
              required
              maxlength="100" /></label
          ><label
            >故事正文<textarea v-model="editBody" required rows="15"></textarea>
          </label>
          <div class="row">
            <button class="button" type="submit">保存修改</button
            ><button
              class="button outline"
              type="button"
              @click="editing = false"
            >
              取消
            </button>
          </div>
        </form>
        <div v-if="!editing" class="reader-actions">
          <button class="button outline" @click="toggleInclusion">
            <Icon
              :name="currentStory.included ? 'book-minus' : 'book-plus'"
              :size="18"
            />{{ currentStory.included ? "移出书稿" : "编入书稿" }}</button
          ><button class="button" @click="startStory">
            <Icon name="mic" :size="18" />再讲一个故事
          </button>
        </div>
        <p v-if="!editing" class="prototype-note">
          这里展示示例正文。真实原声播放与补充讲述将在业务接入后提供。
        </p>
      </template>

      <template v-else-if="page === 'record'">
        <div class="reader-toolbar">
          <button class="text-button" @click="go('home')">
            <Icon name="arrow-left" :size="17" />返回</button
          ><span class="muted text-sm">慢慢讲，我们在听</span>
        </div>
        <div class="record-layout">
          <section class="record-card">
            <span class="badge neutral">{{ topics[topicIndex].chapter }}</span>
            <h1>{{ question }}</h1>
            <p class="muted">{{ topics[topicIndex].hint }}</p>
            <div
              class="record-stage"
              :class="{ live: recording === 'recording' }"
            >
              <div class="mic-orbit">
                <Icon
                  :name="
                    recording === 'saved'
                      ? 'check'
                      : recording === 'paused'
                        ? 'pause'
                        : 'mic'
                  "
                  :size="36"
                />
              </div>
              <strong class="record-timer">{{ timer }}</strong
              ><span class="record-caption">{{
                recording === "recording"
                  ? "正在录音…"
                  : recording === "paused"
                    ? "已暂停，想好了再继续"
                    : recording === "saved"
                      ? "录音已保留在本页"
                      : recording === "starting"
                        ? "正在打开麦克风…"
                        : "准备好了，就开始讲述"
              }}</span>
              <div
                class="waveform"
                :class="{ moving: recording === 'recording' }"
                aria-hidden="true"
              >
                <i
                  v-for="n in 29"
                  :key="n"
                  :style="{
                    '--bar-height': `${8 + ((n * 17) % 31)}px`,
                    '--bar-delay': `${n * -0.1}s`,
                  }"
                ></i>
              </div>
            </div>
            <p v-if="recordingError" class="error-message" role="alert">
              {{ recordingError }}
            </p>
            <div class="record-actions">
              <template
                v-if="['ready', 'error', 'starting'].includes(recording)"
                ><button
                  class="button"
                  :disabled="recording === 'starting'"
                  @click="startRecording"
                >
                  <Icon name="mic" :size="18" />{{
                    recording === "starting" ? "正在准备…" : "开始录音"
                  }}
                </button></template
              ><template
                v-else-if="recording === 'recording' || recording === 'paused'"
                ><button class="button outline" @click="pauseRecording">
                  <Icon
                    :name="recording === 'paused' ? 'play' : 'pause'"
                    :size="17"
                  />{{
                    recording === "paused" ? "继续录音" : "暂停一下"
                  }}</button
                ><button class="button" @click="finishRecording">
                  <Icon name="square" :size="16" />结束录音
                </button></template
              ><template v-else
                ><audio
                  :src="audioUrl"
                  controls
                  aria-label="回听刚才的录音"
                ></audio
                ><button class="button outline" @click="resetRecording">
                  重新录制
                </button></template
              >
            </div>
            <p class="record-notice">
              <Icon name="lock-keyhole" :size="14" />{{
                recording === "saved"
                  ? "设计预览仅本页回听，未上传。离开或刷新后不保留。"
                  : "设计预览可体验麦克风录音，最长 5 分钟；不会上传。"
              }}
            </p>
          </section>
          <aside class="record-tips">
            <h2>从熟悉的小事说起</h2>
            <p>不必按时间顺序，也不必字斟句酌。想到哪里，就讲到哪里。</p>
            <div class="tips-divider"></div>
            <label
              >也可以聊一个自己的话题<textarea
                v-model="customQuestion"
                rows="3"
                placeholder="此刻，你最想记住什么？"
                :disabled="!['ready', 'error'].includes(recording)"
              ></textarea></label
            ><button
              class="text-button"
              :disabled="!['ready', 'error'].includes(recording)"
              @click="
                topicIndex = (topicIndex + 1) % topics.length;
                customQuestion = '';
              "
            >
              <Icon name="refresh-cw" :size="15" />换个话题
            </button>
          </aside>
        </div>
      </template>

      <template v-else-if="page === 'book'">
        <div class="page-heading">
          <div>
            <p class="eyebrow">{{ project.title }}</p>
            <h1>让故事，有一本书的模样。</h1>
            <p class="muted">
              {{ included.length }} 篇故事已编入书稿，每一次讲述，都让它更完整。
            </p>
          </div>
          <button class="button outline" @click="openModal('cover')">
            <Icon name="pencil" :size="16" />编辑封面
          </button>
        </div>
        <template v-if="!readingBook"
          ><div class="book-layout">
            <section class="book-preview">
              <div class="cover-mock">
                <p class="cover-eyebrow">时光故事 · 岁月成书</p>
                <div>
                  <h2>{{ project.title }}</h2>
                  <div class="cover-rule"></div>
                  <p>{{ project.subtitle }}</p>
                </div>
                <div class="cover-ornament">
                  <img
                    class="cover-portrait"
                    src="assets/family.jpg"
                    alt="家人合照，封面图片示意"
                  />
                </div>
                <p class="cover-credit">
                  {{ project.subject }}的讲述 · 家人的珍藏
                </p>
              </div>
              <span class="text-sm muted">封面设计预览</span>
            </section>
            <section class="book-directory panel">
              <div class="section-heading">
                <h2>书里的故事</h2>
                <span class="text-sm muted">{{ included.length }} 篇</span>
              </div>
              <div
                v-for="(chapter, index) in chapters"
                :key="chapter"
                class="chapter"
              >
                <div class="chapter-heading">
                  <span>0{{ index + 1 }}</span>
                  <h3>{{ chapter }}</h3>
                  <small
                    >{{
                      included.filter((s) => s.chapter === chapter).length
                    }}
                    篇</small
                  >
                </div>
                <button
                  v-for="story in included.filter((s) => s.chapter === chapter)"
                  :key="story.id"
                  class="chapter-story"
                  @click="openStory(story)"
                >
                  {{ story.title }}<Icon name="chevron-right" :size="15" />
                </button>
                <p
                  v-if="!included.some((s) => s.chapter === chapter)"
                  class="chapter-empty"
                >
                  等待这一章的故事
                </p>
              </div>
              <button class="text-button" @click="go('stories')">
                <Icon name="plus" :size="15" />管理入书故事
              </button>
            </section>
          </div>
          <div class="book-action-bar panel">
            <div>
              <h3>
                {{
                  bookReady
                    ? "示例书稿已就绪"
                    : "把讲过的故事，翻成可阅读的书稿"
                }}
              </h3>
              <p>封面和故事修改后，可以重新生成。</p>
            </div>
            <button
              class="button"
              :disabled="bookGenerating || !included.length"
              @click="bookReady ? (readingBook = true) : generateBook()"
            >
              <Icon
                :name="
                  bookGenerating
                    ? 'loader-circle'
                    : bookReady
                      ? 'book-open'
                      : 'sparkles'
                "
                :class="{ spin: bookGenerating }"
                :size="18"
              />{{
                bookGenerating
                  ? "正在整理书稿…"
                  : bookReady
                    ? "打开书稿"
                    : "生成书稿预览"
              }}
            </button>
          </div>
          <div class="print-note">
            <Icon name="package" :size="20" />
            <div>
              <strong>准备好把故事捧在手里了吗？</strong>
              <p>书稿就绪后，再填写收货地址并提交印刷。</p>
            </div>
            <button class="text-button" @click="openModal('address')">
              {{ hasAddress ? "查看地址" : "填写地址"
              }}<Icon name="arrow-right" :size="16" />
            </button></div
        ></template>
        <template v-else
          ><div class="reader-toolbar">
            <button class="text-button" @click="readingBook = false">
              <Icon name="arrow-left" :size="17" />返回书稿</button
            ><span class="badge neutral">示例书稿 · 网页阅读</span>
          </div>
          <article class="book-reader">
            <h1>{{ project.title }}</h1>
            <section v-for="story in included" :key="story.id">
              <span class="eyebrow">{{ story.chapter }}</span>
              <h2>{{ story.title }}</h2>
              <div class="prose">
                <p v-for="paragraph in story.paragraphs" :key="paragraph">
                  {{ paragraph }}
                </p>
              </div>
            </section>
          </article></template
        >
      </template>

      <template v-else-if="page === 'projects'">
        <div class="page-heading">
          <div>
            <p class="eyebrow">每一个重要的人，都有一本书</p>
            <h1>我的项目</h1>
            <p class="muted">一起记录，一起珍藏。</p>
          </div>
          <button class="button" @click="openModal('new')">
            <Icon name="plus" :size="18" />新建项目
          </button>
        </div>
        <div class="projects-grid">
          <article
            v-for="item in projects"
            :key="item.id"
            class="project-card panel"
          >
            <div
              class="project-card-art"
              :class="{ father: item.id === 'father' }"
            >
              <div class="mini-cover">
                <span>时光故事</span>
                <h2>{{ item.title }}</h2>
                <Icon name="sprout" :size="28" /><small>爱与岁月的故事</small>
              </div>
            </div>
            <div class="project-card-body">
              <div class="section-heading">
                <span class="badge neutral">记录中</span
                ><span v-if="item.id === selectedId" class="current-label"
                  ><Icon name="check" :size="14" />当前项目</span
                >
              </div>
              <h2>{{ item.title }}</h2>
              <p>
                {{
                  item.stories.length
                    ? `已留下 ${item.stories.length} 篇故事`
                    : "从第一段讲述开始"
                }}
              </p>
              <button
                class="button outline full-width"
                @click="selectProject(item.id)"
              >
                打开项目<Icon name="arrow-right" :size="16" />
              </button>
            </div>
          </article>
          <button class="new-project-card" @click="openModal('new')">
            <span class="new-project-plus"
              ><Icon name="plus" :size="26"
            /></span>
            <h2>再为一位重要的人</h2>
            <p>留下属于他的故事</p>
          </button>
        </div>
      </template>

      <template v-else-if="page === 'profile'">
        <div class="page-heading">
          <div>
            <p class="eyebrow">相伴的日子，值得珍藏</p>
            <h1>我的</h1>
          </div>
        </div>
        <section v-if="!signedIn" class="guest-profile-card panel">
          <span class="avatar large-avatar"
            ><Icon name="user-round" :size="30"
          /></span>
          <h2>登录，收藏你的时光</h2>
          <p>查看你的项目，让每一次讲述都能继续。</p>
          <button class="button" @click="requestLogin('profile')">
            登录 / 开始记录<Icon name="arrow-right" :size="16" />
          </button>
        </section>
        <section v-else class="profile-card panel">
          <span class="avatar large-avatar">{{ nickname.slice(0, 1) }}</span>
          <div>
            <button class="nickname-button" @click="openModal('nickname')">
              {{ nickname }}<Icon name="pencil" :size="16" />
            </button>
            <p class="muted">记录故事，也收藏时光。</p>
          </div>
        </section>
        <div class="profile-links panel">
          <button @click="go('projects')">
            <span class="profile-link-icon"><Icon name="layers-2" /></span
            ><span>我的项目<small>管理购买与参与的故事书</small></span
            ><Icon name="chevron-right" :size="18" /></button
          ><button v-if="hasProjects" @click="openModal('invite')">
            <span class="profile-link-icon"
              ><Icon name="user-round-plus" /></span
            ><span>邀请家人<small>一起记录同一本人生书</small></span
            ><Icon name="chevron-right" :size="18" /></button
          ><button @click="openModal('terms')">
            <span class="profile-link-icon"><Icon name="file-text" /></span
            ><span>使用条款<small>资料、服务与售后约定</small></span
            ><Icon name="chevron-right" :size="18" />
          </button>
        </div>
        <button
          v-if="signedIn"
          class="button outline logout-preview"
          @click="logoutPreview"
        >
          退出登录
        </button>
        <p class="profile-brand">时光故事<span>让回忆，有迹可循</span></p>
      </template>
    </main>
  </div>
  <nav class="mobile-nav" aria-label="手机导航">
    <a
      v-for="item in nav"
      :key="item.id"
      :href="`#${item.id}`"
      :class="{
        active:
          page === item.id ||
          (item.id === 'stories' && ['story', 'record'].includes(page)),
      }"
      :aria-current="page === item.id ? 'page' : undefined"
      @click.prevent="go(item.id)"
      ><Icon :name="item.icon" :size="21" /><span>{{
        item.id === "profile"
          ? "我的"
          : item.label === "岁月成书"
            ? "首页"
            : item.label.replace("我的", "")
      }}</span></a
    >
  </nav>
  <Transition name="toast"
    ><div v-if="toast" class="toast-message" role="status">
      <Icon name="check" :size="18" />{{ toast }}
    </div></Transition
  >
  <dialog
    ref="dialog"
    class="modal"
    :class="{
      'sample-modal': modal === 'sample',
      'login-modal': modal === 'login',
    }"
    aria-labelledby="modal-title"
    @close="dialogClosed"
    @click="handleBackdrop"
  >
    <div class="modal-header">
      <div>
        <p class="eyebrow">时光故事</p>
        <h2 id="modal-title">{{ modalTitle }}</h2>
      </div>
      <button class="icon-button" aria-label="关闭弹窗" @click="closeModal">
        <Icon name="x" />
      </button>
    </div>
    <LoginPanel
      v-if="modal === 'login'"
      v-model:accepted="loginAccepted"
      :busy="loginBusy"
      :error="loginError"
      @submit="finishLogin"
      @terms="openModal('terms')"
      @cancel="closeModal"
    />
    <SampleBook v-else-if="modal === 'sample'" />
    <template v-else-if="modal === 'invite'"
      ><div class="invite-visual"><Icon name="users-round" :size="38" /></div>
      <p class="modal-description">
        邀请家人加入「{{
          project.title
        }}」，一起讲述、编辑故事，完成这本人生书。
      </p>
      <div class="info-box">
        <Icon name="shield-check" :size="20" />
        <p>加入后的成员拥有完整项目功能。<br />只邀请你信任的人。</p>
      </div>
      <button
        class="button full-width"
        @click="
          inviteNotice = '设计预览尚未生成邀请链接；业务接入后由服务端签发。'
        "
      >
        <Icon name="link" :size="18" />生成邀请链接
      </button>
      <p
        v-if="inviteNotice"
        class="form-note"
        role="status"
        style="margin-top: 14px"
      >
        {{ inviteNotice }}
      </p></template
    >
    <form v-else-if="modal === 'new'" @submit.prevent="createProject">
      <p class="modal-description">每一本书，都是送给重要的人的礼物。</p>
      <label
        >为谁记录<input
          v-model="newSubject"
          required
          maxlength="20"
          placeholder="例如：妈妈、爸爸，或自己" /></label
      ><label
        >给这本书起个名字<input
          v-model="newTitle"
          required
          maxlength="80"
          :placeholder="`${newSubject || '妈妈'}的一生`"
      /></label>
      <p class="form-note">设计预览会创建示例项目，不产生订单或付款。</p>
      <button class="button full-width" type="submit">
        创建示例项目<Icon name="arrow-right" :size="17" />
      </button>
    </form>
    <form v-else-if="modal === 'cover'" @submit.prevent="saveCover">
      <label>书名<input v-model="draftTitle" required maxlength="80" /></label
      ><label
        >封面寄语<textarea
          v-model="draftSubtitle"
          maxlength="80"
          rows="3"
        ></textarea></label
      ><button class="button full-width" type="submit">保存封面</button>
    </form>
    <form v-else-if="modal === 'nickname'" @submit.prevent="saveNickname">
      <label
        >昵称<input
          v-model="draftNickname"
          required
          maxlength="32"
          autocomplete="nickname" /></label
      ><button class="button full-width" type="submit">保存昵称</button>
    </form>
    <template v-else-if="modal === 'terms'"
      ><div class="terms-content">
        <p>
          本页为设计预览，以下是当前产品规则的摘要。正式版本应展示完整的最新使用条款。
        </p>
        <h3>共同记录一本人生书</h3>
        <p>
          接受邀请的项目成员可录音、编辑故事、管理书稿与提交印刷。项目内容仅向有权访问的成员开放。
        </p>
        <h3>资料与服务</h3>
        <p>
          故事、照片与原声按当前授权提供服务。退款、质量售后、资料导出与删除通过客服核验处理。
        </p>
        <h3>书稿与印刷</h3>
        <p>
          印刷采用提交时确定的书稿版本。书稿与收货地址就绪后，可以提交制作。
        </p>
      </div>
      <button
        class="button outline full-width"
        @click="termsFromLogin ? (modal = 'login') : closeModal()"
      >
        {{ termsFromLogin ? "返回登录" : "知道了" }}
      </button></template
    >
    <form v-else-if="modal === 'address'" @submit.prevent="saveAddress">
      <p class="modal-description">成书之后，再把这份珍藏送到家。</p>
      <label
        >收货人<input
          v-model="address.name"
          required
          maxlength="40"
          autocomplete="shipping name" /></label
      ><label
        >手机号<input
          v-model="address.phone"
          required
          type="tel"
          pattern="[0-9+ ()-]{7,20}"
          maxlength="20"
          autocomplete="shipping tel" /></label
      ><label
        >省、市、区<input
          v-model="address.region"
          required
          autocomplete="shipping address-level1" /></label
      ><label
        >详细地址<textarea
          v-model="address.street"
          required
          maxlength="200"
          autocomplete="shipping street-address"
          rows="2"
        ></textarea>
      </label>
      <p class="form-note">设计预览仅演示填写，不提交印刷或保存到服务器。</p>
      <button class="button full-width" type="submit">保存示例地址</button>
    </form>
  </dialog>
</template>
