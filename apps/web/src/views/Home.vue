<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { auth } from "../session";
import { workspace } from "../workspace";
import {
  projectApi,
  projectError,
  storyTitle,
  storyMinutes,
  storyDate,
  type ProjectOverview,
} from "../project-api";
import { recordingApi } from "../recording-api";
import type { RecordingContext } from "../../../../packages/contracts/src";
import PublicHome from "./PublicHome.vue";
import ProjectCover from "../components/ProjectCover.vue";
import EmptyProjects from "../components/EmptyProjects.vue";
import InviteDialog from "../components/InviteDialog.vue";
import Icon from "../components/Icon.vue";
defineEmits<{ login: [target?: string] }>();
const project = ref<ProjectOverview | null>(null),
  topics = ref<RecordingContext | null>(null);
const loading = ref(false),
  error = ref(""),
  topicIndex = ref(0),
  inviting = ref(false);
let generation = 0;
const selectedId = workspace.selectedId;
async function load() {
  const current = ++generation;
  project.value = null;
  topics.value = null;
  error.value = "";
  topicIndex.value = 0;
  inviting.value = false;
  if (!selectedId.value || !auth.account.value) {
    loading.value = false;
    return;
  }
  loading.value = true;
  try {
    const result = await projectApi.overview(selectedId.value);
    if (current !== generation) return;
    project.value = result;
    if (result.canRecord) {
      const value = await recordingApi.context(result.projectId);
      if (current === generation) topics.value = value;
    }
  } catch (reason) {
    if (current === generation) error.value = projectError(reason);
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  selectedId,
  () => {
    void load();
  },
  { immediate: true },
);
onUnmounted(() => {
  generation++;
});
const recent = computed(() =>
  [...(project.value?.stories ?? [])]
    .sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt))
    .slice(0, 3),
);
const minutes = computed(
  () =>
    project.value?.stories.reduce(
      (sum, story) => sum + storyMinutes(story),
      0,
    ) ?? 0,
);
const question = computed(
  () => topics.value?.plan.eligibleQuestions[topicIndex.value],
);
const recordPath = computed(
  () =>
    `/projects/${selectedId.value}/record${question.value ? `?questionKey=${encodeURIComponent(question.value.key)}` : ""}`,
);
function nextTopic() {
  const count = topics.value?.plan.eligibleQuestions.length ?? 0;
  if (count) topicIndex.value = (topicIndex.value + 1) % count;
}
</script>
<template>
  <section
    v-if="
      auth.restoring.value ||
      (auth.account.value &&
        workspace.loading.value &&
        !workspace.projects.value.length)
    "
    class="member-home-skeleton panel"
    aria-busy="true"
    aria-label="正在读取创作空间"
  >
    <div class="skeleton skeleton-line" />
    <div class="skeleton skeleton-cover" />
    <div class="skeleton skeleton-line" />
  </section>
  <PublicHome
    v-else-if="!auth.account.value"
    @login="(target?: string) => $emit('login', target)"
  />
  <template v-else>
    <div v-if="workspace.error.value" class="notice error" role="alert">
      {{ workspace.error.value
      }}<button class="text-button" @click="workspace.refresh">重试</button>
    </div>
    <template v-if="workspace.active.value">
      <header class="member-home-heading row-between">
        <h1>把往事，慢慢写成书。</h1>
        <button
          v-if="project?.canInvite"
          class="button secondary small"
          @click="inviting = true"
        >
          <Icon name="users" :size="17" />邀请家人
        </button>
      </header>
      <div v-if="error" class="notice error" role="alert">
        {{ error }}<button class="text-button" @click="load">重新读取</button>
      </div>
      <section
        v-if="loading && !project"
        class="member-home-skeleton panel"
        aria-busy="true"
        aria-label="正在读取当前项目"
      >
        <div class="skeleton skeleton-cover" />
        <div class="skeleton skeleton-line" />
      </section>
      <template v-if="project">
        <section class="workspace-hero panel">
          <div class="workspace-hero-copy">
            <span class="badge">{{
              project.canRecord ? "正在记录" : "故事珍藏"
            }}</span>
            <h2>{{ project.bookTitle }}</h2>
            <div class="hero-stats">
              <div>
                <strong>{{ project.stories.length }}</strong
                ><span>篇故事</span>
              </div>
              <div>
                <strong>{{ minutes }}</strong
                ><span>分钟原声</span>
              </div>
              <div>
                <strong>{{ project.summary.included }}</strong
                ><span>篇已入书</span>
              </div>
            </div>
            <div class="hero-actions">
              <RouterLink
                v-if="project.canRecord"
                class="button"
                :to="`/projects/${selectedId}/record`"
                ><Icon name="mic" :size="18" />开始讲述</RouterLink
              ><RouterLink
                class="text-button"
                :to="`/projects/${selectedId}/book`"
                >查看书稿<Icon name="arrow" :size="16"
              /></RouterLink>
            </div>
          </div>
          <div class="workspace-hero-cover">
            <ProjectCover
              :project-id="selectedId"
              :title="project.bookTitle"
              @denied="load"
            />
          </div>
        </section>
        <div class="workspace-lower">
          <section class="recent-stories">
            <div class="row-between">
              <h2>
                最近的故事 <small>{{ project.stories.length }}</small>
              </h2>
              <RouterLink class="text-button" to="/stories"
                >查看全部<Icon name="arrow" :size="16"
              /></RouterLink>
            </div>
            <RouterLink
              v-for="(story, index) in recent"
              :key="story.id"
              class="recent-story"
              :to="`/projects/${selectedId}/stories/${story.id}`"
              ><span class="recent-index">{{
                String(index + 1).padStart(2, "0")
              }}</span>
              <div>
                <span>{{ story.revision?.theme || "人生里的一个片段" }}</span>
                <h3>{{ storyTitle(story) }}</h3>
                <p>
                  {{ storyDate(story) }} · {{ storyMinutes(story) }} 分钟讲述
                </p>
              </div>
              <Icon name="arrow" :size="16"
            /></RouterLink>
            <div v-if="!recent.length" class="recent-empty">
              <Icon name="stories" :size="28" />
              <p>还没有故事</p>
              <RouterLink
                v-if="project.canRecord"
                class="text-button"
                :to="recordPath"
                >开始讲述<Icon name="arrow" :size="16"
              /></RouterLink>
            </div>
          </section>
          <aside v-if="question" class="topic-card">
            <div class="row-between">
              <Icon name="mic" :size="21" /><button
                class="text-button"
                @click="nextTopic"
              >
                换个话题
              </button>
            </div>
            <p class="eyebrow">今天，不妨聊聊</p>
            <h2>{{ question.text }}</h2>
            <RouterLink class="text-button" :to="recordPath"
              >从这里开始<Icon name="arrow" :size="16"
            /></RouterLink>
          </aside>
        </div>
      </template>
      <InviteDialog
        v-if="inviting && project?.canInvite"
        :key="selectedId"
        :project-id="selectedId"
        @close="inviting = false"
      />
    </template>
    <template v-else-if="!workspace.loading.value && !workspace.error.value"
      ><EmptyProjects /><PublicHome
        @login="(target?: string) => $emit('login', target)"
    /></template>
  </template>
</template>
