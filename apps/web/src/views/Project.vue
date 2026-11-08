<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { auth } from "../session";
import { workspace } from "../workspace";
import EmptyProjects from "../components/EmptyProjects.vue";
import ModalDialog from "../components/ModalDialog.vue";
import {
  projectApi,
  projectError,
  storyTitle,
  storyState,
  storyMinutes,
  storyDate,
  type ProjectOverview,
} from "../project-api";
import Icon from "../components/Icon.vue";
const route = useRoute();
const id = computed(() =>
  String(route.params.projectId ?? workspace.selectedId.value),
);
const project = ref<ProjectOverview | null>(null),
  loading = ref(true),
  error = ref("");
const query = ref(""),
  filter = ref("all"),
  modal = ref<"rename" | "invite" | null>(null),
  draftTitle = ref(""),
  busy = ref(false),
  actionError = ref(""),
  inviteUrl = ref(""),
  inviteExpiry = ref(""),
  copied = ref(false);
let generation = 0;
const clear = auth.onClear(() => {
  generation++;
  project.value = null;
  inviteUrl.value = "";
  draftTitle.value = "";
  modal.value = null;
});
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const result = await projectApi.overview(id.value);
    if (current === generation) {
      project.value = result;
      if (route.query.invite === "1" && result.canInvite && !modal.value)
        void invite();
    }
  } catch (reason) {
    if (current === generation) {
      error.value = projectError(reason);
      project.value = null;
    }
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  id,
  () => {
    project.value = null;
    modal.value = null;
    inviteUrl.value = "";
    draftTitle.value = "";
    busy.value = false;
    query.value = "";
    filter.value = "all";
    if (id.value) void load();
    else loading.value = false;
  },
  { immediate: true },
);
onUnmounted(() => {
  generation++;
  clear();
});
const stories = computed(
  () =>
    project.value?.stories.filter(
      (story) =>
        (filter.value === "all" ||
          (filter.value === "included"
            ? story.included && story.revision
            : !story.included || !story.revision)) &&
        `${storyTitle(story)} ${story.revision?.paragraphs.map((p) => p.text).join(" ") ?? ""}`.includes(
          query.value.trim(),
        ),
    ) ?? [],
);
function rename() {
  draftTitle.value = project.value!.bookTitle;
  actionError.value = "";
  modal.value = "rename";
}
async function saveName() {
  if (!project.value || !draftTitle.value.trim()) return;
  const current = generation;
  busy.value = true;
  actionError.value = "";
  try {
    const result = await projectApi.rename(
      id.value,
      project.value.metadataVersion,
      draftTitle.value.trim(),
    );
    if (current === generation) {
      project.value = result;
      modal.value = null;
      void workspace.refresh();
    }
  } catch (reason) {
    if (current === generation) actionError.value = projectError(reason);
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function invite() {
  modal.value = "invite";
  actionError.value = "";
  inviteUrl.value = "";
  copied.value = false;
  busy.value = true;
  const current = generation;
  try {
    const result = await projectApi.invite(id.value);
    if (current === generation) {
      inviteUrl.value = new URL(
        `${import.meta.env.BASE_URL}invite/${result.token}`,
        location.origin,
      ).href;
      inviteExpiry.value = new Intl.DateTimeFormat("zh-CN", {
        month: "long",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      }).format(new Date(result.expiresAt));
    }
  } catch (reason) {
    if (current === generation) actionError.value = projectError(reason);
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function copyInvite() {
  try {
    await navigator.clipboard.writeText(inviteUrl.value);
    copied.value = true;
  } catch {
    actionError.value = "请长按或选中上面的链接复制。";
  }
}
</script>
<template>
  <RouterLink v-if="route.params.projectId" class="text-button" to="/projects"
    >← 我的项目</RouterLink
  >
  <EmptyProjects
    v-if="!id && !workspace.loading.value && !workspace.error.value"
    title="先有一个项目，再留下第一篇故事"
  />
  <section
    v-if="(loading || workspace.loading.value) && !project"
    class="panel detail-skeleton"
    aria-busy="true"
    aria-label="正在读取项目"
  >
    <div class="skeleton skeleton-line" />
    <div class="skeleton skeleton-cover" />
    <div class="skeleton skeleton-line" />
  </section>
  <div v-if="error" class="notice error" role="alert">
    {{ error }}<button class="text-button" @click="load">重新读取</button>
  </div>
  <template v-if="project">
    <section class="project-heading row-between">
      <div>
        <p v-if="!route.params.projectId" class="current-project-label">
          {{ project.bookTitle }}
        </p>
        <h1>
          {{
            route.params.projectId ? project.bookTitle : "每一段，都是人生。"
          }}
        </h1>
        <button class="text-button" @click="rename">
          修改项目名称 <Icon name="pencil" :size="14" />
        </button>
      </div>
      <button v-if="project.canInvite" class="button secondary" @click="invite">
        <Icon name="users" :size="17" />邀请家人
      </button>
    </section>
    <div class="story-create-action">
      <RouterLink
        v-if="project.canRecord"
        class="button"
        :to="`/projects/${id}/record`"
        ><Icon name="plus" :size="17" />再记一个故事</RouterLink
      >
    </div>
    <section class="stories-section">
      <div class="row-between">
        <div>
          <h2>
            我的故事 <small>{{ project.stories.length }}</small>
          </h2>
        </div>
        <RouterLink
          v-if="project.canRecord && project.stories.length"
          class="text-button"
          :to="`/projects/${id}/record`"
          >再记一个故事 ＋</RouterLink
        >
      </div>
      <div class="story-toolbar">
        <div class="segmented" aria-label="筛选故事">
          <button
            v-for="item in [
              { id: 'all', label: '全部故事' },
              { id: 'included', label: '已编入书稿' },
              { id: 'excluded', label: '未编入书稿' },
            ]"
            :key="item.id"
            :aria-pressed="filter === item.id"
            :class="{ selected: filter === item.id }"
            @click="filter = item.id"
          >
            {{ item.label }}
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
      <div v-if="stories.length" class="story-grid">
        <RouterLink
          v-for="(story, index) in stories"
          :key="story.id"
          class="story-card panel"
          :to="`/projects/${id}/stories/${story.id}`"
          ><div class="row-between">
            <span class="story-chapter">{{
              story.revision?.theme || "人生里的一个片段"
            }}</span
            ><span
              class="badge"
              :class="{ neutral: !story.revision || !story.included }"
              >{{ storyState(story) }}</span
            >
          </div>
          <span class="card-index">{{
            String(index + 1).padStart(2, "0")
          }}</span>
          <h3>{{ storyTitle(story) }}</h3>
          <p class="story-excerpt">
            {{
              story.revision?.paragraphs[0]?.text ||
              "讲述已保存，整理结果会在这里呈现。"
            }}
          </p>
          <div class="story-card-footer">
            <span>{{ storyDate(story) }}</span
            ><span>{{ storyMinutes(story) }} 分钟原声</span
            ><Icon name="arrow" :size="16" /></div
        ></RouterLink>
      </div>
      <section v-else class="empty-state panel">
        <span class="empty-icon"><Icon name="book" :size="30" /></span>
        <h2>
          {{
            query
              ? "没有找到这段故事"
              : filter !== "all"
                ? "这里还没有故事"
                : "故事，从开口的那一刻开始"
          }}
        </h2>
        <p>
          {{
            query
              ? "试试其他关键词，或查看全部故事。"
              : "选一个想聊的话题，慢慢说就好。"
          }}
        </p>
        <button
          v-if="query || filter !== 'all'"
          class="button secondary"
          @click="
            query = '';
            filter = 'all';
          "
        >
          查看全部故事</button
        ><RouterLink
          v-else-if="project.canRecord"
          class="button"
          :to="`/projects/${id}/record`"
          >开始讲述</RouterLink
        >
      </section>
    </section>
    <ModalDialog
      v-if="modal"
      :title="modal === 'rename' ? '给这本书一个名字' : '邀请家人'"
      :close-label="modal === 'invite' ? '关闭邀请' : '关闭修改名称'"
      :busy="busy"
      @close="modal = null"
    >
      <template v-if="modal === 'rename'"
        ><form @submit.prevent="saveName">
          <label class="field-label"
            >项目名称<input v-model="draftTitle" required maxlength="120"
          /></label>
          <p v-if="actionError" class="error" role="alert">
            {{ actionError }}
          </p>
          <div class="hero-actions">
            <button class="button" :disabled="busy || !draftTitle.trim()">
              <span v-if="busy" class="spinner" />保存名称</button
            ><button
              type="button"
              class="button secondary"
              :disabled="busy"
              @click="modal = null"
            >
              取消</button
            ><button
              v-if="actionError"
              type="button"
              class="text-button"
              @click="
                modal = null;
                load();
              "
            >
              读取最新名称
            </button>
          </div>
        </form></template
      ><template v-else-if="modal === 'invite'"
        ><span class="empty-icon"><Icon name="users" :size="32" /></span>
        <h2>一起把故事写完整</h2>
        <p class="muted">
          把链接发给家人，对方登录并接受后，就能一起记录、编辑和成书。
        </p>
        <div
          v-if="busy"
          class="skeleton skeleton-line"
          aria-label="正在生成邀请链接"
        />
        <template v-if="inviteUrl"
          ><label class="field-label"
            >邀请链接<input
              :value="inviteUrl"
              readonly
              @focus="($event.target as HTMLInputElement).select()"
          /></label>
          <p class="muted text-small">
            有效至 {{ inviteExpiry }}；重新生成会使上一个链接失效。
          </p>
          <button class="button full-width" @click="copyInvite">
            {{ copied ? "已复制链接" : "复制邀请链接" }}
          </button></template
        >
        <p v-if="actionError" class="error" role="alert">{{ actionError }}</p>
        <button
          v-if="actionError && !inviteUrl"
          class="text-button"
          @click="invite"
        >
          重新生成
        </button></template
      >
    </ModalDialog>
  </template>
</template>
