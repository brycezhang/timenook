<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Page } from "@vben/common-ui";
import { Alert, Button, Card, Input, Select, Table, Tag } from "antdv-next";
import type { AdminOrdersPage } from "@timenook/contracts";
import { adminRequest, errorText, sessionEpoch } from "../session";
import { formatAdminTime } from "../utils/time";
import { orderStateLabels as stateLabels } from "../utils/order-status";
const route = useRoute(),
  router = useRouter(),
  data = ref<AdminOrdersPage | null>(null),
  busy = ref(false),
  error = ref("");
const search = ref(String(route.query.q ?? "")),
  state = ref(String(route.query.state ?? "")),
  pending = ref(String(route.query.pending ?? ""));
let serial = 0,
  abort: AbortController | undefined;
const money = (n: number) => `¥${(n / 100).toFixed(2)}`;
const showTotal = (total: number) => `共 ${total} 条订单`;
const columns = [
  { title: "订单号", key: "order", width: 250 },
  { title: "购买账号 / 讲述者", key: "identity", width: 240 },
  { title: "价格与收款", key: "money", width: 210 },
  { title: "状态", key: "state", width: 150 },
  { title: "创建时间", dataIndex: "createdAt", width: 200 },
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
    for (const key of ["q", "state", "pending", "page", "pageSize"]) {
      const v = route.query[key];
      if (typeof v === "string") query.set(key, v);
    }
    const result = await adminRequest<AdminOrdersPage>(`/orders?${query}`, {
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
    path: "/orders",
    query: {
      ...(search.value.trim() ? { q: search.value.trim() } : {}),
      ...(state.value ? { state: state.value } : {}),
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
    path: "/orders",
    query: { ...route.query, page: String(page), pageSize: String(pageSize) },
  });
}
function detail(order: { id: string }) {
  void router.push({
    path: `/orders/${order.id}`,
    query: { from: route.fullPath },
  });
}
watch(
  () => route.fullPath,
  () => {
    search.value = String(route.query.q ?? "");
    state.value = String(route.query.state ?? "");
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
  <Page title="订单管理" description="查询购买记录、付款事实与关联服务。"
    ><template #title><h1>订单管理</h1></template
    ><Card
      ><form class="query-form" @submit.prevent="submit">
        <Input
          v-model:value="search"
          aria-label="搜索订单"
          placeholder="订单号、购买账号、项目或讲述者"
          allow-clear
        /><Select
          v-model:value="state"
          aria-label="订单状态"
          :options="[
            { value: '', label: '全部订单状态' },
            { value: 'pending', label: '待付款' },
            { value: 'paid', label: '已付款' },
            { value: 'refunded', label: '已退款' },
            { value: 'partially_refunded', label: '部分退款' },
            { value: 'closed', label: '已关闭' },
          ]"
        /><Select
          v-model:value="pending"
          aria-label="待处理事项"
          :options="[
            { value: '', label: '全部事项' },
            { value: 'true', label: '有待处理售后' },
            { value: 'false', label: '无待处理售后' },
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
        :locale="{ emptyText: '没有符合条件的订单' }"
        ><template #bodyCell="{ column, record }"
          ><template v-if="column.key === 'order'"
            ><Button type="link" @click="detail({ id: String(record.id) })">{{
              record.outTradeNo
            }}</Button>
            <div v-if="record.isE2e">
              <Tag color="orange">受控 1 分验收</Tag>
            </div>
            <div v-else-if="record.mode !== 'wechat'">
              <Tag>本地验证订单</Tag>
            </div></template
          ><template v-else-if="column.key === 'identity'"
            ><div class="identifier">{{ record.buyerId }}</div>
            <div>{{ record.subjectName ?? "尚未关联讲述者" }}</div>
            <div>{{ record.bookTitle }}</div></template
          ><template v-else-if="column.key === 'money'"
            ><div>标价 {{ money(record.listAmount) }}</div>
            <div>
              实收 {{ money(record.paidAmount) }} · 已退
              {{ money(record.refundedAmount) }}
            </div></template
          ><template v-else-if="column.key === 'state'"
            ><Tag
              :color="
                record.state === 'paid'
                  ? 'green'
                  : record.state === 'refunded'
                    ? 'blue'
                    : 'default'
              "
              >{{ stateLabels[record.state] ?? record.state }}</Tag
            ><Tag v-if="record.pending" color="orange"
              >待处理售后</Tag
            ></template
          ><span v-else-if="column.dataIndex === 'createdAt'">{{
            formatAdminTime(record.createdAt)
          }}</span></template
        ></Table
      ></Card
    ></Page
  >
</template>
