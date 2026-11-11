<script setup lang="ts">
import { computed, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import type {
  PhotoCollection,
  PhotoMaterials,
  RecordingContext,
} from "../../../../packages/contracts/src";
import { photoApi, pendingPhoto, type PendingPhoto } from "../photo-api";
import { recordingApi } from "../recording-api";
import { projectApi, projectError } from "../project-api";
import { auth } from "../session";
import { WebApiError } from "../api";
import PrivatePhoto from "../components/PrivatePhoto.vue";
import Icon from "../components/Icon.vue";
const props = defineProps<{ storyId?: string }>();
const route = useRoute(),
  router = useRouter();
const projectId = computed(() => String(route.params.projectId));
const interviewId = ref("");
const linkedStoryId = ref("");
type PhotoView = PhotoCollection & { snapshot: PhotoMaterials | null };
const selectedIds = ref<string[]>([]);
const collection = ref<PhotoView | null>(null),
  context = ref<RecordingContext | null>(null);
const pending = ref<PendingPhoto[]>([]),
  captions = ref<Record<string, string>>({});
const loading = ref(true),
  busy = ref(false),
  error = ref(""),
  status = ref(""),
  denied = ref(false),
  needsSync = ref(false),
  conflict = ref(false);
let generation = 0;
const entries = computed(() =>
  interviewId.value
    ? (collection.value?.snapshot?.entries ?? [])
    : (collection.value?.photos
        .filter((photo) => photo.state === "sealed")
        .map((photo) => ({
          photoId: photo.id,
          caption: "",
          assets: photo.assets,
        })) ?? []),
);
const available = computed(() =>
  interviewId.value
    ? (collection.value?.photos.filter(
        (photo) =>
          photo.state === "sealed" &&
          !entries.value.some((entry) => entry.photoId === photo.id),
      ) ?? [])
    : [],
);
const returnTo = computed(() =>
  props.storyId
    ? `/projects/${projectId.value}/stories/${props.storyId}`
    : `/projects/${projectId.value}`,
);
function clear() {
  generation++;
  interviewId.value = "";
  linkedStoryId.value = "";
  collection.value = null;
  context.value = null;
  pending.value = [];
  captions.value = {};
  selectedIds.value = [];
  busy.value = false;
  loading.value = false;
  needsSync.value = false;
}
const unsubscribe = auth.onClear(clear);
function accessLost() {
  clear();
  denied.value = true;
  error.value = "暂时无法访问这些照片，请返回项目重新查看。";
}
function failure(reason: unknown, current: number) {
  if (current !== generation) return;
  if (
    reason instanceof WebApiError &&
    [401, 403, 404].includes(reason.status)
  ) {
    accessLost();
    return;
  }
  conflict.value = reason instanceof WebApiError && reason.status === 409;
  error.value =
    reason instanceof WebApiError && reason.status === 422
      ? "这张照片未能处理，请改用 JPEG 或 PNG 照片后重试。"
      : projectError(reason);
}
function accept(value: PhotoView) {
  collection.value = value;
  captions.value = Object.fromEntries(
    value.snapshot?.entries.map((entry) => [entry.photoId, entry.caption]) ??
      [],
  );
}
async function load() {
  clear();
  const current = generation;
  loading.value = true;
  denied.value = false;
  error.value = "";
  conflict.value = false;
  status.value = "";
  try {
    let id =
      typeof route.query.interviewId === "string"
        ? route.query.interviewId
        : "";
    let source;
    if (props.storyId) {
      source = await projectApi.story(projectId.value, props.storyId);
      id = source.interviewId;
    }
    if (current !== generation) return;
    interviewId.value = id;
    if (id) {
      if (!props.storyId)
        source =
          (await recordingApi.story(projectId.value, id)).story ?? undefined;
      const value = {
        ...(await photoApi.list(projectId.value)),
        snapshot: await photoApi.materials(projectId.value, id),
      };
      if (current !== generation) return;
      linkedStoryId.value = source?.id ?? "";
      accept(value);
      needsSync.value = !!(
        source?.revision &&
        value.snapshot &&
        source.revision.photoSnapshot?.id !== value.snapshot.id
      );
    } else {
      const [value, photos] = await Promise.all([
        recordingApi.context(projectId.value),
        photoApi.list(projectId.value),
      ]);
      if (current === generation) {
        context.value = value;
        accept({ ...photos, snapshot: null });
      }
    }
  } catch (reason) {
    failure(reason, current);
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  () => [projectId.value, props.storyId, auth.account.value?.session.id],
  () => {
    if (auth.account.value) void load();
  },
  { immediate: true },
);
onUnmounted(() => {
  clear();
  unsubscribe();
});
async function prepare(current: number) {
  if (interviewId.value) return interviewId.value;
  if (!context.value?.canRecord) throw Error("当前项目暂时无法新增讲述。");
  const id = crypto.randomUUID();
  const interview = await recordingApi.start(
    projectId.value,
    {
      clientInterviewId: id,
      expectedPlanRevision: context.value.plan.revision,
      starterKind: "photo",
    },
    id,
  );
  if (current !== generation)
    throw new DOMException("Request superseded", "AbortError");
  interviewId.value = interview.id;
  await router.replace({ query: { interviewId: interview.id } });
  return interview.id;
}
async function syncStory(current: number) {
  const snapshot = collection.value?.snapshot;
  if (!linkedStoryId.value || !snapshot) return;
  needsSync.value = true;
  await photoApi.attach(projectId.value, linkedStoryId.value, snapshot);
  if (current === generation) needsSync.value = false;
}
async function upload(photo: PendingPhoto, current = generation) {
  photo.state = "uploading";
  photo.error = "";
  try {
    const remote = await photoApi.upload(
      projectId.value,
      photo,
      () => current === generation,
    );
    const assets = await photoApi.list(projectId.value);
    let snapshot = collection.value?.snapshot ?? null;
    if (interviewId.value)
      snapshot = await photoApi.revise(
        projectId.value,
        interviewId.value,
        snapshot,
        [
          ...(snapshot?.entries.map((entry) => ({
            photoId: entry.photoId,
            caption: entry.caption,
          })) ?? []),
          { photoId: remote.id, caption: "" },
        ],
      );
    const value = { ...assets, snapshot };
    if (!interviewId.value && current === generation)
      selectedIds.value.push(remote.id);
    if (current !== generation) return;
    pending.value = pending.value.filter((item) => item.id !== photo.id);
    accept(value);
    await syncStory(current);
    if (current === generation) status.value = "照片已保存";
  } catch (reason) {
    if (current !== generation) return;
    photo.state = "failed";
    photo.error =
      reason instanceof Error ? reason.message : "照片上传未完成，请重试。";
    failure(reason, current);
  }
}
async function select(event: Event) {
  const input = event.target as HTMLInputElement;
  const files = [...(input.files ?? [])];
  input.value = "";
  if (!files.length || busy.value) return;
  const current = generation;
  busy.value = true;
  status.value = "";
  error.value = "";
  try {
    for (const file of files) {
      const item = await pendingPhoto(file);
      if (current !== generation) return;
      pending.value.push(item);
      await upload(pending.value.at(-1)!, current);
      if (current !== generation) return;
    }
  } catch (reason) {
    failure(reason, current);
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function retry(photo: PendingPhoto) {
  if (busy.value) return;
  const current = generation;
  busy.value = true;
  error.value = "";
  await upload(photo, current);
  if (current === generation) busy.value = false;
}
async function cancel(photo: PendingPhoto) {
  if (busy.value) return;
  const current = generation;
  busy.value = true;
  try {
    if (photo.serverId) await photoApi.release(projectId.value, photo.serverId);
    if (current === generation)
      pending.value = pending.value.filter((item) => item.id !== photo.id);
  } catch (reason) {
    failure(reason, current);
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function save(next?: { photoId: string; caption: string }[]) {
  const snapshot = collection.value?.snapshot ?? null;
  if (!interviewId.value || busy.value || conflict.value) return;
  const current = generation;
  busy.value = true;
  status.value = "";
  error.value = "";
  try {
    const value = await photoApi.revise(
      projectId.value,
      interviewId.value,
      snapshot,
      next ??
        entries.value.map((entry) => ({
          photoId: entry.photoId,
          caption: captions.value[entry.photoId] ?? entry.caption,
        })),
    );
    if (current !== generation) return;
    accept({ ...collection.value!, snapshot: value });
    await syncStory(current);
    if (current === generation) status.value = "照片已保存";
  } catch (reason) {
    failure(reason, current);
  } finally {
    if (current === generation) busy.value = false;
  }
}
async function sync() {
  const current = generation;
  busy.value = true;
  error.value = "";
  try {
    await syncStory(current);
    if (current === generation) status.value = "照片已保存";
  } catch (reason) {
    failure(reason, current);
  } finally {
    if (current === generation) busy.value = false;
  }
}
function remove(id: string) {
  void save(
    entries.value
      .filter((entry) => entry.photoId !== id)
      .map((entry) => ({
        photoId: entry.photoId,
        caption: captions.value[entry.photoId] ?? entry.caption,
      })),
  );
}
function togglePhoto(id: string) {
  selectedIds.value = selectedIds.value.includes(id)
    ? selectedIds.value.filter((photoId) => photoId !== id)
    : [...selectedIds.value, id];
}
async function addExisting(id: string) {
  await save([
    ...entries.value.map((entry) => ({
      photoId: entry.photoId,
      caption: captions.value[entry.photoId] ?? entry.caption,
    })),
    { photoId: id, caption: "" },
  ]);
}
async function recordPhotos() {
  if (!selectedIds.value.length || busy.value) return;
  const current = generation;
  busy.value = true;
  try {
    const ids = [...selectedIds.value];
    const id = await prepare(current);
    await photoApi.revise(
      projectId.value,
      id,
      null,
      ids.map((photoId) => ({ photoId, caption: "" })),
    );
    if (current === generation)
      await router.push(
        `/projects/${projectId.value}/record?interviewId=${id}&prepare=1`,
      );
  } catch (reason) {
    failure(reason, current);
  } finally {
    if (current === generation) busy.value = false;
  }
}
</script>
<template>
  <div class="photo-page">
    <RouterLink class="text-button" :to="returnTo"
      >← {{ storyId ? "返回故事" : "返回项目" }}</RouterLink
    >
    <header class="page-heading">
      <h1>{{ storyId ? "故事里的照片" : "从照片说起" }}</h1>
    </header>
    <section
      v-if="loading"
      class="panel detail-skeleton"
      aria-busy="true"
      aria-label="正在读取照片"
    >
      <div class="skeleton skeleton-cover" />
      <div class="skeleton skeleton-line" />
    </section>
    <div v-if="error" class="notice error" role="alert">
      {{ error
      }}<button v-if="!busy" class="text-button" @click="load">
        {{ conflict ? "读取最新照片" : "重新读取" }}
      </button>
    </div>
    <p v-if="status" class="success-note" role="status">{{ status }}</p>
    <template v-if="!loading && !denied">
      <section class="panel photo-upload-panel">
        <label
          class="button photo-picker"
          :class="{ disabled: busy || conflict }"
          ><span v-if="busy" class="spinner" /><Icon
            v-else
            name="plus"
            :size="18" />选择照片<input
            aria-label="选择照片"
            type="file"
            multiple
            accept="image/jpeg,image/png,image/heic,image/heif,.heic,.heif"
            :disabled="busy || conflict"
            @change="select"
        /></label>
        <p class="muted text-small">支持 JPEG、PNG 和 HEIC，每张最多 16 MB。</p>
        <p
          v-if="pending.some((item) => item.state === 'uploading')"
          class="muted"
          role="status"
        >
          <span class="spinner" />正在上传照片，请稍候。
        </p>
        <div v-for="photo in pending" :key="photo.id" class="pending-photo">
          <span>{{ photo.file.name }}</span
          ><template v-if="photo.state === 'failed'"
            ><p class="notice error">{{ photo.error }}</p>
            <div class="row">
              <button
                class="button secondary small"
                :disabled="busy"
                @click="retry(photo)"
              >
                重试上传</button
              ><button
                class="text-button"
                :disabled="busy"
                @click="cancel(photo)"
              >
                取消上传
              </button>
            </div></template
          ><span v-else class="spinner" />
        </div>
      </section>
      <div v-if="entries.length" class="photo-editor-grid">
        <article
          v-for="(entry, index) in entries"
          :key="entry.photoId"
          class="panel photo-editor-card"
        >
          <PrivatePhoto
            v-if="entry.assets.find((asset) => asset.kind === 'preview')"
            :project-id="projectId"
            :photo-id="entry.photoId"
            :asset="entry.assets.find((asset) => asset.kind === 'preview')!"
            :alt="entry.caption || `故事照片 ${index + 1}`"
            @denied="accessLost"
          />
          <p
            v-if="
              collection?.photos.find((photo) => photo.id === entry.photoId)
                ?.lowResolution
            "
            class="muted text-small"
          >
            照片清晰度较低，印刷时可能不够清楚。
          </p>
          <label v-if="interviewId" class="field-label"
            >照片说明<textarea
              v-model="captions[entry.photoId]"
              :aria-label="`照片说明 ${index + 1}`"
              maxlength="1000"
              rows="3"
              :disabled="busy || conflict"
              placeholder="照片里有谁？那时发生了什么？"
            />
          </label>
          <button
            v-if="interviewId"
            class="text-button photo-delete"
            :aria-label="`删除照片 ${index + 1}`"
            :disabled="busy || conflict"
            @click="remove(entry.photoId)"
          >
            移除本次照片
          </button>
          <button
            v-else
            class="button secondary"
            :aria-pressed="selectedIds.includes(entry.photoId)"
            @click="togglePhoto(entry.photoId)"
          >
            {{
              selectedIds.includes(entry.photoId) ? "已选择" : "选择这张照片"
            }}
          </button>
        </article>
      </div>
      <section v-else-if="!pending.length" class="panel empty-state">
        <Icon name="book" :size="32" />
        <h2>{{ interviewId ? "给这个故事添一张照片" : "暂无照片" }}</h2>
      </section>
      <section v-if="available.length" class="panel">
        <h2>选择项目照片</h2>
        <div class="photo-editor-grid">
          <article
            v-for="photo in available"
            :key="photo.id"
            class="photo-editor-card"
          >
            <PrivatePhoto
              :project-id="projectId"
              :photo-id="photo.id"
              :asset="photo.assets.find((asset) => asset.kind === 'preview')!"
              alt="项目照片"
              @denied="accessLost"
            />
            <button
              class="button secondary"
              :disabled="busy"
              @click="addExisting(photo.id)"
            >
              添加到本次讲述
            </button>
          </article>
        </div>
      </section>
      <div class="hero-actions photo-actions">
        <button
          v-if="entries.length && interviewId"
          class="button secondary"
          :disabled="busy || conflict"
          @click="save()"
        >
          <span v-if="busy" class="spinner" />保存照片说明
        </button>
        <button
          v-if="needsSync"
          class="button secondary"
          :disabled="busy"
          @click="sync"
        >
          同步到故事
        </button>
        <button
          v-if="!interviewId && selectedIds.length"
          class="button"
          :disabled="busy || !!pending.length"
          @click="recordPhotos"
        >
          <Icon name="mic" :size="18" />看着照片讲一讲
        </button>
      </div>
    </template>
  </div>
</template>
