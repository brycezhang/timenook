<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { onBeforeRouteLeave, RouterLink, useRoute } from "vue-router";
import type {
  BookContext,
  BookVersionView,
  BookPhoto,
  PlanChapter,
  PersonalPlan,
} from "../../../../packages/contracts/src";
import { bookApi } from "../book-api";
import { projectApi, projectError, type ProjectOverview } from "../project-api";
import { WebApiError } from "../api";
import { fetchVerifiedBlob } from "../private-media";
import { auth } from "../session";
import Icon from "../components/Icon.vue";
import ModalDialog from "../components/ModalDialog.vue";
import EmptyProjects from "../components/EmptyProjects.vue";
import { workspace } from "../workspace";
import "../book.css";
const route = useRoute();
const projectId = computed(() =>
  String(route.params.projectId ?? workspace.selectedId.value),
);
const fixedId = computed(() =>
  typeof route.query.version === "string" ? route.query.version : "",
);
const plan = ref<PersonalPlan | null>(null);
const context = ref<BookContext | null>(null),
  overview = ref<ProjectOverview | null>(null),
  displayed = ref<BookVersionView | null>(null);
const loading = ref(true),
  error = ref(""),
  notice = ref(""),
  busy = ref("");
const title = ref(""),
  salutation = ref(""),
  photoAssetId = ref<string | null>(null),
  chapters = ref<PlanChapter[]>([]);
const savedCover = ref(""),
  savedDirectory = ref("");
const coverEditor = ref(false),
  directoryEditing = ref(false);
const photoPicker = ref(false),
  photoUrls = ref<Record<string, string>>({}),
  photoErrors = ref<Record<string, boolean>>({});
const pdfUrl = ref(""),
  pdfVisible = ref(false),
  pdfBusy = ref(false);
let sequence = 0,
  mediaSequence = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  expiry: ReturnType<typeof setTimeout> | undefined;
let mediaController = new AbortController();
let coverBaseVersion = 0,
  directoryBaseVersion = 1,
  titleBaseVersion = 0;
const coverKey = () =>
  JSON.stringify([title.value.trim(), salutation.value, photoAssetId.value]);
const coverDirty = computed(() => coverKey() !== savedCover.value);
const directoryDirty = computed(
  () => JSON.stringify(chapters.value) !== savedDirectory.value,
);
const dirty = computed(
  () =>
    !!context.value &&
    !fixedId.value &&
    (coverDirty.value || directoryDirty.value),
);
const editable = computed(
  () => !!context.value?.draftAccess.allowed && !fixedId.value,
);
const generating = computed(
  () =>
    displayed.value && ["queued", "rendering"].includes(displayed.value.state),
);
const outdated = computed(
  () =>
    !!displayed.value &&
    (displayed.value.state === "obsolete" ||
      (!!context.value?.inputHash &&
        displayed.value.inputHash !== context.value.inputHash)),
);
const ready = computed(
  () =>
    displayed.value?.state === "ready" &&
    !!displayed.value.pdf &&
    !outdated.value,
);
const includedCount = computed(() =>
  chapters.value.reduce((n, c) => n + c.storyRefs.length, 0),
);
const coverPhoto = computed(() =>
  fixedId.value
    ? displayed.value?.snapshot.cover.photo
    : context.value?.coverPhotoOptions.find(
        (p) => p.assetId === photoAssetId.value,
      ),
);
const coverTitle = computed(() =>
  fixedId.value ? displayed.value?.snapshot.cover.title : title.value,
);
const coverSalutation = computed(() =>
  fixedId.value ? displayed.value?.snapshot.cover.salutation : salutation.value,
);
const unplaced = computed(
  () =>
    context.value?.eligibleStories.filter(
      (s) => !chapters.value.some((c) => c.storyRefs.includes(s.id)),
    ) ?? [],
);
const story = (id: string) =>
  context.value?.eligibleStories.find((s) => s.id === id);
