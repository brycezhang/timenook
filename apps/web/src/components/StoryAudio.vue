<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import type { StoryRecord } from "../project-api";
import { recordingApi } from "../recording-api";
import { auth } from "../session";
import { WebApiError } from "../api";
const props = defineProps<{ projectId: string; story: StoryRecord }>();
const emit = defineEmits<{ denied: [] }>();
const clips = ref<string[]>([]),
  url = ref(""),
  busy = ref(""),
  error = ref("");
const audio = ref<HTMLAudioElement>();
let generation = 0;
function clear() {
  generation++;
  audio.value?.pause();
  audio.value?.removeAttribute("src");
  audio.value?.load();
  if (url.value) URL.revokeObjectURL(url.value);
  url.value = "";
  clips.value = [];
  busy.value = "";
  error.value = "";
}
const unsubscribe = auth.onClear(clear);
function failure(reason: unknown, current: number) {
  if (current !== generation) return;
  if (
    reason instanceof WebApiError &&
    [401, 403, 404].includes(reason.status)
  ) {
    clear();
    emit("denied");
    return;
  }
  error.value =
    reason instanceof Error ? reason.message : "原声暂时无法读取，请重试。";
}
async function load() {
  clear();
  const current = generation;
  try {
    const source = props.story.revision?.audioManifest;
    if (source) {
      // The private recording gateway is addressed by the upload intent ID.
      clips.value = [...new Set(source.map((clip) => clip.intentId))];
      return;
    }
    const interview = await recordingApi.resume(
      props.projectId,
      props.story.interviewId,
    );
    if (current === generation)
      clips.value = interview.clips
        .filter((clip) => clip.state === "sealed")
        .map((clip) => clip.id);
  } catch (reason) {
    failure(reason, current);
  }
}
async function play(clipId: string) {
  const current = generation;
  audio.value?.pause();
  audio.value?.removeAttribute("src");
  audio.value?.load();
  if (url.value) URL.revokeObjectURL(url.value);
  url.value = "";
  error.value = "";
  busy.value = clipId;
  try {
    const blob = await recordingApi.original(
      props.projectId,
      props.story.interviewId,
      clipId,
    );
    if (current === generation) url.value = URL.createObjectURL(blob);
  } catch (reason) {
    failure(reason, current);
  } finally {
    if (current === generation) busy.value = "";
  }
}
watch(
  () => [props.projectId, props.story.id, props.story.version],
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
    v-if="clips.length || error"
    class="story-audio panel"
    aria-label="故事原声"
  >
    <h2>听听这段声音</h2>
    <div class="hero-actions">
      <button
        v-for="(clip, index) in clips"
        :key="clip"
        class="button secondary"
        :disabled="!!busy"
        @click="play(clip)"
      >
        <span v-if="busy === clip" class="spinner" />{{
          index === 0 ? "回听原声" : `回听第 ${index + 1} 段原声`
        }}
      </button>
    </div>
    <p v-if="error" class="notice error" role="alert">{{ error }}</p>
    <audio
      v-if="url"
      ref="audio"
      :src="url"
      controls
      preload="metadata"
      aria-label="故事原声"
      @error="error = '原声播放未成功，请重新读取后重试。'"
    />
  </section>
</template>
