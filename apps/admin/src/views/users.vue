<script setup lang="ts">
import { formatAdminTime } from "../utils/time";
import { ref, watch, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Page } from "@vben/common-ui";
import { Alert, Button, Card, Input, Select, Table, Tag } from "antdv-next";
import type { AdminUsersPage } from "@timenook/contracts";
import { adminRequest, errorText, sessionEpoch } from "../session";
const route = useRoute(),
  router = useRouter(),
  data = ref<AdminUsersPage | null>(null),
  busy = ref(false),
  error = ref("");
const search = ref(String(route.query.q ?? "")),
  pending = ref(String(route.query.pending ?? ""));
let serial = 0,
  abort: AbortController | undefined;
const showTotal = (total: number) => `共 ${total} 条用户或讲述者`;
const columns = [
  { title: "账号 / 讲述者", key: "identity", width: 380 },
  { title: "类型", key: "kind", width: 180 },
  { title: "服务事项", key: "pending", width: 180 },
  { title: "记录时间", key: "createdAt", width: 220 },
];
async function load() {
  const token = ++serial,
    epoch = sessionEpoch;
  abort?.abort();
  abort = new AbortController();
  busy.value = true;
  error.value = "";
  data.value = null;
  try {
    const query = new URLSearchParams();
    for (const key of ["q", "pending", "page", "pageSize"]) {
      const v = route.query[key];
      if (typeof v === "string") query.set(key, v);
    }
    const result = await adminRequest<AdminUsersPage>(`/users?${query}`, {
      signal: abort.signal,
    });
    if (token === serial && epoch === sessionEpoch) data.value = result;
  } catch (e) {
    if (token === serial && !(e instanceof Error && e.name === "AbortError"))
      error.value = errorText(e);
  } finally {
    if (token === serial) busy.value = false;
  }
}
function submit() {
  const target = {
    path: "/users",
    query: {
      ...(search.value.trim() ? { q: search.value.trim() } : {}),
      ...(pending.value ? { pending: pending.value } : {}),
      page: "1",
      pageSize: String(route.query.pageSize ?? 20),
    },
  };
  if (router.resolve(target).fullPath === route.fullPath) void load();
  else void router.push(target);
}
function paginate(page: number, pageSize: number) {
  void router.push({
    path: "/users",
    query: { ...route.query, page: String(page), pageSize: String(pageSize) },
  });
}
function detail(user: { id: string; kind: string; projectId?: string }) {
  void router.push({
    path:
      user.kind === "narrator"
        ? `/users/projects/${user.projectId}`
        : `/users/${user.id}`,
    query: { from: route.fullPath },
  });
}
watch(
  () => route.fullPath,
  () => {
    search.value = String(route.query.q ?? "");
    pending.value = String(route.query.pending ?? "");
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  serial++;
  abort?.abort();
  data.value = null;
});
</script>
<template>
  <Page title="用户管理" description="查询产品账号、讲述者及关联项目服务。"
    ><template #title><h1>用户管理</h1></template
    ><Card
      ><form class="query-form" @submit.prevent="submit">
        <Input
          v-model:value="search"
          aria-label="搜索用户"
          placeholder="账号、订单、项目或讲述者"
          allow-clear
        /><Select
          v-model:value="pending"
          aria-label="待处理事项"
          :options="[
            { value: '', label: '全部事项' },
            { value: 'true', label: '有待处理服务' },
            { value: 'false', label: '无待处理服务' },
          ]"
        /><Button html-type="submit" type="primary">查询</Button>
      </form>
      <Alert v-if="error" type="error" :message="error" role="alert" /><Button
        v-if="error"
        @click="load"
        >重试</Button
      ><Table
        :columns="columns"
        :data-source="data?.items ?? []"
        row-key="id"
        :loading="busy"
        :scroll="{ x: 1050 }"
        :pagination="{
          current: data?.page ?? Number(route.query.page ?? 1),
          pageSize: data?.pageSize ?? Number(route.query.pageSize ?? 20),
          total: data?.total ?? 0,
          showSizeChanger: true,
          pageSizeOptions: ['20', '50', '100'],
          showTotal,
          onChange: paginate,
        }"
        :locale="{ emptyText: '没有符合条件的用户或讲述者' }"
        ><template #bodyCell="{ column, record }"
          ><template v-if="column.key === 'identity'">
            <Button
              type="link"
              @click="
                detail({
                  id: String(record.id),
                  kind: String(record.kind),
                  projectId: String(record.projectId),
                })
              "
              >{{ record.name ?? record.id }}</Button
            >
            <div v-if="record.name" class="identifier">
              {{ record.id }}
            </div> </template
          ><template v-else-if="column.key === 'kind'">{{
            record.kind === "account" ? "产品账号" : "无账号讲述者"
          }}</template>
          <template v-else-if="column.key === 'createdAt'">{{
            formatAdminTime(record.createdAt)
          }}</template>
          <template v-else-if="column.key === 'pending'"
            ><Tag v-if="record.pending" color="orange">待处理服务</Tag
            ><span v-else>暂无待处理服务</span></template
          >
          ></template
        ></Table
      ></Card
    ></Page
  >
</template>