function clearPdf() {
  if (pdfUrl.value) URL.revokeObjectURL(pdfUrl.value);
  pdfUrl.value = "";
  pdfVisible.value = false;
}
function clearMedia() {
  mediaSequence++;
  mediaController.abort();
  mediaController = new AbortController();
  clearPdf();
  for (const url of Object.values(photoUrls.value)) URL.revokeObjectURL(url);
  photoUrls.value = {};
  photoErrors.value = {};
}
function clear() {
  sequence++;
  clearTimeout(timer);
  clearTimeout(expiry);
  clearMedia();
  context.value = null;
  overview.value = null;
  displayed.value = null;
  title.value = "";
  salutation.value = "";
  photoAssetId.value = null;
  chapters.value = [];
  savedCover.value = "";
  savedDirectory.value = "";
  loading.value = false;
  busy.value = "";
  pdfBusy.value = false;
}
const offClear = auth.onClear(clear);
function deadline() {
  clearTimeout(expiry);
  const dates = [
    context.value?.accessExpiresAt,
    displayed.value?.accessExpiresAt,
  ]
    .filter((v): v is string => !!v)
    .map(Date.parse);
  if (dates.length)
    expiry = setTimeout(
      () => {
        clear();
        error.value = "访问已失效，请重新读取。";
      },
      Math.max(0, Math.min(...dates) - Date.now()),
    );
}
function accept(
  value: BookContext,
  resetCover = false,
  resetDirectory = false,
) {
  const previousId = displayed.value?.id;
  context.value = value;
  if (resetCover) {
    coverBaseVersion = value.cover.version;
    titleBaseVersion = overview.value?.metadataVersion ?? 0;
    title.value =
      overview.value?.bookTitle ??
      value.current?.snapshot.cover.title ??
      "人生故事书";
    salutation.value = value.cover.salutation;
    photoAssetId.value = value.cover.photoAssetId;
    savedCover.value = coverKey();
  }
  if (resetDirectory) {
    directoryBaseVersion = value.directory.version;
    chapters.value = structuredClone(plan.value?.chapters ?? []);
    savedDirectory.value = JSON.stringify(chapters.value);
  }
  if (!fixedId.value) displayed.value = value.current;
  if (previousId !== displayed.value?.id || !ready.value) clearPdf();
  deadline();
}
function failure(cause: unknown) {
  if (cause instanceof DOMException && cause.name === "AbortError") return;
  if (cause instanceof WebApiError && [401, 403, 404].includes(cause.status))
    clear();
  error.value = projectError(cause);
}
async function load(initial = false) {
  const token = initial ? ++sequence : sequence;
  if (initial) loading.value = true;
  error.value = "";
  try {
    const [value, project, outline] = await Promise.all([
      bookApi.context(projectId.value),
      projectApi.overview(projectId.value),
      projectApi.plan(projectId.value),
    ]);
    if (token !== sequence) return;
    const resetCover = initial || !coverDirty.value,
      resetDirectory = initial || !directoryDirty.value;
    overview.value = project;
    plan.value = outline;
    accept(value, resetCover, resetDirectory);
    if (fixedId.value) {
      const version = await bookApi.version(projectId.value, fixedId.value);
      if (token !== sequence) return;
      displayed.value = version;
      deadline();
    }
    if (
      coverPhoto.value &&
      (!fixedId.value || displayed.value?.coverPhotoAccess.allowed)
    )
      void loadPhoto(coverPhoto.value);
  } catch (cause) {
    if (token === sequence) failure(cause);
  } finally {
    if (token === sequence) {
      loading.value = false;
      schedule();
    }
  }
}
function schedule() {
  clearTimeout(timer);
  if (context.value)
    timer = setTimeout(() => void load(), generating.value ? 1800 : 15000);
}
async function loadPhoto(photo: BookPhoto) {
  if (photoUrls.value[photo.assetId]) return;
  const token = mediaSequence;
  try {
    const blob = await fetchVerifiedBlob(
      `/projects/${projectId.value}/photos/${photo.id}/assets/${photo.assetId}/content`,
      photo,
      mediaController.signal,
    );
    if (token !== mediaSequence) return;
    photoUrls.value = {
      ...photoUrls.value,
      [photo.assetId]: URL.createObjectURL(blob),
    };
  } catch (cause) {
    if (token !== mediaSequence) return;
    if (cause instanceof WebApiError && [401, 403, 404].includes(cause.status))
      failure(cause);
    else photoErrors.value = { ...photoErrors.value, [photo.assetId]: true };
  }
}
function choosePhoto(photo: BookPhoto | null) {
  photoAssetId.value = photo?.assetId ?? null;
  if (photo) void loadPhoto(photo);
  photoPicker.value = false;
}
async function saveCover() {
  if (!context.value || !overview.value || busy.value || loading.value) return;
  busy.value = "cover";
  error.value = "";
  notice.value = "";
  const token = ++sequence;
  clearTimeout(timer);
  try {
    if (title.value.trim() !== overview.value.bookTitle) {
      const project = await projectApi.rename(
        projectId.value,
        titleBaseVersion,
        title.value.trim(),
      );
      if (token !== sequence) return;
      overview.value = project;
      titleBaseVersion = project.metadataVersion;
    }
    const value = await bookApi.cover(
      projectId.value,
      coverBaseVersion,
      salutation.value,
      photoAssetId.value,
    );
    if (token !== sequence) return;
    accept(value, true);
    notice.value = "封面已保存";
    coverEditor.value = false;
    photoPicker.value = false;
    void workspace.refresh();
  } catch (cause) {
    if (token === sequence) failure(cause);
  } finally {
    busy.value = "";
    schedule();
  }
}
async function saveDirectory() {
  if (!context.value || busy.value || loading.value) return;
  busy.value = "directory";
  error.value = "";
  notice.value = "";
  const token = ++sequence;
  clearTimeout(timer);
  try {
    if (!plan.value) return;
    plan.value = await projectApi.revisePlan(
      projectId.value,
      directoryBaseVersion,
      {
        chapters: JSON.parse(JSON.stringify(chapters.value)),
        starters: plan.value.starters,
      },
    );
    const value = await bookApi.context(projectId.value);
    if (token !== sequence) return;
    accept(value, false, true);
    notice.value = "目录已保存";
    directoryEditing.value = false;
  } catch (cause) {
    if (token === sequence) failure(cause);
  } finally {
    busy.value = "";
    schedule();
  }
}
function moveChapter(index: number, offset: number) {
  const list = [...chapters.value];
  [list[index], list[index + offset]] = [list[index + offset], list[index]];
  chapters.value = list;
}
function moveStory(id: string, chapterKey: string) {
  for (const chapter of chapters.value)
    chapter.storyRefs = chapter.storyRefs.filter((ref) => ref !== id);
  chapters.value.find((c) => c.key === chapterKey)?.storyRefs.push(id);
}
function reorderStory(chapterIndex: number, index: number, offset: number) {
  const list = chapters.value[chapterIndex].storyRefs;
  [list[index], list[index + offset]] = [list[index + offset], list[index]];
}
function addChapter() {
  chapters.value.push({
    key: crypto.randomUUID(),
    title: `第${chapters.value.length + 1}章`,
    storyRefs: [],
    questions: [],
  });
}
let generatedInput = "",
  generateKey = crypto.randomUUID(),
  retryKey = crypto.randomUUID();
