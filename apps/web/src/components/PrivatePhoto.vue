<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { fetchVerifiedBlob } from "../private-media";
import { auth } from "../session";
import { WebApiError } from "../api";
const props = defineProps<{
  projectId: string;
  interviewId: string;
  photoId: string;
  asset: { id: string; bytes: number; sha256: string };
  alt: string;
}>();
const emit = defineEmits<{ denied: [] }>();
const url = ref(""),
  loading = ref(true),
  error = ref("");
let generation = 0,
  controller: AbortController | undefined;
function clear() {
  generation++;
  controller?.abort();
  if (url.value) URL.revokeObjectURL(url.value);
  url.value = "";
  loading.value = false;
}
const unsubscribe = auth.onClear(clear);
async function load() {
  clear();
  const current = generation;
  loading.value = true;
  error.value = "";
  controller = new AbortController();
  try {
    const blob = await fetchVerifiedBlob(
      `/projects/${props.projectId}/interviews/${props.interviewId}/photos/${props.photoId}/assets/${props.asset.id}/content`,
      props.asset,
      controller.signal,
    );
    if (current === generation) url.value = URL.createObjectURL(blob);
  } catch (reason) {
    if (current !== generation) return;
    error.value = "照片暂时无法读取，请重试。";
    if (
      reason instanceof WebApiError &&
      [401, 403, 404].includes(reason.status)
    )
      emit("denied");
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  () => [props.projectId, props.interviewId, props.photoId, props.asset.id],
  () => void load(),
  { immediate: true },
);
onUnmounted(() => {
  clear();
  unsubscribe();
});
</script>
<template>
  <div class="private-photo">
    <div
      v-if="loading"
      class="private-photo-placeholder skeleton"
      aria-label="正在读取照片"
      aria-busy="true"
    >
      <span class="spinner" />
    </div>
    <img
      v-else-if="url"
      :src="url"
      :alt="alt"
      @error="
        error = '照片未能显示，请重新读取。';
        clear();
      "
    />
    <div v-if="error" class="photo-error" role="alert">
      <p>{{ error }}</p>
      <button class="text-button" @click="load">重试读取照片</button>
    </div>
  </div>
</template>
