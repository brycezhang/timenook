<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import type { BookAudioEntryView } from "../../../../packages/contracts/src";
import { bookApi } from "../book-api";
import { projectError } from "../project-api";
import { fetchVerifiedBlob } from "../private-media";
import { auth } from "../session";
import { workspace } from "../workspace";
import { WebApiError } from "../api";
import Icon from "../components/Icon.vue";
import "../book.css";
const route = useRoute(),
  entryId = computed(() => String(route.params.entryId));
const entry = ref<BookAudioEntryView | null>(null),
  loading = ref(true),
  error = ref("");
const playing = ref<string | null>(null),
  busy = ref<string | null>(null),
  audio = ref<HTMLAudioElement | null>(null),
  audioUrl = ref("");
let sequence = 0,
  timer: ReturnType<typeof setTimeout> | undefined,
  expiry: ReturnType<typeof setTimeout> | undefined;
let controller = new AbortController();
function stop() {
  controller.abort();
  controller = new AbortController();
  audio.value?.pause();
  if (audio.value) {
    audio.value.removeAttribute("src");
    audio.value.load();
  }
  if (audioUrl.value) URL.revokeObjectURL(audioUrl.value);
  audioUrl.value = "";
  playing.value = null;
  busy.value = null;
}
function clear() {
  sequence++;
  clearTimeout(timer);
  clearTimeout(expiry);
  stop();
  entry.value = null;
}
const offClear = auth.onClear(clear);
async function load(initial = false) {
  const token = sequence;
  if (initial) loading.value = true;
  error.value = "";
  try {
    const value = await bookApi.audio(entryId.value);
    if (token !== sequence) return;
    if (
      entry.value &&
      (entry.value.accessEpoch !== value.accessEpoch ||
        JSON.stringify(entry.value.clips) !== JSON.stringify(value.clips))
    )
      stop();
    entry.value = value;
    workspace.select(value.projectId);
    clearTimeout(expiry);
    if (value.accessExpiresAt)
      expiry = setTimeout(
        () => {
          clear();
          error.value = "原声访问已失效，请重新读取。";
        },
        Math.max(0, Date.parse(value.accessExpiresAt) - Date.now()),
      );
    clearTimeout(timer);
    timer = setTimeout(() => void load(), 10000);
  } catch (cause) {
    if (
      token !== sequence ||
      (cause instanceof DOMException && cause.name === "AbortError")
    )
      return;
    clear();
    error.value = projectError(cause);
  } finally {
    loading.value = false;
  }
}
async function play(clipId: string) {
  if (!entry.value || busy.value) return;
  if (playing.value === clipId && audio.value) {
    if (audio.value.paused)
      await audio.value.play().catch(() => {
        error.value = "播放未能开始，请再试一次。";
      });
    else audio.value.pause();
    return;
  }
  stop();
  busy.value = clipId;
  error.value = "";
  const token = sequence,
    signal = controller.signal;
  try {
    // Resolve again before every playback, including a fixed historical entry.
    const current = await bookApi.audio(entryId.value);
    if (token !== sequence || signal.aborted) return;
    entry.value = current;
    const clip = current.clips.find((item) => item.clipId === clipId);
    if (!clip) throw new Error("这一段原声已不可用，请重新读取。");
    const blob = await fetchVerifiedBlob(
      `/book-audio/${entryId.value}/clips/${clipId}/content?epoch=${current.accessEpoch}`,
      clip,
      signal,
    );
    if (token !== sequence || signal.aborted) return;
    audioUrl.value = URL.createObjectURL(blob);
    playing.value = clipId;
    await nextTick();
    await audio.value?.play();
  } catch (cause) {
    if (token !== sequence || signal.aborted) return;
    stop();
    if (cause instanceof WebApiError && [401, 403, 404].includes(cause.status))
      clear();
    error.value = projectError(cause);
  } finally {
    if (token === sequence) busy.value = null;
  }
}
function visibility() {
  if (document.hidden) stop();
  else void load();
}
document.addEventListener("visibilitychange", visibility);
watch(
  entryId,
  () => {
    clear();
    void load(true);
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  offClear();
  clear();
  document.removeEventListener("visibilitychange", visibility);
});
const duration = (ms: number) =>
  `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, "0")}`;
</script>
<template>
  <section class="book-page book-audio-page">
    <RouterLink
      v-if="entry"
      class="back-link"
      :to="`/projects/${entry.projectId}/book`"
      >← 返回书稿</RouterLink
    >
    <header class="book-heading">
      <div>
        <h1>书中原声</h1>
      </div>
      <Icon name="mic" :size="32" />
    </header>
    <div v-if="error" class="notice" role="alert">
      {{ error
      }}<button class="text-button" @click="load(true)">重新读取</button>
    </div>
    <div
      v-if="loading && !entry"
      class="book-card"
      aria-busy="true"
      aria-label="正在读取原声"
    >
      <div class="skeleton skeleton-line" />
      <div class="skeleton skeleton-line" />
    </div>
    <section v-else-if="entry" class="book-card">
      <span class="badge neutral">对应故事第 {{ entry.story.version }} 版</span>
      <h2>{{ entry.story.title }}</h2>
      <div
        v-for="(clip, index) in entry.clips"
        :key="clip.clipId"
        class="book-audio-clip"
      >
        <span
          >第 {{ index + 1 }} 段
          <small>{{ duration(clip.durationMs) }}</small></span
        ><button
          class="button secondary small"
          :disabled="!!busy"
          :aria-label="`播放第 ${index + 1} 段`"
          @click="play(clip.clipId)"
        >
          <span v-if="busy === clip.clipId" class="book-spinner" /><Icon
            v-else
            name="mic"
            :size="16"
          />{{
            busy === clip.clipId
              ? "正在读取"
              : playing === clip.clipId
                ? "播放 / 暂停"
                : "播放原声"
          }}
        </button>
      </div>
      <audio
        v-if="audioUrl"
        ref="audio"
        :src="audioUrl"
        controls
        preload="metadata"
        aria-label="书中原声播放器"
        @error="
          error = '原声播放失败，请重新读取。';
          stop();
        "
      />
    </section>
  </section>
</template>