async function generate(retry = false) {
  if (!context.value?.inputHash || busy.value || dirty.value || fixedId.value)
    return;
  busy.value = "generate";
  error.value = "";
  notice.value = "";
  const token = sequence;
  try {
    if (generatedInput !== context.value.inputHash) {
      generatedInput = context.value.inputHash;
      generateKey = crypto.randomUUID();
    }
    const value =
      retry && displayed.value
        ? await bookApi.retry(projectId.value, displayed.value.id, retryKey)
        : await bookApi.generate(
            projectId.value,
            context.value.inputHash,
            generateKey,
          );
    if (token !== sequence) return;
    displayed.value = value;
    clearPdf();
    generateKey = crypto.randomUUID();
    retryKey = crypto.randomUUID();
    await load();
  } catch (cause) {
    if (token === sequence) failure(cause);
  } finally {
    busy.value = "";
  }
}
async function pdf(download = false) {
  if (!ready.value || !displayed.value?.pdf || pdfBusy.value) return;
  pdfBusy.value = true;
  error.value = "";
  const token = mediaSequence,
    version = displayed.value;
  try {
    const blob = await fetchVerifiedBlob(
      `/projects/${projectId.value}/book/versions/${version.id}/pdf`,
      version.pdf!,
      mediaController.signal,
    );
    if (token !== mediaSequence || displayed.value?.id !== version.id) return;
    if (!pdfUrl.value) pdfUrl.value = URL.createObjectURL(blob);
    if (download) {
      const anchor = document.createElement("a");
      anchor.href = pdfUrl.value;
      anchor.download = `${version.snapshot.cover.title}-第${version.version}版.pdf`;
      anchor.click();
    } else pdfVisible.value = true;
  } catch (cause) {
    if (token === mediaSequence) failure(cause);
  } finally {
    pdfBusy.value = false;
  }
}
function cancelCover() {
  if (busy.value === "cover") return;
  const [savedTitle, savedSalutation, savedPhoto] = JSON.parse(
    savedCover.value,
  );
  title.value = savedTitle;
  salutation.value = savedSalutation;
  photoAssetId.value = savedPhoto;
  photoPicker.value = false;
  coverEditor.value = false;
}
function cancelDirectory() {
  if (busy.value) return;
  chapters.value = JSON.parse(savedDirectory.value);
  directoryEditing.value = false;
}
function reloadEditor() {
  if (
    dirty.value &&
    !window.confirm("读取最新内容会放弃未保存的修改，是否继续？")
  )
    return;
  void load(true);
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (dirty.value) event.preventDefault();
}
window.addEventListener("beforeunload", beforeUnload);
onBeforeRouteLeave(
  () => !dirty.value || window.confirm("修改还未保存，确定离开吗？"),
);
watch(
  () => [projectId.value, fixedId.value],
  () => {
    clear();
    coverEditor.value = false;
    directoryEditing.value = false;
    if (projectId.value) void load(true);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  offClear();
  clear();
  window.removeEventListener("beforeunload", beforeUnload);
});
</script>
<template>
  <section class="book-page">
    <RouterLink
      v-if="projectId"
      class="back-link"
      :to="`/projects/${projectId}`"
      >← 返回故事</RouterLink
    >
    <EmptyProjects
      v-if="!projectId && !workspace.loading.value && !workspace.error.value"
      title="你的第一本书，还在等故事"
    />
    <header v-if="projectId" class="book-heading">
      <div>
        <h1>我的书稿</h1>
      </div>
      <div class="book-header-actions">
        <button
          v-if="editable"
          class="button secondary small"
          @click="coverEditor = true"
        >
          <Icon name="pencil" :size="16" />编辑封面</button
        ><button
          class="text-button"
          :disabled="loading || !!busy"
          @click="reloadEditor"
        >
          读取最新内容
        </button>
      </div>
    </header>
    <div v-if="error && !coverEditor" class="notice" role="alert">
      {{ error }}
      <button class="text-button" @click="reloadEditor">重试读取</button>
    </div>
    <p v-if="notice" class="book-notice" role="status">{{ notice }}</p>
    <div
      v-if="projectId && loading && !context"
      class="book-layout"
      aria-busy="true"
      aria-label="正在读取书稿"
    >
      <div class="book-cover skeleton" />
      <div class="skeleton-card">
        <div v-for="i in 6" :key="i" class="skeleton skeleton-line" />
      </div>
    </div>
    <template v-else-if="context">
      <div v-if="fixedId" class="notice">
        正在查看固定的第 {{ displayed?.version }} 版书稿。<RouterLink
          :to="`/projects/${projectId}/book`"
          >返回当前书稿</RouterLink
        >
      </div>
      <div v-if="!context.draftAccess.allowed && !fixedId" class="notice">
        当前无法编辑书稿，已生成文件仍按当前权限读取。
      </div>
      <div class="book-layout">
        <aside class="book-cover-panel">
          <div class="book-cover">
            <span>时光故事 · 岁月成书</span>
            <h2>{{ coverTitle }}</h2>
            <div class="book-cover-rule" />
            <p>{{ coverSalutation }}</p>
            <div
              v-if="
                coverPhoto && (!fixedId || displayed?.coverPhotoAccess.allowed)
              "
              class="book-cover-photo"
            >
              <img
                v-if="photoUrls[coverPhoto.assetId]"
                :src="photoUrls[coverPhoto.assetId]"
                alt="选定的封面照片"
              /><button
                v-else-if="photoErrors[coverPhoto.assetId]"
                class="text-button"
                @click="loadPhoto(coverPhoto)"
              >
                照片读取失败，重试
              </button>
              <div v-else class="skeleton" aria-label="正在读取封面照片" />
            </div>
            <small class="book-cover-credit">家人的讲述 · 珍藏的回忆</small>
          </div>
          <span class="book-preview-caption">封面设计预览</span>
          <ModalDialog
            v-if="coverEditor && editable"
            title="编辑封面"
            :busy="busy === 'cover'"
            @close="cancelCover"
            ><form class="book-cover-form" @submit.prevent="saveCover">
              <label
                >书名<input
                  :disabled="loading || !!busy"
                  v-model="title"
                  maxlength="120"
                  required
                  aria-label="书名" /></label
              ><label
                >封面寄语<textarea
                  :disabled="loading || !!busy"
                  v-model="salutation"
                  rows="3"
                  maxlength="120"
                  aria-label="封面寄语"
                  placeholder="写一句想留在封面上的话"
                /></label
              ><button
                type="button"
                class="button secondary"
                :disabled="loading || !!busy"
                @click="photoPicker = !photoPicker"
              >
                {{ photoAssetId ? "更换封面照片" : "选择封面照片" }}
              </button>
              <div v-if="photoPicker" class="book-photo-picker">
                <button
                  type="button"
                  class="book-photo-choice"
                  :disabled="loading || !!busy"
                  :aria-pressed="!photoAssetId"
                  @click="choosePhoto(null)"
                >
                  不用照片</button
                ><button
                  v-for="photo in context.coverPhotoOptions"
                  :key="photo.assetId"
                  type="button"
                  class="book-photo-choice"
                  :disabled="loading || !!busy"
                  :aria-pressed="photoAssetId === photo.assetId"
                  @click="choosePhoto(photo)"
                >
                  {{ photo.caption || "故事照片" }}
                </button>
                <p v-if="!context.coverPhotoOptions.length">
                  可从已入书的故事照片中选择。先为故事添加照片，或使用无照片封面。
                </p>
              </div>
              <p v-if="error" class="notice error" role="alert">
                {{ error
                }}<button
                  class="text-button"
                  type="button"
                  @click="reloadEditor"
                >
                  读取最新内容
                </button>
              </p>
              <button
                class="button"
                :disabled="!!busy || loading || !coverDirty || !title.trim()"
              >
                <span v-if="busy === 'cover'" class="book-spinner" />{{
                  busy === "cover" ? "正在保存" : "保存封面"
                }}
              </button>
            </form></ModalDialog
          >
        </aside>
        <div class="book-main">
          <section v-if="!fixedId" class="book-card">
            <div class="book-section-heading">
              <div>
                <h2>{{ directoryEditing ? "整理目录" : "书里的故事" }}</h2>
                <p>{{ includedCount }} 篇故事，{{ chapters.length }} 个章节</p>
              </div>
              <button
                v-if="editable && directoryEditing"
                class="text-button"
                :disabled="!!busy || loading"
                @click="addChapter"
              >
                添加章节
              </button>
            </div>
            <p v-if="!chapters.length" class="book-empty">
              先讲述一个故事，再把它编进自己的书。
            </p>
            <template v-if="!directoryEditing">
              <section
                v-for="(chapter, index) in chapters"
                :key="chapter.key"
                class="book-directory-chapter"
              >
                <header>
                  <span>{{ String(index + 1).padStart(2, "0") }}</span>
                  <h3>{{ chapter.title }}</h3>
                  <small>{{ chapter.storyRefs.length }} 篇</small>
                </header>
                <RouterLink
                  v-for="id in chapter.storyRefs"
                  :key="id"
                  :to="`/projects/${projectId}/stories/${id}`"
                  >{{ story(id)?.title || "故事"
                  }}<Icon name="arrow" :size="15"
                /></RouterLink>
                <p v-if="!chapter.storyRefs.length" class="book-empty">
                  暂无故事
                </p>
              </section>
              <button
                v-if="editable"
                class="text-button"
                @click="directoryEditing = true"
              >
                <Icon name="plus" :size="16" />管理入书故事
              </button> </template
            ><template v-else>
              <fieldset
                v-for="(chapter, ci) in chapters"
                :key="chapter.key"
                class="book-chapter"
                :disabled="!editable || !!busy || loading"
              >
                <legend>第 {{ ci + 1 }} 章</legend>
                <div class="book-chapter-heading">
                  <input
                    v-model="chapter.title"
                    :aria-label="`章节名称 ${ci + 1}`"
                    maxlength="120"
                    required
                  />
                  <div class="book-order-buttons">
                    <button
                      class="text-button"
                      :disabled="ci === 0"
                      :aria-label="`上移章节 ${ci + 1}`"
                      @click="moveChapter(ci, -1)"
                    >
                      ↑</button
                    ><button
                      class="text-button"
                      :disabled="ci === chapters.length - 1"
                      :aria-label="`下移章节 ${ci + 1}`"
                      @click="moveChapter(ci, 1)"
                    >
                      ↓</button
                    ><button
                      v-if="!chapter.storyRefs.length"
                      class="text-button"
                      :aria-label="`删除章节 ${ci + 1}`"
                      @click="chapters.splice(ci, 1)"
                    >
                      删除
                    </button>
                  </div>
                </div>
                <div
                  v-for="(id, si) in chapter.storyRefs"
                  :key="id"
                  class="book-story-row"
                >
                  <div>
                    <RouterLink
                      v-if="story(id)"
                      :to="`/projects/${projectId}/stories/${id}`"
                      >{{ story(id)?.title }}</RouterLink
                    ><span v-else>故事已移出入书内容</span
                    ><small v-if="story(id)"
                      >当前故事第 {{ story(id)?.version }} 版</small
                    >
                  </div>
                  <div class="book-story-actions">
                    <button
                      class="text-button"
                      :disabled="si === 0"
                      :aria-label="`上移故事 ${id}`"
                      @click="reorderStory(ci, si, -1)"
                    >
                      ↑</button
                    ><button
                      class="text-button"
                      :disabled="si === chapter.storyRefs.length - 1"
                      :aria-label="`下移故事 ${id}`"
                      @click="reorderStory(ci, si, 1)"
                    >
                      ↓</button
                    ><select
                      :value="chapter.key"
                      :aria-label="`移动故事 ${id}`"
                      @change="
                        moveStory(
                          id,
                          ($event.target as HTMLSelectElement).value,
                        )
                      "
                    >
                      <option
                        v-for="target in chapters"
                        :key="target.key"
                        :value="target.key"
                      >
                        {{ target.title }}
                      </option>
                      <option value="">移出目录</option>
                    </select>
                  </div>
                </div>
                <p v-if="!chapter.storyRefs.length" class="book-empty">
                  这一章还没有故事
                </p>
              </fieldset>
              <div v-if="unplaced.length" class="book-unplaced">
                <h3>待编排的故事</h3>
                <div
                  v-for="item in unplaced"
                  :key="item.id"
                  class="book-story-row"
                >
                  <span
                    >{{ item.title
                    }}<small>第 {{ item.version }} 版</small></span
                  ><select
                    :disabled="!editable || !!busy || loading"
                    value=""
                    :aria-label="`移动故事 ${item.id}`"
                    @change="
                      moveStory(
                        item.id,
                        ($event.target as HTMLSelectElement).value,
                      )
                    "
                  >
                    <option value="" disabled>选择章节</option>
                    <option
                      v-for="chapter in chapters"
                      :key="chapter.key"
                      :value="chapter.key"
                    >
                      {{ chapter.title }}
                    </option>
                  </select>
                </div>
              </div>
              <button
                v-if="editable"
                class="button secondary"
                :disabled="
                  !!busy ||
                  loading ||
                  !directoryDirty ||
                  chapters.some((c) => !c.title.trim())
                "
                @click="saveDirectory"
              >
                <span v-if="busy === 'directory'" class="book-spinner" />{{
                  busy === "directory" ? "正在保存" : "保存目录"
                }}
              </button>
              <button
                class="text-button"
                :disabled="!!busy"
                @click="cancelDirectory"
              >
                取消编辑
              </button></template
            >
          </section>
          <section class="book-card book-generation" aria-live="polite">
            <div class="book-section-heading">
              <div>
                <h2>
                  {{
                    generating
                      ? "正在生成书稿"
                      : ready
                        ? "书稿已就绪"
                        : outdated
                          ? "内容已修改，请重新生成"
                          : displayed?.state === "failed"
                            ? "书稿生成失败"
                            : "让故事变成一本书"
                  }}
                </h2>
                <p v-if="displayed">
                  第 {{ displayed.version }} 版<span v-if="displayed.pageCount">
                    · {{ displayed.pageCount }} 页</span
                  >
                </p>
                <p v-else>生成后即可阅读和下载完整 PDF。</p>
              </div>
              <span v-if="generating" class="book-spinner" />
            </div>
            <p v-if="dirty" class="book-notice">
              有未保存的修改，请先保存封面和目录。
            </p>
            <p v-if="outdated">
              这份固定版本保留原有内容，当前改动将在新版本中呈现。
            </p>
            <p v-if="displayed?.state === 'failed'">
              暂未生成完整文件，可以重试原任务。
            </p>
            <div class="book-buttons">
              <button
                v-if="editable && !generating"
                class="button"
                :disabled="
                  !!busy ||
                  loading ||
                  dirty ||
                  !includedCount ||
                  !context.inputHash
                "
                @click="generate()"
              >
                {{
                  outdated ? "重新生成书稿" : ready ? "生成新版本" : "生成书稿"
                }}</button
              ><button
                v-if="editable && displayed?.state === 'failed'"
                class="button secondary"
                :disabled="!!busy || loading || dirty"
                @click="generate(true)"
              >
                重试生成</button
              ><button
                v-if="ready"
                class="button secondary"
                :disabled="pdfBusy"
                @click="pdf()"
              >
                {{ pdfBusy ? "正在读取 PDF" : "阅读 PDF" }}</button
              ><button
                v-if="ready"
                class="button secondary"
                :disabled="pdfBusy"
                @click="pdf(true)"
              >
                下载 PDF
              </button>
            </div>
            <p v-if="!includedCount && !fixedId" class="book-empty">
              还没有编入目录的故事。<RouterLink :to="`/projects/${projectId}`"
                >去记录故事</RouterLink
              >
            </p>
            <RouterLink
              v-if="ready && !fixedId"
              class="book-print-link"
              :to="`/projects/${projectId}/production`"
              >填写地址，提交印刷 →</RouterLink
            ><RouterLink
              v-if="displayed && !fixedId"
              class="text-button"
              :to="{
                path: `/projects/${projectId}/book`,
                query: { version: displayed.id },
              }"
              >固定版本链接</RouterLink
            >
          </section>
          <section v-if="displayed" class="book-card">
            <h2>第 {{ displayed.version }} 版内容</h2>
            <p class="book-muted">{{ displayed.snapshot.cover.title }}</p>
            <div
              v-for="chapter in displayed.snapshot.chapters"
              :key="chapter.key"
              class="book-frozen-chapter"
            >
              <h3>{{ chapter.title }}</h3>
              <article
                v-for="item in chapter.stories"
                :key="item.revisionId"
                class="book-frozen-story"
              >
                <h4>{{ item.title }}</h4>
                <small>故事第 {{ item.version }} 版</small>
                <p v-for="(paragraph, index) in item.paragraphs" :key="index">
                  {{ paragraph }}
                </p>
                <RouterLink
                  v-if="item.entry"
                  class="book-audio-link"
                  :to="`/audio/${item.entry.id}`"
                  ><Icon name="mic" :size="17" />听这篇故事的原声</RouterLink
                >
              </article>
              <p v-if="!chapter.stories.length" class="book-empty">
                这一章还没有故事
              </p>
            </div>
          </section>
        </div>
      </div>
      <section v-if="pdfVisible && pdfUrl" class="book-pdf-panel">
        <div class="book-section-heading">
          <h2>书稿 PDF</h2>
          <button class="text-button" @click="clearPdf">关闭</button>
        </div>
        <iframe :src="pdfUrl" title="书稿 PDF" />
        <p>手机浏览器如无法显示，可使用「下载 PDF」打开文件。</p>
      </section>
    </template>
  </section>
</template>
