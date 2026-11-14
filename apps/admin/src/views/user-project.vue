<script setup lang="ts">
import { formatAdminTime } from "../utils/time";
import { ref, watch, onBeforeUnmount, computed } from "vue";
import { useRoute, useRouter, RouterLink } from "vue-router";
import { Page } from "@vben/common-ui";
import { Alert, Button, Card, Space, Spin } from "antdv-next";
import {
  ADMIN_PERMISSIONS,
  type AdminProjectDetail,
} from "@timenook/contracts";
import {
  adminRequest,
  can,
  errorText,
  session,
  sessionEpoch,
  expireSession,
} from "../session";
import { safeReturn } from "../router";
import Care from "./care.vue";
const route = useRoute(),
  router = useRouter(),
  detail = ref<AdminProjectDetail | null>(null),
  busy = ref(false),
  error = ref("");
const back = computed(() =>
  typeof route.query.from === "string"
    ? safeReturn(route.query.from)
    : "/users",
);
let serial = 0,
  abort: AbortController | undefined;
async function load() {
  const token = ++serial,
    epoch = sessionEpoch;
  abort?.abort();
  abort = new AbortController();
  detail.value = null;
  busy.value = true;
  error.value = "";
  try {
    const value = await adminRequest<AdminProjectDetail>(
      `/users/projects/${route.params.projectId}`,
      { signal: abort.signal },
    );
    if (token === serial && epoch === sessionEpoch) detail.value = value;
  } catch (e) {
    if (token === serial && !(e instanceof Error && e.name === "AbortError"))
      error.value = errorText(e);
  } finally {
    if (token === serial) busy.value = false;
  }
}
watch(() => route.params.projectId, load, { immediate: true });
onBeforeUnmount(() => {
  ++serial;
  abort?.abort();
  detail.value = null;
});
</script>
<template>
  <Page title="项目详情" header-class="flex-wrap gap-2" class="project-details"
    ><template #title><h1>项目详情</h1></template
    ><template #extra>
      <Space wrap>
        <Button @click="router.push(back)">返回关联列表</Button>
        <Button :loading="busy" @click="load">刷新</Button>
      </Space>
    </template><Alert v-if="error" type="error" :message="error" role="alert" /><Spin
      v-if="busy"
    /><template v-if="detail && can(ADMIN_PERMISSIONS.writeCare)"
      ><Card title="项目与参与身份"
        ><p>{{ detail.bookTitle || "尚未填写书名" }}</p>
        <p class="identifier">项目：{{ detail.id }}</p>
        <p>
          发起人账号：<RouterLink
            :to="{
              path: `/users/${detail.initiatorUserId}`,
              query: { from: route.fullPath },
            }"
            >{{ detail.initiatorUserId }}</RouterLink
          >
        </p>
        <p>
          讲述者：{{ detail.subjectName || detail.subjectId || "尚未建立" }}
        </p>
        <p v-if="detail.narratorUserId">
          讲述者账号：<RouterLink
            :to="{
              path: `/users/${detail.narratorUserId}`,
              query: { from: route.fullPath },
            }"
            >{{ detail.narratorUserId }}</RouterLink
          >
        </p>
        <p v-else>讲述者无个人账号</p>
        <p v-if="detail.orderId">
          关联订单：<RouterLink
            :to="{
              path: `/orders/${detail.orderId}`,
              query: { from: route.fullPath },
            }"
            >{{ detail.orderId }}</RouterLink
          >
        </p>
        <Alert
          v-else
          type="info"
          :message="`${detail.source === 'internal-acceptance' ? '内部验收项目' : '无支付订单项目'}：无付款、无生产权益。`"
        />
        <p v-if="detail.productionOrder">
          关联生产单：<RouterLink
            :to="{
              path: `/production/${detail.productionOrder.id}`,
              query: { from: route.fullPath },
            }"
            >{{ detail.productionOrder.id }}</RouterLink
          >
        </p>
        <p>
          制作、回听及资料服务长期有效；本人授权和安全访问仍按当前状态核验。
        </p></Card
      >
      <Card title="项目服务"
        ><Care
          :key="detail.id"
          :project="detail"
          :initial-case="
            typeof route.query.case === 'string' ? route.query.case : undefined
          "
          :csrf="session?.csrfToken ?? ''"
          @expired="expireSession"
          @changed="load"
          @production="(id) => router.push(`/production/${id}`)"
      /></Card>
      <Card title="本项目操作历史"
        ><p v-for="event in detail.history" :key="event.id">
          {{ event.action }} · {{ event.result }} · {{ event.operatorId }} ·
          {{ formatAdminTime(event.createdAt) }}
        </p></Card
      ></template
    ></Page
  >
</template>
<style scoped>
.project-details :deep(.ant-card) {
  margin-bottom: 16px;
}
.project-details p {
  overflow-wrap: anywhere;
}
</style>
