<script setup lang="ts">
import { formatAdminTime } from "../utils/time";
import { ref, watch, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Page } from "@vben/common-ui";
import { Alert, Button, Card, Input, Select, Table, Tag } from "antdv-next";
import type { AdminProductionPage } from "@timenook/contracts";
import { adminRequest, errorText, sessionEpoch } from "../session";
const route = useRoute(),
  router = useRouter(),
  data = ref<AdminProductionPage | null>(null),
  busy = ref(false),
  error = ref("");
const search = ref(String(route.query.q ?? "")),
  state = ref(String(route.query.state ?? "")),
  pending = ref(String(route.query.pending ?? ""));
let serial = 0,
  abort: AbortController | undefined;

const stateLabels: Record<string, string> = {
  pdf_ready: "PDF 书稿完成",
  approved: "已审核，等待交接",
  handoff_pending: "交接结果待核实",
  in_production: "印厂已确认接单",
  printed: "已生产",
  shipped: "已发货",
  delivered: "已交付",
  cancellation_pending: "取消待人工核实",
  cancelled: "已确认取消",
};
const showTotal = (total: number) => `共 ${total} 条生产单`;
const columns = [
  { title: "生产单 / 原订单", key: "order", width: 300 },
  { title: "讲述者 / 书名", key: "identity", width: 230 },
  { title: "生产进度", key: "state", width: 230 },
  { title: "创建时间", key: "createdAt", width: 220 },
];
const exception = ref(String(route.query.exception ?? ""));
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
    for (const key of [
      "q",
      "state",
      "pending",
      "exception",
      "page",
      "pageSize",
    ]) {
      const v = route.query[key];
      if (typeof v === "string") query.set(key, v);
    }
    const result = await adminRequest<AdminProductionPage>(
      `/fulfillment?${query}`,
      {
        signal: abort.signal,
      },
    );
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
    path: "/production",
    query: {
      ...(search.value.trim() ? { q: search.value.trim() } : {}),
      ...(state.value ? { state: state.value } : {}),
      ...(pending.value ? { pending: pending.value } : {}),
      ...(exception.value ? { exception: exception.value } : {}),
      page: "1",
      pageSize: String(route.query.pageSize ?? 20),
    },
  };
  if (router.resolve(target).fullPath === route.fullPath) void load();
  else void router.push(target);
}
function resetFilters() {
  search.value = "";
  state.value = "";
  pending.value = "";
  exception.value = "";
  void router.push("/production");
}
function paginate(page: number, pageSize: number) {
  void router.push({
    path: "/production",
    query: { ...route.query, page: String(page), pageSize: String(pageSize) },
  });
}
function detail(order: { id: string }) {
  void router.push({
    path: `/production/${order.id}`,
    query: { from: route.fullPath },
  });
}
watch(
  () => route.fullPath,
  () => {
    search.value = String(route.query.q ?? "");
    state.value = String(route.query.state ?? "");
    pending.value = String(route.query.pending ?? "");
    exception.value = String(route.query.exception ?? "");
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
  <Page title="生产单管理" description="按确定 PDF 人工交接、完成印制与发货。"
    ><template #title><h1>生产单管理</h1></template>
    <Card
      ><form class="query-form" @submit.prevent="submit">
        <Input
          v-model:value="search"
          aria-label="搜索生产单"
          placeholder="生产单、原订单号、项目或讲述者"
          allow-clear
        />
        <Select
          v-model:value="state"
          aria-label="生产进度"
          :options="[
            { value: '', label: '全部进度' },
            ...Object.entries(stateLabels).map(([value, label]) => ({
              value,
              label,
            })),
          ]"
        />
        <Select
          v-model:value="pending"
          aria-label="生产待处理"
          :options="[
            { value: '', label: '全部事项' },
            { value: 'true', label: '待处理' },
            { value: 'false', label: '已完成或取消' },
          ]"
        />
        <Select
          v-model:value="exception"
          aria-label="生产异常"
          :options="[
            { value: '', label: '全部异常状态' },
            { value: 'true', label: '有异常或超期' },
            { value: 'false', label: '无异常' },
          ]"
        />
        <div class="query-actions">
          <Button html-type="submit" type="primary">查询</Button>
          <Button @click="resetFilters">重置</Button>
        </div>
      </form>
      <Alert v-if="error" type="error" :message="error" role="alert" /><Button
        v-if="error"
        @click="load"
        >重试</Button
      >
      <Table
        :columns="columns"
        :data-source="data?.items ?? []"
        row-key="id"
        :loading="busy"
        :scroll="{ x: 980 }"
        :pagination="{
          current: data?.page ?? Number(route.query.page ?? 1),
          pageSize: data?.pageSize ?? Number(route.query.pageSize ?? 20),
          total: data?.total ?? 0,
          showSizeChanger: true,
          pageSizeOptions: ['20', '50', '100'],
          showTotal,
          onChange: paginate,
        }"
        :locale="{ emptyText: '没有符合条件的生产单' }"
      >
        <template #bodyCell="{ column, record }"
          ><template v-if="column.key === 'order'"
            ><Button type="link" @click="detail({ id: String(record.id) })">{{
              record.id
            }}</Button>
            <div class="identifier">原订单 {{ record.outTradeNo }}</div>
            <div class="identifier">项目 {{ record.projectId }}</div></template
          >
          <template v-else-if="column.key === 'identity'"
            ><div>{{ record.subjectName ?? "未命名讲述者" }}</div>
            <div>{{ record.bookTitle }}</div></template
          >
          <template v-else-if="column.key === 'createdAt'">{{
            formatAdminTime(record.createdAt)
          }}</template>
          <template v-else-if="column.key === 'state'"
            ><Tag>{{ stateLabels[String(record.state)] ?? record.state }}</Tag
            ><Tag v-if="record.pending" color="orange">待处理</Tag
            ><Tag v-if="record.exception" color="red">需核实</Tag></template
          ></template
        >
      </Table></Card
    ></Page
  >
</template>
