<script setup lang="ts">
import { computed, ref } from "vue";
import { Alert, Button, Form, FormItem, Input } from "antdv-next";
import { serviceTermsApi, type ServiceTermsView } from "../api/admin";
const props = defineProps<{ csrf: string }>();
const emit = defineEmits<{ expired: [] }>();
const projectId = ref(""),
  supportCaseRef = ref(""),
  busy = ref(false),
  error = ref(""),
  terms = ref<ServiceTermsView | null>(null);
let intent: { input: string; key: string } | null = null;
const validProject = computed(() => /^[a-f0-9-]{36}$/.test(projectId.value));
const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone;
const dateTime = new Intl.DateTimeFormat("zh-CN", {
  timeZone,
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hourCycle: "h23",
});
const displayTime = (value?: string | null) =>
  value ? dateTime.format(new Date(value)) : "未起算";
const creation = computed(
  () =>
    ({
      active: "制作进行中",
      paused: "制作已暂停",
      not_started: "尚未参与，制作未起算",
      expired: "制作已到期，首本需人工核验",
    })[terms.value?.creation?.state ?? ""] ?? "规则待冻结",
);
async function run(action?: "pause" | "resume") {
  if (busy.value || !validProject.value) return;
  busy.value = true;
  error.value = "";
  try {
    if (action) {
      const input = JSON.stringify({
        projectId: projectId.value,
        action,
        supportCaseRef: supportCaseRef.value,
      });
      if (intent?.input !== input) intent = { input, key: crypto.randomUUID() };
      terms.value = await serviceTermsApi.pause(
        projectId.value,
        action,
        supportCaseRef.value,
        intent.key,
        props.csrf,
      );
      intent = null;
    } else terms.value = await serviceTermsApi.read(projectId.value);
  } catch (failure) {
    const code = (failure as { error?: { code?: string } }).error?.code;
    if (code === "UNAUTHENTICATED") emit("expired");
    else
      error.value =
        code === "CONFLICT"
          ? "状态已变化或已达暂停上限，请重新查询后核验。"
          : code === "FORBIDDEN"
            ? "当前权限或环境不允许操作。"
            : "操作未确认，请核对项目和工单后重试；原请求会保持幂等。";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="runtime">
    <div class="page-title">
      <div>
        <h1>服务期限</h1>
        <p>按订单冻结规则查询，客服依据共享工单暂停或恢复制作计时。</p>
      </div>
    </div>
    <Alert
      type="info"
      message="当前仅为隔离合成验证，正式销售政策尚未冻结。制作到期不会直接删除资料。"
      show-icon
    />
    <Alert v-if="error" type="error" :message="error" role="alert" />
    <Form layout="vertical" class="section"
      ><FormItem label="项目编号"
        ><Input
          id="terms-project"
          v-model:value="projectId"
          aria-label="项目编号"
          :disabled="busy"
          @change="terms = null" /></FormItem
      ><Button :disabled="!validProject" :loading="busy" @click="run()"
        >查询期限</Button
      ></Form
    >
    <section v-if="terms" class="audit-section">
      <h2>{{ creation }}</h2>
      <p>显示时区：{{ timeZone }}</p>
      <p>制作到期：{{ displayTime(terms.creation?.expiresAt) }}</p>
      <p>回听到期：{{ displayTime(terms.playback?.expiresAt) }}</p>
      <p>导出申请到期：{{ displayTime(terms.exportRequests?.expiresAt) }}</p>
      <p v-if="terms.notStarted?.action === 'contact_and_offer_refund'">
        尚未参与已达约定等待期，请按共享工单联系并核验退款选项。
      </p>
      <Form layout="vertical"
        ><FormItem label="共享工单引用"
          ><Input
            v-model:value="supportCaseRef"
            aria-label="共享工单引用"
            placeholder="record:共享工单编号"
            :disabled="busy"
        /></FormItem>
        <div class="catalog-navigation">
          <Button
            :disabled="
              !supportCaseRef || busy || terms.creation?.state !== 'active'
            "
            @click="run('pause')"
            >暂停制作计时</Button
          ><Button
            :disabled="
              !supportCaseRef || busy || terms.creation?.state !== 'paused'
            "
            @click="run('resume')"
            >恢复制作计时</Button
          >
        </div></Form
      >
    </section>
  </section>
</template>
