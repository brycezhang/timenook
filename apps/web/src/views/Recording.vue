<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import {
  RouterLink,
  onBeforeRouteLeave,
  onBeforeRouteUpdate,
  useRoute,
  useRouter,
} from "vue-router";
import type {
  ProductionTaskView,
  RecordingContext,
  RecordingInterview,
  StoryContext,
} from "../../../../packages/contracts/src";
import { MAX_RECORDING_DURATION_MS } from "../../../../packages/contracts/src/recording";
import { createMp3Recorder } from "../../../../packages/browser-media/src/browser-recorder";
import { recordingApi } from "../recording-api";
import {
  recordingStore,
  audioDigest,
  type LocalRecording,
  type RecordingDraft,
} from "../recording-store";
import { auth } from "../session";
import { WebApiError } from "../api";
import Icon from "../components/Icon.vue";
import ModalDialog from "../components/ModalDialog.vue";
import StoryPhotoGallery from "../components/StoryPhotoGallery.vue";
import "../recording.css";

const route = useRoute(),
  router = useRouter();
const projectId = computed(() => String(route.params.projectId));
const context = ref<RecordingContext | null>(null),
  interview = ref<RecordingInterview | null>(null);
const clips = ref<LocalRecording[]>([]),
  recoveries = ref<LocalRecording[]>([]);
const tasks = ref<ProductionTaskView[]>([]),
  story = ref<StoryContext | null>(null);
const loading = ref(true),
  error = ref(""),
  processingError = ref(""),
  denied = ref(false);
const recordingLimitSeconds = ref(0);
const stage = ref("idle"),
  custom = ref(false),
  customText = ref(""),
  questionKey = ref("");
const seconds = ref(0),
  audioUrl = ref(""),
  audioBusy = ref(""),
  audioError = ref("");
const audio = ref<HTMLAudioElement>();
const persistedDraft = ref(false);
const topicPicker = ref(false);
let previousTopic = { custom: false, text: "", key: "" };
function openTopics() {
  previousTopic = {
    custom: custom.value,
    text: customText.value,
    key: questionKey.value,
  };
  topicPicker.value = true;
}
function cancelTopics() {
  custom.value = previousTopic.custom;
  customText.value = previousTopic.text;
  questionKey.value = previousTopic.key;
  topicPicker.value = false;
}
let generation = 0,
  disposed = false,
  ownerSession = "",
  draftId = "";
let loadedProject = "";
let recorder: ReturnType<typeof createMp3Recorder> | undefined;
let pending: LocalRecording | undefined;
let finishResolve: (() => void) | undefined,
  finishPromise: Promise<void> | undefined;
let pollTimer: ReturnType<typeof setTimeout> | undefined;
let processingSequence = 0;
let captureBegan = 0,
  elapsed = 0,
  draft: RecordingDraft | undefined;
