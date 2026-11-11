<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import type { BookContext } from "../../../../packages/contracts/src";
import { bookApi } from "../book-api";
import { auth } from "../session";
import { WebApiError } from "../api";
import PrivatePhoto from "./PrivatePhoto.vue";
const props = defineProps<{ projectId: string; title: string }>();
const emit = defineEmits<{ denied: [] }>();
const context = ref<BookContext | null>(null),
  loading = ref(true),
  error = ref(false);
let generation = 0;
const clear = auth.onClear(() => {
  generation++;
  context.value = null;
});
const photo = computed(() =>
  context.value?.coverPhotoOptions.find(
    (value) => value.assetId === context.value?.cover.photoAssetId,
  ),
);
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = false;
  try {
    const result = await bookApi.context(props.projectId);
    if (current === generation) context.value = result;
  } catch (reason) {
    if (current !== generation) return;
    context.value = null;
    error.value = true;
    if (reason instanceof WebApiError && [401, 403].includes(reason.status))
      emit("denied");
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  () => props.projectId,
  () => {
    context.value = null;
    void load();
  },
  { immediate: true },
);
onUnmounted(() => {
  generation++;
  clear();
});
</script>
<template>
  <div class="project-cover">
    <span>时光故事 · 岁月成书</span>
    <h2>{{ title }}</h2>
    <div class="cover-line" />
    <div
      v-if="loading"
      class="skeleton project-cover-photo"
      aria-label="正在读取封面"
    />
    <div v-else-if="error" class="cover-read-error">
      <span>封面暂时无法读取</span
      ><button class="text-button" @click="load">重试</button>
    </div>
    <PrivatePhoto
      v-else-if="photo"
      class="project-cover-photo"
      :project-id="projectId"
      :photo-id="photo.id"
      :asset="{ id: photo.assetId, bytes: photo.bytes, sha256: photo.sha256 }"
      alt="故事书封面照片"
      @denied="emit('denied')"
    />
    <small>{{ context?.cover.salutation || "爱与岁月的故事" }}</small>
  </div>
</template>
<style scoped>
.project-cover-photo {
  width: 100%;
  max-height: 110px;
  min-height: 70px;
  overflow: hidden;
}
.project-cover-photo :deep(img) {
  width: 100%;
  max-height: 110px;
  object-fit: contain;
}
.cover-read-error {
  color: var(--muted);
  font-size: 11px;
}
.project-cover small {
  overflow-wrap: anywhere;
}
</style>
