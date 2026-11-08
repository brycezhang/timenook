<script setup lang="ts">
import { onMounted } from "vue";
import { RouterLink } from "vue-router";
import { workspace } from "../workspace";
import ProjectCover from "../components/ProjectCover.vue";
import Icon from "../components/Icon.vue";
const projects = workspace.projects,
  loading = workspace.loading,
  error = workspace.error;
const load = workspace.refresh;
onMounted(() => {
  if (!loading.value) void load();
});
</script>
<template>
  <section class="page-heading">
    <h1>
      我的项目<span v-if="!loading && !error">{{ projects.length }}</span>
    </h1>
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
      :to="'/'"
      @click="workspace.select(project.projectId)"
      :aria-current="
        workspace.selectedId.value === project.projectId ? 'true' : undefined
      "
      :aria-label="`打开项目：${project.bookTitle}`"
      :key="project.projectId"
      class="project-card"
    >
      <div class="project-card-cover">
        <ProjectCover
          :project-id="project.projectId"
          :title="project.bookTitle"
        />
      </div>
      <div class="project-card-info">
        <span class="badge">{{
          project.origin === "purchased" ? "我购买的" : "受邀参与"
        }}</span>
        <h3>{{ project.bookTitle }}</h3>
        <span
          v-if="workspace.selectedId.value === project.projectId"
          class="current-project-note"
          ><Icon name="check" :size="13" />当前项目</span
        ><span class="project-open"
          >打开项目<Icon name="arrow" :size="16"
        /></span>
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