const busy = computed(() =>
  ["requesting", "saving", "uploading"].includes(stage.value),
);
const capturing = computed(() => ["recording", "paused"].includes(stage.value));
const question = computed(
  () =>
    interview.value?.currentQuestion.snapshot.text ??
    (custom.value
      ? customText.value
      : (context.value?.plan.eligibleQuestions.find(
          (q) => q.key === questionKey.value,
        )?.text ?? "")),
);
function recordingTime(seconds: number) {
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, "0")}:${Math.floor(seconds % 60)
    .toString()
    .padStart(2, "0")}`;
}
const time = computed(() => recordingTime(seconds.value));
const unuploaded = computed(() => clips.value.filter((clip) => !clip.sealed));
const sources = computed(() => {
  const rows = new Map<string, { id: string; local?: LocalRecording }>();
  for (const clip of interview.value?.clips ?? [])
    if (clip.state === "sealed") rows.set(clip.clientClipId, { id: clip.id });
  for (const clip of clips.value)
    rows.set(clip.clientClipId, {
      id: clip.serverId ?? clip.clientClipId,
      local: clip,
    });
  return [...rows.values()];
});
const ready = computed(
  () =>
    !!story.value?.story?.currentRevisionId &&
    story.value.story.task?.state === "succeeded" &&
    !unuploaded.value.length,
);
const taskIssue = computed(() =>
  tasks.value.find((task) =>
    [
      "failed",
      "manual_review",
      "invalidated",
      "no_speech",
      "no_content",
      "obsolete",
    ].includes(task.state),
  ),
);
const processingTitle = computed(() =>
  ready.value
    ? "故事已整理好"
    : taskIssue.value
      ? taskLabel(taskIssue.value)
      : "正在整理这段讲述",
);
const current = (version: number) =>
  !disposed &&
  version === generation &&
  auth.account.value?.session.id === ownerSession;
function closeAudio() {
  audio.value?.pause();
  audio.value?.removeAttribute("src");
  audio.value?.load();
  if (audioUrl.value) URL.revokeObjectURL(audioUrl.value);
  audioUrl.value = "";
}
function clearView() {
  generation++;
  clearTimeout(pollTimer);
  recorder?.dispose();
  closeAudio();
  context.value = null;
  interview.value = null;
  clips.value = [];
  recoveries.value = [];
  tasks.value = [];
  story.value = null;
  audioError.value = "";
}
const unsubscribe = auth.onClear(clearView);
function message(reason: unknown) {
  return reason instanceof Error ? reason.message : "操作未完成，请重试。";
}
function failed(reason: unknown, version: number) {
  if (!current(version)) return;
  if (
    reason instanceof WebApiError &&
    [401, 403, 404].includes(reason.status)
  ) {
    clearView();
    denied.value = true;
    loading.value = false;
  }
  error.value = message(reason);
}
async function load() {
  clearView();
  const version = generation;
  ownerSession = auth.account.value?.session.id ?? "";
  loadedProject = projectId.value;
  persistedDraft.value = false;
  const userId = auth.account.value?.user.id;
  if (!userId) return;
  loading.value = true;
  denied.value = false;
  error.value = "";
  processingError.value = "";
  topicPicker.value = false;
  stage.value = "idle";
  seconds.value = 0;
  try {
    const value = await recordingApi.context(projectId.value);
    if (!current(version)) return;
    context.value = value;
    const saved = await recordingStore.clips(userId, projectId.value);
    if (!current(version)) return;
    recoveries.value = saved.filter((clip) => !clip.sealed);
    const id =
      typeof route.query.interviewId === "string"
        ? route.query.interviewId
        : "";
    if (id) {
      const value = await recordingApi.resume(projectId.value, id);
      if (!current(version)) return;
      interview.value = value;
      clips.value = saved
        .filter((clip) => clip.interviewId === id)
        .sort((a, b) => a.createdAt - b.createdAt);
      seconds.value = Math.round((clips.value.at(-1)?.durationMs ?? 0) / 1000);
      if (unuploaded.value.length) stage.value = "upload-error";
      if (value.clips.some((clip) => clip.state === "sealed"))
        void refreshProcessing();
    } else {
      draftId =
        typeof route.query.draftId === "string" &&
        /^[a-f0-9-]{36}$/.test(route.query.draftId)
          ? route.query.draftId
          : crypto.randomUUID();
      if (route.query.draftId !== draftId)
        await router.replace({ query: { ...route.query, draftId } });
      draft = await recordingStore.draft(draftId, userId, projectId.value);
      if (!current(version)) return;
      persistedDraft.value = !!draft;
      custom.value = !!draft?.input.selfWritten;
      customText.value = draft?.input.selfWritten?.text ?? "";
      questionKey.value =
        draft?.input.questionKey ??
        value.plan.eligibleQuestions.find(
          (q) => q.key === route.query.questionKey,
        )?.key ??
        value.plan.defaultQuestion?.key ??
        "";
    }
  } catch (reason) {
    failed(reason, version);
  } finally {
    if (version === generation) loading.value = false;
  }
}
watch(
  () => [
    projectId.value,
    route.query.interviewId,
    route.query.draftId,
    auth.account.value?.session.id,
  ],
  () => {
    if (
      auth.account.value &&
      !(
        context.value &&
        loadedProject === projectId.value &&
        ownerSession === auth.account.value.session.id &&
        (route.query.interviewId
          ? interview.value?.id === route.query.interviewId
          : !interview.value && route.query.draftId === draftId)
      )
    )
      void load();
  },
  { immediate: true },
);

async function start() {
  if (
    busy.value ||
    capturing.value ||
    pending ||
    unuploaded.value.length ||
    !context.value?.canRecord ||
    !question.value.trim()
  )
    return;
  const version = generation,
    userId = auth.account.value!.user.id,
    project = projectId.value;
  error.value = "";
  stage.value = "requesting";
  closeAudio();
  try {
    if (!interview.value) {
      // Keep an unknown create result tied to exactly the same command on refresh.
      if (!draft) {
        draft = {
          id: draftId,
          userId,
          projectId: project,
          input: {
            clientInterviewId: draftId,
            expectedPlanRevision: context.value.plan.revision,
            ...(custom.value
              ? {
                  selfWritten: {
                    text: customText.value.trim(),
                    intent: "记录一段自己的经历",
                  },
                }
              : { questionKey: questionKey.value }),
          },
        };
        await recordingStore.saveDraft(draft);
        persistedDraft.value = true;
      }
      const value = await recordingApi.start(project, draft.input, draftId);
      if (!current(version)) return;
      interview.value = value;
      await router.replace({ query: { interviewId: value.id } });
    }
    const selected = interview.value!;
    const permission = await recordingApi.authorize(project, selected);
    if (!current(version)) return;
    if (
      !permission.allowed ||
      permission.actualQuestionId !== selected.currentQuestion.id ||
      permission.questionVersion !== selected.questionVersion ||
      !Number.isSafeInteger(permission.maxDurationMs) ||
      permission.maxDurationMs < 1 ||
      permission.maxDurationMs > MAX_RECORDING_DURATION_MS
    )
      throw Error("暂时无法开始录音，请重新读取项目。");
    const clientClipId = crypto.randomUUID(),
      actualQuestionId = permission.actualQuestionId;
    let captured: Blob | undefined;
    recorder?.dispose();
    recorder = createMp3Recorder((blob) => {
      captured = blob;
      return "captured";
    });
    finishPromise = new Promise<void>((resolve) => {
      finishResolve = resolve;
    });
    recorder.onStart(() => {
      if (current(version)) {
        elapsed = 0;
        seconds.value = 0;
        captureBegan = Date.now();
        stage.value = "recording";
      }
    });
    recorder.onPause(() => {
      if (current(version)) {
        elapsed += Date.now() - captureBegan;
        stage.value = "paused";
      }
    });
    recorder.onResume(() => {
      if (current(version)) {
        captureBegan = Date.now();
        stage.value = "recording";
      }
    });
    recorder.onStopping(() => {
      if (current(version)) stage.value = "saving";
    });
    recorder.onInterruptionBegin(() => {
      if (current(version)) error.value = "录音已中断，正在保存已录下的声音。";
    });
    recorder.onError((reason: { errMsg: string }) => {
      if (current(version)) {
        error.value = reason.errMsg;
        stage.value = "idle";
      }
      finishResolve?.();
    });
    recorder.onStop((result: { duration: number }) => {
      if (!captured) {
        finishResolve?.();
        return;
      }
      pending = {
        clientClipId,
        userId,
        projectId: project,
        interviewId: selected.id,
        actualQuestionId,
        blob: captured,
        durationMs: result.duration,
        sha256: "",
        createdAt: Date.now(),
      };
      void persist(version);
    });
    recordingLimitSeconds.value = Math.ceil(permission.maxDurationMs / 1000);
    void recorder.start({ duration: permission.maxDurationMs });
  } catch (reason) {
    if (current(version)) {
      stage.value = "idle";
      failed(reason, version);
    }
  }
}
function newDraft() {
  void router.replace({ query: { draftId: crypto.randomUUID() } });
}
async function persist(version = generation) {
  const clip = pending;
  if (!clip) return;
  if (current(version)) stage.value = "saving";
  try {
    clip.sha256 ||= await audioDigest(clip.blob);
    await recordingStore.save(clip);
    pending = undefined;
    if (current(version)) {
      clips.value = [
        ...clips.value.filter((row) => row.clientClipId !== clip.clientClipId),
        clip,
      ];
      seconds.value = Math.round(clip.durationMs / 1000);
      stage.value = "saved";
      void upload();
    }
  } catch (reason) {
    if (current(version)) {
      stage.value = "save-error";
      error.value = message(reason);
    }
  } finally {
    finishResolve?.();
  }
}
async function saveClip(clip: LocalRecording, version: number) {
  await recordingStore.save(clip);
  if (current(version))
    clips.value = clips.value.map((row) =>
      row.clientClipId === clip.clientClipId ? clip : row,
    );
}
async function upload() {
  if (busy.value || capturing.value || !unuploaded.value.length) return;
  const version = generation;
  stage.value = "uploading";
  error.value = "";
  try {
    for (const clip of [...unuploaded.value]) {
      await recordingApi.upload(
        clip,
        (saved) => saveClip(saved, version),
        () => current(version),
      );
      if (!current(version)) return;
    }
    stage.value = "saved";
    const value = await recordingApi.resume(
      projectId.value,
      interview.value!.id,
    );
    if (current(version)) {
      interview.value = value;
      void refreshProcessing();
    }
  } catch (reason) {
    if (current(version)) {
      stage.value = "upload-error";
      failed(reason, version);
    }
  }
}
function taskLabel(task: ProductionTaskView) {
  if (task.state === "no_speech") return "未识别到清晰语音，可以回听后再录一段";
  if (task.state === "no_content")
    return "这段讲述还不足以整理故事，可以继续补充";
  if (task.state === "manual_review")
    return "处理需要人工协助，请通过使用条款中的方式联系支持";
  if (["invalidated", "obsolete"].includes(task.state))
    return "讲述素材已变化，请重新读取";
  if (task.state === "failed")
    return task.retryable
      ? "文字处理暂未完成，可以重试"
      : "文字处理未完成，请联系支持";
  const name = task.kind === "compose_story" ? "整理故事" : "转写录音";
  return `${name} · ${task.state === "succeeded" ? "已完成" : task.state === "queued" || task.state === "waiting_inputs" ? "等待处理" : "处理中"}`;
}
async function refreshProcessing() {
  const id = interview.value?.id;
  if (!id) return;
  const version = generation;
  const sequence = ++processingSequence;
  clearTimeout(pollTimer);
  try {
    const [rows, value] = await Promise.all([
      recordingApi.tasks(projectId.value, id),
      recordingApi.story(projectId.value, id),
    ]);
    if (
      value.story?.task &&
      !rows.some((task) => task.id === value.story!.task!.id)
    )
      rows.push(await recordingApi.task(projectId.value, value.story.task.id));
    if (!current(version) || sequence !== processingSequence) return;
    tasks.value = rows;
    story.value = value;
    processingError.value = "";
    if (!ready.value && !taskIssue.value)
      pollTimer = setTimeout(() => {
        void refreshProcessing();
      }, 2000);
  } catch (reason) {
    if (!current(version) || sequence !== processingSequence) return;
    if (
      reason instanceof WebApiError &&
      [401, 403, 404].includes(reason.status)
    )
      failed(reason, version);
    else processingError.value = message(reason);
  }
}
async function retryTask() {
  const task = taskIssue.value;
  if (!task?.retryable || busy.value) return;
  const version = generation;
  stage.value = "requesting";
  try {
    await recordingApi.retry(projectId.value, task.id);
    if (current(version)) await refreshProcessing();
  } catch (reason) {
    failed(reason, version);
  } finally {
    if (current(version)) stage.value = "saved";
  }
}
async function playback(source: { id: string; local?: LocalRecording }) {
  if (audioBusy.value) return;
  const version = generation,
    id = interview.value!.id;
  closeAudio();
  audioError.value = "";
  audioBusy.value = source.id;
  try {
    let blob: Blob;
    if (source.local && !source.local.sealed) {
      const allowed = await recordingApi.collection(projectId.value, id);
      if (
        !allowed.allowed ||
        (await audioDigest(source.local.blob)) !== source.local.sha256
      )
        throw Error("本机原声校验未通过，请重试。");
      blob = source.local.blob;
    } else blob = await recordingApi.original(projectId.value, id, source.id);
    if (current(version)) audioUrl.value = URL.createObjectURL(blob);
  } catch (reason) {
    if (current(version)) {
      if (
        reason instanceof WebApiError &&
        [401, 403, 404].includes(reason.status)
      )
        failed(reason, version);
      else audioError.value = message(reason);
    }
  } finally {
    if (current(version)) audioBusy.value = "";
  }
}
const clock = setInterval(() => {
  if (stage.value === "recording")
    seconds.value = Math.floor((elapsed + Date.now() - captureBegan) / 1000);
}, 250);
async function finishBeforeLeaving() {
  if (capturing.value || stage.value === "saving") {
    recorder?.stop();
    await finishPromise;
  }
  return !pending;
}
function beforeUnload(event: BeforeUnloadEvent) {
  if (capturing.value || stage.value === "saving" || pending) {
    event.preventDefault();
    event.returnValue = "";
  }
}
window.addEventListener("beforeunload", beforeUnload);
onBeforeRouteLeave(finishBeforeLeaving);
onBeforeRouteUpdate(async (to, from) => {
  if (
    to.params.projectId !== from.params.projectId ||
    (interview.value && to.query.interviewId !== interview.value.id)
  )
    return finishBeforeLeaving();
  return true;
});
onUnmounted(() => {
  disposed = true;
  clearView();
  unsubscribe();
  clearInterval(clock);
  window.removeEventListener("beforeunload", beforeUnload);
});
</script>

<template>
  <div
    class="recording-page"
    :class="{
      'photo-recording-page': interview?.actualQuestion.starterKind === 'photo',
    }"
  >
    <RouterLink class="recording-back" :to="`/projects/${projectId}`"
      >← 返回项目</RouterLink
    >
    <header
      v-if="interview?.actualQuestion.starterKind !== 'photo'"
      class="page-heading"
    >
      <h1>记录一段回忆</h1>
    </header>
    <header v-else class="page-heading"><h1>看着照片，讲一讲</h1></header>
    <section
      v-if="loading"
      class="recording-panel panel"
      aria-busy="true"
      aria-label="正在准备录音"
    >
      <div class="skeleton skeleton-line" />
      <div class="skeleton skeleton-line short" />
      <div class="recording-skeleton skeleton" />
    </section>
    <div v-if="error" class="notice error" role="alert">
      {{ error
      }}<button
        v-if="!capturing && !busy && !pending"
        class="text-button"
        @click="load"
      >
        重新读取
      </button>
    </div>
    <template v-if="!loading && context && !denied">
      <section
        v-if="!interview && recoveries.length"
        class="panel recording-recovery"
      >
        <h2>还有录音等待上传</h2>
        <p class="muted">声音已保存在当前账号的本机空间，可以接着上传。</p>
        <RouterLink
          v-for="clip in recoveries"
          :key="clip.clientClipId"
          class="text-button"
          :to="{ path: route.path, query: { interviewId: clip.interviewId } }"
          >继续保存
          {{ new Date(clip.createdAt).toLocaleDateString("zh-CN") }} 的讲述
          →</RouterLink
        >
      </section>
      <section class="recording-panel panel" :aria-busy="busy">
        <StoryPhotoGallery
          v-if="interview?.actualQuestion.starterKind === 'photo'"
          :project-id="projectId"
          :interview-id="interview.id"
          recording
          @denied="failed(new WebApiError(403), generation)"
        />
        <h2
          v-if="interview?.actualQuestion.starterKind !== 'photo'"
          class="recording-question"
        >
          {{ question || "选择一个想讲的话题" }}
        </h2>
        <div class="recording-mic" aria-hidden="true">
          <Icon name="mic" :size="32" />
        </div>
        <div class="recording-controls">
          <div
            class="recording-timer"
            :class="{ live: stage === 'recording' }"
            aria-label="录音时长"
          >
            {{ time
            }}<span v-if="capturing" class="recording-limit">
              / {{ recordingTime(recordingLimitSeconds) }}</span
            >
          </div>
          <p v-if="stage === 'paused'" class="muted" role="status">已暂停</p>
          <p v-else-if="stage === 'recording'" class="muted" role="status">
            正在录音
          </p>
          <p v-else-if="stage === 'saving'" class="muted" role="status">
            <span class="recording-spinner" />正在保存这段声音，请稍候。
          </p>
          <p v-else-if="stage === 'requesting'" class="muted" role="status">
            <span class="recording-spinner" />正在准备麦克风，请允许录音。
          </p>
          <div v-if="capturing" class="recording-actions">
            <button
              v-if="stage === 'recording'"
              class="button secondary"
              @click="recorder?.pause()"
            >
              暂停录音
            </button>
            <button v-else class="button secondary" @click="recorder?.resume()">
              继续录音
            </button>
            <button class="button" @click="recorder?.stop()">
              <span class="recording-stop" />结束录音
            </button>
          </div>
          <button
            v-else-if="stage === 'save-error'"
            class="button"
            @click="persist()"
          >
            重试保存
          </button>
          <template v-else-if="unuploaded.length">
            <p v-if="stage === 'uploading'" class="muted" role="status">
              <span class="recording-spinner" />正在上传录音，声音已保存在本机。
            </p>
            <p v-else class="muted">
              声音已保存在本机，上传后会自动整理成故事。
            </p>
            <button class="button" :disabled="busy" @click="upload">
              {{ stage === "uploading" ? "正在上传" : "重试上传" }}
            </button>
          </template>
          <button
            v-else
            class="button recording-start"
            :disabled="busy || !context.canRecord || !question.trim()"
            @click="start"
          >
            <Icon name="mic" :size="22" />{{
              interview?.clips.length ? "再补充一段" : "开始录音"
            }}
          </button>
          <p
            v-if="context.canRecord && stage === 'idle' && !unuploaded.length"
            class="muted recording-limit-hint"
          >
            单段最长 {{ MAX_RECORDING_DURATION_MS / 60000 }} 分钟，到时自动保存
          </p>
          <p v-if="!context.canRecord" class="notice">
            当前项目暂时无法新增录音。
          </p>
        </div>
        <div v-if="!interview" class="recording-shortcuts">
          <button
            class="text-button"
            :disabled="busy || persistedDraft"
            @click="openTopics"
          >
            换个话题
          </button>
          <RouterLink class="text-button" :to="`/projects/${projectId}/photos`"
            >从照片说起<Icon name="arrow" :size="15"
          /></RouterLink>
          <button
            v-if="persistedDraft"
            class="text-button"
            :disabled="busy"
            @click="newDraft"
          >
            重新选题
          </button>
        </div>
        <ModalDialog
          v-if="topicPicker"
          title="选一个想讲的话题"
          @close="cancelTopics"
        >
          <div v-if="!custom" class="recording-topics" aria-label="讲述话题">
            <button
              v-for="item in context.plan.eligibleQuestions"
              :key="item.key"
              class="recording-topic"
              :class="{ selected: questionKey === item.key }"
              :aria-pressed="questionKey === item.key"
              :disabled="busy || persistedDraft"
              @click="questionKey = item.key"
            >
              <span>{{ item.text }}</span
              ><Icon v-if="questionKey === item.key" name="check" :size="18" />
            </button>
          </div>
          <label v-else class="recording-custom"
            >想讲的话题<textarea
              v-model="customText"
              rows="3"
              maxlength="2000"
              :disabled="busy || persistedDraft"
              placeholder="比如：小时候，家里最热闹的一天是什么样？"
            />
          </label>
          <button
            class="text-button"
            :disabled="busy || persistedDraft"
            @click="custom = !custom"
          >
            {{ custom ? "看看推荐话题" : "自己写一个话题" }}
          </button>

          <button
            class="button full-width"
            :disabled="!question.trim()"
            @click="topicPicker = false"
          >
            就聊这个
          </button>
        </ModalDialog>
        <RouterLink
          v-if="
            interview?.actualQuestion.starterKind === 'photo' &&
            !capturing &&
            !busy
          "
          class="text-button"
          :to="`/projects/${projectId}/photos?interviewId=${interview.id}`"
          >管理讲述照片</RouterLink
        >
      </section>
      <section v-if="sources.length" class="panel recording-playback">
        <div>
          <h2>听听这段声音</h2>
        </div>
        <div class="recording-source-list">
          <button
            v-for="(source, index) in sources"
            :key="source.id"
            class="button secondary"
            :disabled="!!audioBusy || capturing || busy"
            @click="playback(source)"
          >
            <span v-if="audioBusy === source.id" class="recording-spinner" />{{
              sources.length === 1 ? "回听原声" : `回听第 ${index + 1} 段原声`
            }}
          </button>
        </div>
        <p v-if="audioError" class="notice error" role="alert">
          {{ audioError }}
        </p>
        <audio
          v-if="audioUrl"
          ref="audio"
          :src="audioUrl"
          controls
          preload="metadata"
          aria-label="讲述原声"
          @error="audioError = '原声播放未成功，请重新读取后重试。'"
        />
      </section>
      <section
        v-if="
          interview?.clips.some((clip) => clip.state === 'sealed') && !capturing
        "
        class="panel recording-progress"
        aria-live="polite"
      >
        <div class="recording-progress-icon">
          <Icon v-if="ready" name="check" :size="25" /><span
            v-else-if="!taskIssue && !processingError"
            class="recording-spinner"
          /><Icon v-else name="book" :size="25" />
        </div>
        <h2>{{ processingTitle }}</h2>
        <p class="muted">
          {{
            ready
              ? "声音已保存，可以打开故事继续整理。"
              : "原声已上传，可以先离开，回来后继续查看结果。"
          }}
        </p>
        <p v-if="processingError" class="notice error" role="alert">
          {{ processingError }}
        </p>
        <ul v-if="tasks.length" class="recording-task-list">
          <li v-for="task in tasks" :key="task.id">{{ taskLabel(task) }}</li>
        </ul>
        <RouterLink
          v-if="ready"
          class="button"
          :to="`/projects/${projectId}/stories/${story!.story!.id}`"
          >查看故事<Icon name="arrow" :size="17"
        /></RouterLink>
        <button
          v-else-if="taskIssue?.retryable"
          class="button"
          :disabled="busy"
          @click="retryTask"
        >
          重试文字处理
        </button>
        <button class="text-button" :disabled="busy" @click="refreshProcessing">
          刷新处理进度
        </button>
      </section>
    </template>
  </div>
</template>
