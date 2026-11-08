<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { auth } from "../session";
import {
  projectApi,
  projectError,
  storyTitle,
  storyState,
  storyDate,
  storyMinutes,
  type StoryRecord,
} from "../project-api";
import { WebApiError } from "../api";
import Icon from "../components/Icon.vue";
import StoryPhotoGallery from "../components/StoryPhotoGallery.vue";
import StoryAudio from "../components/StoryAudio.vue";
const route = useRoute(),
  projectId = computed(() => String(route.params.projectId));
const story = ref<StoryRecord | null>(null),
  loading = ref(true),
  error = ref(""),
  editing = ref(false),
  title = ref(""),
  body = ref(""),
  busy = ref(false),
  conflict = ref(false),
  saved = ref(false);
let generation = 0;
function accessLost() {
  generation++;
  story.value = null;
  title.value = "";
  body.value = "";
  editing.value = false;
  error.value = "暂时无法访问这段故事，请返回项目重新查看。";
}
const clear = auth.onClear(() => {
  generation++;
  story.value = null;
  title.value = "";
  body.value = "";
  editing.value = false;
});
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = "";
  conflict.value = false;
  try {
    const result = await projectApi.story(
      projectId.value,
      String(route.params.storyId),
    );
    if (current === generation) {
      story.value = result;
      editing.value = false;
    }
  } catch (reason) {
    if (current === generation) {
      error.value = projectError(reason);
      story.value = null;
    }
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  () => `${route.params.projectId}/${route.params.storyId}`,
  () => {
    story.value = null;
    title.value = "";
    body.value = "";
    editing.value = false;
    busy.value = false;
    saved.value = false;
    void load();
  },
  { immediate: true },
);
onUnmounted(() => {
  generation++;
  clear();
});
function edit() {
  if (!story.value?.revision) return;
  title.value = story.value.revision.title;
  body.value = story.value.revision.paragraphs.map((p) => p.text).join("\n\n");
  editing.value = true;
  error.value = "";
  saved.value = false;
}
async function save() {
  if (!story.value?.revision || !title.value.trim() || !body.value.trim())
    return;
  const current = generation,
    source = story.value;
  // Keep each unchanged paragraph's sources; changed/reflowed paragraphs retain
  // the original story sources so edits never discard their provenance.
  const refs = [
    ...new Set(source.revision!.paragraphs.flatMap((p) => p.sourceRefs)),
  ];
  const paragraphs = body.value
    .split(/\n\s*\n/)
    .map((text) => text.trim())
    .filter(Boolean)
    .map((text) => ({
      text,
      sourceRefs:
        source.revision!.paragraphs.find((p) => p.text === text)?.sourceRefs ??
        refs,
    }));
  busy.value = true;
  error.value = "";
  conflict.value = false;
  try {
    const result = await projectApi.revise(
      projectId.value,
      source,
      title.value.trim(),
      paragraphs,
    );
    if (current === generation) {
      story.value = result;
      editing.value = false;
      saved.value = true;
    }
  } catch (reason) {
    if (current === generation) {
      error.value = projectError(reason);
      conflict.value = reason instanceof WebApiError && reason.status === 409;
      if (reason instanceof WebApiError && reason.status === 403) {
        story.value = null;
        body.value = "";
        title.value = "";
      }
    }
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function inclusion() {
  if (!story.value) return;
  const current = generation;
  busy.value = true;
  error.value = "";
  saved.value = false;
  try {
    const result = await projectApi.inclusion(projectId.value, story.value);
    if (current === generation) story.value = result;
  } catch (reason) {
    if (current === generation) {
      error.value = projectError(reason);
      conflict.value = reason instanceof WebApiError && reason.status === 409;
    }
  } finally {
    if (current === generation) busy.value = false;
  }
}
</script>
<template>
  <div class="reader-toolbar row-between">
    <RouterLink class="text-button" :to="`/projects/${projectId}?view=stories`"
      >← 返回故事</RouterLink
    >
    <div v-if="story?.revision" class="row">
      <span class="badge" :class="{ neutral: !story.included }">{{
        storyState(story)
      }}</span
      ><button v-if="!editing" class="button secondary small" @click="edit">
        <Icon name="pencil" :size="16" />编辑故事
      </button>
    </div>
  </div>
  <section
    v-if="loading && !story"
    class="panel detail-skeleton"
    aria-busy="true"
    aria-label="正在读取故事"
  >
    <div class="skeleton skeleton-line" />
    <div v-for="i in 7" :key="i" class="skeleton skeleton-line" />
  </section>
  <div v-if="error" class="notice error" role="alert">
    <span
      >{{ error
      }}<span v-if="conflict && editing">
        未保存的文字仍保留在下方，请先复制需要保留的内容。</span
      ></span
    ><button v-if="!busy" class="text-button" @click="load">
      {{ conflict ? "读取最新版本" : "重新读取" }}
    </button>
  </div>
  <p v-if="saved" class="success-note" role="status">故事已保存。</p>
  <template v-if="story">
    <article v-if="story.revision && !editing" class="story-reader">
      <p class="eyebrow">{{ story.revision.theme || "人生里的一个片段" }}</p>
      <h1>{{ storyTitle(story) }}</h1>
      <p class="reading-meta">
        {{ storyDate(story) }}<span>·</span>{{ storyMinutes(story) }} 分钟原声
      </p>
      <div class="reading-rule" />
      <StoryPhotoGallery
        v-if="
          story.revision.photoSnapshotId || story.revision.photoSnapshot?.id
        "
        :project-id="projectId"
        :interview-id="story.interviewId"
        :snapshot-id="
          story.revision.photoSnapshotId || story.revision.photoSnapshot?.id
        "
        @denied="accessLost"
      />
      <div class="prose">
        <p v-for="(paragraph, index) in story.revision.paragraphs" :key="index">
          {{ paragraph.text }}
        </p>
      </div>
      <div v-if="story.revision.notes?.length" class="story-notes">
        <p v-for="note in story.revision.notes" :key="note.id">
          {{ note.text }}
        </p>
      </div>
      <p class="story-end">— 故事，还在继续 —</p>
    </article>
    <form
      v-else-if="story.revision && editing"
      class="story-editor panel"
      @submit.prevent="save"
    >
      <label class="field-label"
        >故事标题<input v-model="title" required maxlength="120" /></label
      ><label class="field-label"
        >故事正文<textarea v-model="body" required rows="16" />
      </label>
      <div class="hero-actions">
        <button
          class="button"
          :disabled="busy || conflict || !title.trim() || !body.trim()"
        >
          <span v-if="busy" class="spinner" />保存修改</button
        ><button
          class="button secondary"
          type="button"
          :disabled="busy"
          @click="
            editing = false;
            error = '';
            conflict = false;
          "
        >
          取消
        </button>
      </div>
    </form>
    <section v-else class="empty-state panel">
      <span class="empty-icon"><Icon name="book" :size="32" /></span>
      <h1>{{ storyState(story) }}</h1>
      <p>
        讲述已保存。{{
          story.task?.state === "no_content"
            ? "可以补充更多细节，再整理成故事。"
            : "稍后返回查看整理结果，也可以继续补充讲述。"
        }}
      </p>
      <button class="button secondary" :disabled="loading" @click="load">
        <span v-if="loading" class="spinner" />刷新故事
      </button>
    </section>
    <StoryPhotoGallery
      v-if="!story.revision && !editing"
      :project-id="projectId"
      :interview-id="story.interviewId"
      @denied="accessLost"
    />
    <StoryAudio
      v-if="!editing"
      :project-id="projectId"
      :story="story"
      @denied="accessLost"
    />
    <div v-if="!editing" class="reader-actions">
      <RouterLink
        class="button secondary"
        :to="`/projects/${projectId}/stories/${story.id}/photos`"
        >管理照片</RouterLink
      >
      <button
        v-if="story.revision"
        class="button secondary"
        :disabled="busy"
        @click="inclusion"
      >
        <span v-if="busy" class="spinner" /><Icon name="book" :size="18" />{{
          story.included ? "移出书稿" : "编入书稿"
        }}</button
      ><RouterLink
        class="button"
        :to="`/projects/${projectId}/record?interviewId=${story.interviewId}&prepare=1`"
        ><Icon name="mic" :size="18" />继续补充讲述</RouterLink
      ><RouterLink class="text-button" :to="`/projects/${projectId}/record`"
        >再讲一个故事<Icon name="arrow" :size="16"
      /></RouterLink>
    </div>
  </template>
</template>
