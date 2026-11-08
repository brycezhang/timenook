<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import type { PhotoMaterials } from "../../../../packages/contracts/src";
import { photoApi } from "../photo-api";
import { auth } from "../session";
import { WebApiError } from "../api";
import PrivatePhoto from "./PrivatePhoto.vue";
const props = defineProps<{
  projectId: string;
  interviewId: string;
  snapshotId?: string | null;
  recording?: boolean;
}>();
const emit = defineEmits<{ denied: [] }>();
const snapshot = ref<PhotoMaterials | null>(null),
  loading = ref(true),
  error = ref("");
let generation = 0;
function clear() {
  generation++;
  snapshot.value = null;
  loading.value = false;
  error.value = "";
}
const unsubscribe = auth.onClear(clear);
function denied() {
  clear();
  emit("denied");
}
async function load() {
  clear();
  const current = generation;
  loading.value = true;
  try {
    const value = props.snapshotId
      ? await photoApi.snapshot(
          props.projectId,
          props.interviewId,
          props.snapshotId,
        )
      : (await photoApi.list(props.projectId, props.interviewId)).snapshot;
    if (current === generation) snapshot.value = value;
  } catch (reason) {
    if (current !== generation) return;
    error.value = "照片暂时无法读取，请重试。";
    if (
      reason instanceof WebApiError &&
      [401, 403, 404].includes(reason.status)
    )
      denied();
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  () => [props.projectId, props.interviewId, props.snapshotId],
  () => void load(),
  { immediate: true },
);
onUnmounted(() => {
  clear();
  unsubscribe();
});
</script>
<template>
  <section
    v-if="loading || snapshot?.entries.length || error"
    class="story-photo-section"
    :class="{ 'recording-photos': recording }"
    aria-label="讲述照片"
  >
    <div
      v-if="loading"
      class="private-photo-placeholder skeleton"
      aria-busy="true"
      aria-label="正在读取照片"
    >
      <span class="spinner" />
    </div>
    <p v-if="error" class="notice error" role="alert">
      {{ error }}<button class="text-button" @click="load">重新读取照片</button>
    </p>
    <div v-if="snapshot?.entries.length" class="story-photo-gallery">
      <figure v-for="(entry, index) in snapshot.entries" :key="entry.photoId">
        <PrivatePhoto
          v-if="entry.assets.find((a) => a.kind === 'preview')"
          :project-id="projectId"
          :interview-id="interviewId"
          :photo-id="entry.photoId"
          :asset="entry.assets.find((a) => a.kind === 'preview')!"
          :alt="entry.caption || `故事照片 ${index + 1}`"
          @denied="denied"
        />
        <figcaption v-if="entry.caption">{{ entry.caption }}</figcaption>
      </figure>
    </div>
  </section>
</template>
