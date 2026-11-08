<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { projectApi, projectError } from "../project-api";
import { auth } from "../session";
import ModalDialog from "./ModalDialog.vue";
const props = defineProps<{ projectId: string }>();
const emit = defineEmits<{ close: [] }>();
const url = ref(""),
  expiry = ref(""),
  error = ref(""),
  busy = ref(false),
  copied = ref(false);
let alive = true;
const off = auth.onClear(() => {
  url.value = "";
  emit("close");
});
onUnmounted(() => {
  alive = false;
  off();
});
async function load() {
  busy.value = true;
  error.value = "";
  try {
    const result = await projectApi.invite(props.projectId);
    if (!alive) return;
    url.value = new URL(
      `${import.meta.env.BASE_URL}invite/${result.token}`,
      location.origin,
    ).href;
    expiry.value = new Intl.DateTimeFormat("zh-CN", {
      month: "long",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    }).format(new Date(result.expiresAt));
  } catch (reason) {
    if (alive) error.value = projectError(reason);
  } finally {
    if (alive) busy.value = false;
  }
}
async function copy() {
  try {
    await navigator.clipboard.writeText(url.value);
    if (alive) copied.value = true;
  } catch {
    if (alive) error.value = "请选中邀请链接复制。";
  }
}
onMounted(() => {
  void load();
});
</script>
<template>
  <ModalDialog title="邀请家人" close-label="关闭邀请" @close="emit('close')">
    <div
      v-if="busy"
      class="skeleton skeleton-line"
      aria-label="正在生成邀请链接"
    />
    <template v-if="url">
      <label class="field-label"
        >邀请链接<input
          :value="url"
          readonly
          @focus="($event.target as HTMLInputElement).select()"
      /></label>
      <p class="muted text-small">有效至 {{ expiry }}</p>
      <button class="button full-width" @click="copy">
        {{ copied ? "已复制链接" : "复制邀请链接" }}
      </button>
    </template>
    <p v-if="error" class="error" role="alert">{{ error }}</p>
    <button v-if="error && !url" class="text-button" @click="load">
      重新生成
    </button>
  </ModalDialog>
</template>
