<script setup lang="ts">
import { onMounted, ref, computed } from "vue";
import { Alert, Button } from "antdv-next";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import type { ProductionTaskView } from "@timenook/contracts";
import { tasksApi } from "../api/admin";
const props = defineProps<{ csrf: string; permissions: string[] }>();
const emit = defineEmits<{ expired: [] }>();
const rows = ref<ProductionTaskView[]>([]),
  busy = ref(false),
  error = ref(""),
  notice = ref("");
const canRetry = computed(() =>
  props.permissions.includes(ADMIN_PERMISSIONS.retryTasks),
);
const intents = new Map<string, string>();
const kindLabel: Record<ProductionTaskView["kind"], string> = {
  transcribe_audio: "录音转写",
  compose_story: "故事整理",
  ask_followup: "可选追问",
  render_book: "书稿生成",
};
const stateLabel = (state: string) =>
  ({
    queued: "排队中",
    submitting: "正在处理",
    waiting_provider: "等待供应商",
    succeeded: "处理完成",
    no_speech: "无有效语音",
    no_content: "已转写，暂未形成故事",
    failed: "处理失败",
    obsolete: "内容已变化",
    waiting_inputs: "等待输入准备完成",
    manual_review: "需要人工接管",
    invalidated: "处理授权已失效",
  })[state] ?? state;
async function perform(work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await work();
  } catch (failure) {
    const code = (failure as { error?: { code?: string } }).error?.code;
    if (code === "UNAUTHENTICATED") {
      rows.value = [];
      emit("expired");
    } else
      error.value =
        code === "CONFLICT"
          ? "任务、授权或处理预算已变化，请重新查询。"
          : code === "FORBIDDEN"
            ? "当前账号没有任务操作权限。"
            : "请求结果尚未确认，请查询原任务后重试。";
  } finally {
    busy.value = false;
  }
}
const refresh = () =>
  perform(async () => {
    rows.value = await tasksApi.list();
  });
async function retry(task: ProductionTaskView) {
  if (!canRetry.value || !task.retryable) return;
  await perform(async () => {
    if (!intents.has(task.id)) intents.set(task.id, crypto.randomUUID());
    await tasksApi.retry(task, intents.get(task.id)!, props.csrf);
    intents.delete(task.id);
    rows.value = await tasksApi.list();
    notice.value = "重试已受理，仍使用原业务任务。";
  });
}
onMounted(refresh);
</script>
<template>
  <section class="runtime">
    <div class="page-title">
      <div>
        <h1>处理任务</h1>
        <p>查看转写、追问、故事整理与书稿生成的处理状态。</p>
      </div>
    </div>
    <Alert v-if="error" type="error" :message="error" role="alert" />
    <Alert v-if="notice" type="info" :message="notice" role="status" />
    <Button :loading="busy" @click="refresh">重新查询任务</Button>
    <p v-if="!rows.length && !busy" class="section">暂无处理任务。</p>
    <article v-for="task in rows" :key="task.id" class="audit-section section">
      <h2>{{ stateLabel(task.state) }}</h2>
      <p>任务类型：{{ kindLabel[task.kind] }}</p>
      <p>任务：{{ task.id }}</p>
      <p>项目：{{ task.projectId }}</p>
      <p v-if="task.errorCode">{{ task.errorCode }}</p>
      <p v-if="task.providerCode">供应商状态：{{ task.providerCode }}</p>
      <p>首次排队：{{ task.queuedAt }}</p>
      <p v-if="task.deadline">处理截止：{{ task.deadline }}</p>
      <p>外部尝试 {{ task.attempts.length }} 次；实际费用待供应商核对。</p>
      <Button
        v-if="canRetry && task.retryable"
        :disabled="busy"
        :aria-label="`重试任务 ${task.id}`"
        @click="retry(task)"
        >重试原任务</Button
      >
      <p v-if="task.state === 'manual_review'">
        请核对授权、处理截止与供应商预算后接管；系统不会直接改成成功。
      </p>
    </article>
  </section>
</template>
