<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { auth } from "../session";
import type { ProjectSummary } from "../api";
import Icon from "../components/Icon.vue";
const projects = ref<ProjectSummary[]>([]),
  loading = ref(true),
  error = ref("");
let generation = 0;
const clear = auth.onClear(() => {
  generation++;
  projects.value = [];
});
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const list = await auth.projects();
    if (generation === current) projects.value = list;
  } catch (reason) {
    if (generation === current)
      error.value =
        reason instanceof Error ? reason.message : "项目读取失败，请重试。";
  } finally {
    if (generation === current) loading.value = false;
  }
}
watch(
  () => auth.account.value?.session.id,
  () => {
    if (auth.account.value) void load();
  },
  { immediate: true },
);
onUnmounted(() => {
  generation++;
  clear();
});
</script>
<template>
  <section class="page-heading">
    <p class="eyebrow">家人的故事，随时接着记录</p>
    <h1>
      我的项目<span v-if="!loading && !error">{{ projects.length }}</span>
    </h1>
    <p class="muted">购买和受邀参与的故事书，都在这里。</p>
    <RouterLink class="button secondary" to="/purchase"
      >新购一本书<Icon name="plus" :size="16"
    /></RouterLink>
  </section>
  <section
    v-if="loading && !projects.length"
    class="project-grid"
    aria-busy="true"
    aria-label="正在读取我的项目"
  >
    <div v-for="i in 3" :key="i" class="project-card skeleton-card">
      <div class="skeleton skeleton-cover" />
      <div class="skeleton skeleton-line" />
      <div class="skeleton skeleton-line short" />
    </div>
  </section>
  <div v-if="error" class="notice error" role="alert">
    {{ error }}<button class="text-button" @click="load">重新读取</button>
  </div>
  <section v-if="projects.length" class="project-grid" aria-label="我的项目">
    <RouterLink
      v-for="project in projects"
      :to="`/projects/${project.projectId}`"
      :aria-label="`打开项目：${project.bookTitle}`"
      :key="project.projectId"
      class="project-card"
    >
      <div class="project-cover">
        <span>时光故事 · 岁月成书</span>
        <h2>{{ project.bookTitle }}</h2>
        <div class="cover-line" />
        <Icon name="book" :size="32" /><small>家人的讲述 · 珍藏的回忆</small>
      </div>
      <div class="project-card-info">
        <span class="badge">{{
          project.origin === "purchased" ? "我购买的" : "受邀参与"
        }}</span>
        <h3>{{ project.bookTitle }}</h3>
        <p class="muted">与小程序共享同一个项目</p>
      </div>
    </RouterLink>
  </section>
  <section v-else-if="!loading && !error" class="empty-state panel">
    <span class="empty-icon"><Icon name="book" :size="32" /></span>
    <h2>第一本故事书，从这里开始。</h2>
    <p>你还没有项目。新购一本书，<br />或接受家人的邀请后，在这里继续记录。</p>
    <RouterLink class="button secondary" to="/sample"
      >先翻翻样书<Icon name="arrow" :size="16"
    /></RouterLink>
  </section>
</template>
