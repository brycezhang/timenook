<script setup lang="ts">
import { ref, onMounted } from "vue";
import { Alert, Button, Form, FormItem, Input } from "antdv-next";
import type { CareCase } from "@timenook/contracts";
import { careApi } from "../api/admin";
const props = defineProps<{ csrf: string }>();
const emit = defineEmits<{ expired: [] }>();
const cases = ref<CareCase[]>([]),
  selected = ref<CareCase | null>(null),
  busy = ref(false),
  error = ref(""),
  evidence = ref("");
let intent: { input: string; key: string } | null = null;
async function perform(work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await work();
  } catch (failure) {
    const code = (failure as { error?: { code?: string } }).error?.code;
    if (code === "UNAUTHENTICATED") {
      selected.value = null;
      cases.value = [];
      emit("expired");
    } else
      error.value =
        code === "CONFLICT"
          ? "绑定或工单已变化，请重新查询后核验。"
          : code === "FORBIDDEN"
            ? "当前账号没有换绑权限。"
            : "操作未确认，请核对工单与证据后重试；相同意图保留原请求。";
  } finally {
    busy.value = false;
  }
}
const refresh = () =>
  perform(async () => {
    cases.value = (await careApi.list()).requests;
  });
const open = (id: string) =>
  perform(async () => {
    selected.value = null;
    evidence.value = "";
    intent = null;
    selected.value = await careApi.read(id);
  });
async function rebind() {
  const care = selected.value;
  if (!care || care.state !== "open" || !evidence.value) return;
  await perform(async () => {
    const input = JSON.stringify({
      id: care.id,
      target: care.targetUserId,
      version: care.sourceBindingVersion,
      evidence: evidence.value,
    });
    if (intent?.input !== input) intent = { input, key: crypto.randomUUID() };
    await careApi.rebind(care, evidence.value, intent.key, props.csrf);
    intent = null;
    selected.value = await careApi.read(care.id);
    cases.value = (await careApi.list()).requests;
  });
}
onMounted(refresh);
</script>
<template>
  <section class="runtime">
    <div class="page-title">
      <div>
        <h1>客服工单</h1>
        <p>按本人核验结果执行原项目换绑，保留同一讲述者与历史记录。</p>
      </div>
    </div>
    <Alert
      type="info"
      message="隔离合成验证：D08 真实核验与告知规则尚未冻结。本表单不得作为真实本人核验。"
      show-icon
    />
    <Alert v-if="error" type="error" :message="error" role="alert" />
    <Button :loading="busy" @click="refresh">重新查询工单</Button>
    <div class="section">
      <p v-if="!cases.length">暂无换绑申请。</p>
      <div v-for="care in cases" :key="care.id" class="audit-section">
        <p>账号换绑 · {{ care.state === "open" ? "待核验" : "已完成" }}</p>
        <Button :disabled="busy" @click="open(care.id)"
          >查看 {{ care.id }}</Button
        >
      </div>
    </div>
    <section v-if="selected" class="audit-section">
      <h2>本人账号换绑</h2>
      <p>共享工单：record:{{ selected.id }}</p>
      <p>项目：{{ selected.projectId }}</p>
      <p>申请账号：{{ selected.requesterId }}</p>
      <p>目标账号：{{ selected.targetUserId }}</p>
      <p>来源绑定版本：{{ selected.sourceBindingVersion }}</p>
      <Alert
        v-if="selected.state === 'completed'"
        type="success"
        message="工单已完成，原账号权限已撤销，新账号须重新授权。"
      />
      <Form v-else layout="vertical" class="section"
        ><FormItem label="D08 核验证据引用"
          ><Input
            v-model:value="evidence"
            aria-label="D08 核验证据引用"
            placeholder="synthetic:隔离本人核验证据"
            :disabled="busy"
        /></FormItem>
        <p>
          核对本人、原账号与目标账号后提交。操作会撤销本项目旧授权；不会重置服务期限。
        </p>
        <Button
          type="primary"
          :disabled="busy || !evidence.startsWith('synthetic:')"
          :loading="busy"
          @click="rebind"
          >核验完成并换绑</Button
        ></Form
      >
      <div
        v-for="change in selected.changes"
        :key="change.requestId"
        class="section"
      >
        <p>
          绑定版本：{{ change.bindingVersion }} · 访问版本：{{
            change.accessEpoch
          }}
        </p>
        <p>核验证据：{{ change.evidenceRef }}</p>
        <p>处理人：{{ change.operatorId }}</p>
      </div>
    </section>
  </section>
</template>
