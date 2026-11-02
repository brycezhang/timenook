<script setup lang="ts">
import { ref, watch, onBeforeUnmount, computed } from "vue";
import { useRoute, useRouter, RouterLink } from "vue-router";
import { Page } from "@vben/common-ui";
import { Alert, Button, Card, TextArea, Spin, Tag } from "antdv-next";
import {
  ADMIN_PERMISSIONS,
  type AdminUserDetail,
  type AdminOrderNote,
} from "@timenook/contracts";
import {
  adminRequest,
  can,
  errorText,
  session,
  sessionEpoch,
} from "../session";
import { safeReturn } from "../router";
const requestKind = (kind: string) =>
  (
    ({
      export: "完整资料导出",
      delete: "资料删除",
      withdraw: "本人撤回",
      rebind: "账号换绑",
      correction: "故事校对",
    }) as Record<string, string>
  )[kind] ?? kind;
const route = useRoute(),
  router = useRouter(),
  detail = ref<AdminUserDetail | null>(null),
  busy = ref(false),
  saving = ref(false),
  error = ref(""),
  notice = ref(""),
  content = ref("");
const back = computed(() =>
  typeof route.query.from === "string"
    ? safeReturn(route.query.from)
    : "/users",
);
let serial = 0,
  abort: AbortController | undefined,
  noteKey = crypto.randomUUID();
async function load() {
  const token = ++serial,
    epoch = sessionEpoch,
    id = String(route.params.id);
  abort?.abort();
  abort = new AbortController();
  detail.value = null;
  busy.value = true;
  error.value = "";
  try {
    const value = await adminRequest<AdminUserDetail>(`/users/${id}`, {
      signal: abort.signal,
    });
    if (token === serial && epoch === sessionEpoch) detail.value = value;
  } catch (e) {
    if (token === serial && !(e instanceof Error && e.name === "AbortError"))
      error.value = errorText(e);
  } finally {
    if (token === serial) busy.value = false;
  }
}
async function append() {
  if (saving.value || !content.value.trim()) return;
  const token = serial,
    epoch = sessionEpoch,
    id = String(route.params.id);
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    const note = await adminRequest<AdminOrderNote>(`/users/${id}/notes`, {
      method: "POST",
      headers: {
        "X-CSRF-Token": session.value!.csrfToken,
        "Idempotency-Key": noteKey,
      },
      body: JSON.stringify({ content: content.value }),
    });
    if (token === serial && epoch === sessionEpoch) {
      if (detail.value && !detail.value.notes.some((n) => n.id === note.id))
        detail.value.notes.unshift(note);
      content.value = "";
      noteKey = crypto.randomUUID();
      notice.value = "备注已保存。";
    }
  } catch (e) {
    if (token === serial) error.value = errorText(e);
  } finally {
    if (token === serial) saving.value = false;
  }
}
watch(
  () => route.params.id,
  () => {
    content.value = "";
    notice.value = "";
    noteKey = crypto.randomUUID();
    saving.value = false;
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  ++serial;
  abort?.abort();
  detail.value = null;
  content.value = "";
});
</script>
<template>
  <Page title="用户详情" class="user-details"
    ><template #title><h1>用户详情</h1></template
    ><template #extra
      ><Button @click="router.push(back)">返回用户列表</Button
      ><Button :loading="busy" @click="load">刷新</Button></template
    >
    <Alert v-if="error" type="error" :message="error" role="alert" /><Alert
      v-if="notice"
      type="success"
      :message="notice"
    /><Spin v-if="busy" />
    <template v-if="detail && can(ADMIN_PERMISSIONS.writeCare)"
      ><Card title="产品账号"
        ><p class="identifier">{{ detail.id }}</p>
        <p>创建时间：{{ detail.createdAt }}</p>
        <p>
          登录方式：{{ detail.loginMethods.join("、") || "暂无已记录登录方式" }}
        </p>
        <p>产品账号与项目讲述者分别记录。</p></Card
      >
      <Card title="关联项目与讲述者"
        ><p v-if="!detail.projects.length">暂无关联项目。</p>
        <section
          v-for="project in detail.projects"
          :key="project.id"
          class="section"
        >
          <RouterLink
            :to="{
              path: `/users/projects/${project.id}`,
              query: { from: route.fullPath },
            }"
            >{{
              project.bookTitle || project.subjectName || project.id
            }}</RouterLink
          >
          <p>
            讲述者：{{ project.subjectName || project.subjectId || "尚未建立" }}
          </p>
          <p>
            账号关系：{{
              project.initiatorUserId === detail.id
                ? "发起人"
                : project.narratorUserId === detail.id
                  ? "当前讲述者账号"
                  : "历史绑定或申请关联账号"
            }}
          </p>
          <p v-if="!project.narratorUserId">讲述者无个人账号</p>
          <Tag v-if="project.pending" color="orange">待处理服务</Tag>
          <p v-if="!project.orderId">
            {{
              project.source === "internal-acceptance"
                ? "内部验收项目"
                : "无支付订单项目"
            }}
            · 无付款、无生产权益
          </p>
        </section></Card
      >
      <Card title="关联订单"
        ><p v-if="!detail.orders.length">暂无支付订单。</p>
        <p v-for="order in detail.orders" :key="order.id">
          <RouterLink
            :to="{
              path: `/orders/${order.id}`,
              query: { from: route.fullPath },
            }"
            >{{ order.outTradeNo }}</RouterLink
          >
          · {{ order.state }}
        </p></Card
      >
      <Card title="服务申请"
        ><p v-if="!detail.requests.length">暂无服务申请。</p>
        <p v-for="request in detail.requests" :key="request.id">
          <RouterLink
            :to="{
              path: `/users/projects/${request.projectId}`,
              query: { from: route.fullPath, case: request.id },
            }"
            >{{ requestKind(request.kind) }} · {{ request.state }} ·
            {{ request.createdAt }}</RouterLink
          >
        </p></Card
      >
      <Card title="内部备注"
        ><TextArea
          v-model:value="content"
          aria-label="用户内部备注"
          :maxlength="2000"
          :rows="3"
        /><Button
          type="primary"
          :loading="saving"
          :disabled="!content.trim()"
          @click="append"
          >追加用户备注</Button
        >
        <section v-for="note in detail.notes" :key="note.id" class="section">
          <p class="note-content">{{ note.content }}</p>
          <p>{{ note.operatorName }} · {{ note.createdAt }}</p>
        </section></Card
      >
      <Card title="本账号操作历史"
        ><p v-for="event in detail.history" :key="event.id">
          {{ event.action }} · {{ event.result }} · {{ event.operatorId }} ·
          {{ event.createdAt }}
        </p></Card
      ></template
    ></Page
  >
</template>
<style scoped>
.user-details :deep(.ant-card) {
  margin-bottom: 16px;
}
.identifier,
.section p {
  overflow-wrap: anywhere;
}
.note-content {
  white-space: pre-wrap;
}
.section {
  padding: 12px 0;
}
</style>
