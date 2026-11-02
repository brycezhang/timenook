<script setup lang="ts">
import { useMediaQuery } from "@vueuse/core";
import { computed, ref, watch, onBeforeUnmount } from "vue";
import { useRoute, useRouter, RouterLink } from "vue-router";
import { Page } from "@vben/common-ui";
import {
  Alert,
  Button,
  Card,
  Descriptions,
  DescriptionsItem,
  TextArea,
  Spin,
  Table,
  Tag,
} from "antdv-next";
import {
  ADMIN_PERMISSIONS,
  type AdminOrderDetail,
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
const narrow = useMediaQuery("(max-width:767px)");
const route = useRoute(),
  router = useRouter(),
  detail = ref<AdminOrderDetail | null>(null),
  busy = ref(false),
  saving = ref(false),
  error = ref(""),
  notice = ref(""),
  content = ref("");
let serial = 0,
  abort: AbortController | undefined,
  noteKey = crypto.randomUUID();
const money = (n: number) => `¥${(n / 100).toFixed(2)}`;
const back = computed(() =>
  typeof route.query.from === "string"
    ? safeReturn(route.query.from)
    : "/orders",
);
const financialState = (state: string) =>
  (
    ({
      pending: "待付款",
      paid: "已付款",
      requested: "待审核",
      approved: "已批准",
      submitting: "提交中",
      unknown: "待核实",
      submitted: "已提交",
      succeeded: "已退款",
      completed: "已处理",
      closed: "已关闭",
      rejected: "已拒绝",
      resolved: "已处理",
    }) as Record<string, string>
  )[state] ?? state;
async function load() {
  const token = ++serial,
    epoch = sessionEpoch,
    id = String(route.params.id);
  abort?.abort();
  abort = new AbortController();
  busy.value = true;
  error.value = "";
  detail.value = null;
  try {
    const result = await adminRequest<AdminOrderDetail>(`/orders/${id}`, {
      signal: abort.signal,
    });
    if (token === serial && epoch === sessionEpoch) detail.value = result;
  } catch (e) {
    if (token === serial && !(e instanceof Error && e.name === "AbortError"))
      error.value = errorText(e);
  } finally {
    if (token === serial) busy.value = false;
  }
}
async function append() {
  if (saving.value || !content.value.trim()) return;
  const id = String(route.params.id),
    token = serial,
    epoch = sessionEpoch;
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    const note = await adminRequest<AdminOrderNote>(`/orders/${id}/notes`, {
      method: "POST",
      headers: {
        "X-CSRF-Token": session.value!.csrfToken,
        "Idempotency-Key": noteKey,
      },
      body: JSON.stringify({ content: content.value }),
    });
    if (token === serial && epoch === sessionEpoch) {
      content.value = "";
      noteKey = crypto.randomUUID();
      if (detail.value && !detail.value.notes.some((n) => n.id === note.id))
        detail.value.notes.unshift(note);
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
    noteKey = crypto.randomUUID();
    notice.value = "";
    saving.value = false;
    void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  serial++;
  abort?.abort();
  detail.value = null;
  content.value = "";
});
</script>
<template>
  <Page title="订单详情" class="order-details"
    ><template #title><h1>订单详情</h1></template
    ><template #extra
      ><Button @click="router.push(back)">返回订单列表</Button
      ><Button :loading="busy" @click="load">刷新</Button></template
    ><Alert v-if="error" role="alert" type="error" :message="error" /><Alert
      v-if="notice"
      role="status"
      type="success"
      :message="notice" /><Spin v-if="busy" /><template v-if="detail"
      ><Card title="购买与付款事实"
        ><Tag v-if="detail.isE2e" color="orange">受控 1 分验收订单</Tag
        ><Tag v-else-if="detail.mode !== 'wechat'">本地验证订单</Tag
        ><Descriptions bordered :column="narrow ? 1 : 2"
          ><DescriptionsItem label="订单号">{{
            detail.outTradeNo
          }}</DescriptionsItem
          ><DescriptionsItem label="订单编号"
            ><span class="identifier">{{ detail.id }}</span></DescriptionsItem
          ><DescriptionsItem label="标价">{{
            money(detail.listAmount)
          }}</DescriptionsItem
          ><DescriptionsItem label="本单应付">{{
            money(detail.payableAmount)
          }}</DescriptionsItem
          ><DescriptionsItem label="实际收款">{{
            money(detail.paidAmount)
          }}</DescriptionsItem
          ><DescriptionsItem label="实际退款">{{
            money(detail.refundedAmount)
          }}</DescriptionsItem
          ><DescriptionsItem label="付款状态">{{
            financialState(detail.state)
          }}</DescriptionsItem
          ><DescriptionsItem label="付款时间">{{
            detail.payment?.paidAt ?? "暂无付款事实"
          }}</DescriptionsItem
          ><DescriptionsItem label="微信支付交易号">{{
            detail.payment?.providerTransactionId ?? "—"
          }}</DescriptionsItem
          ><DescriptionsItem label="首本权益">{{
            detail.entitlement?.state ?? "尚未生成"
          }}</DescriptionsItem
          ><DescriptionsItem label="创建时间">{{
            detail.createdAt
          }}</DescriptionsItem></Descriptions
        ></Card
      ><Card title="关联资源"
        ><Descriptions bordered :column="1"
          ><DescriptionsItem label="购买账号"
            ><RouterLink :to="`/users/${detail.buyerId}`">{{
              detail.buyerId
            }}</RouterLink></DescriptionsItem
          ><DescriptionsItem label="讲述者"
            >{{ detail.subjectName ?? "尚未建立"
            }}<span v-if="detail.subjectId" class="identifier">
              · 讲述者编号 {{ detail.subjectId }}</span
            >
            <div v-if="detail.narratorUserId">
              讲述者产品账号：<RouterLink
                :to="`/users/${detail.narratorUserId}`"
                >{{ detail.narratorUserId }}</RouterLink
              >
            </div>
            <div v-else>讲述者尚未绑定独立产品账号</div></DescriptionsItem
          ><DescriptionsItem label="项目"
            ><RouterLink
              v-if="detail.projectId"
              :to="`/users/projects/${detail.projectId}`"
              >{{ detail.bookTitle ?? detail.projectId }}</RouterLink
            ><span v-else>尚未生成项目</span></DescriptionsItem
          ><DescriptionsItem label="生产单"
            ><RouterLink
              v-if="detail.productionOrder"
              :to="`/production/${detail.productionOrder.id}`"
              >{{ detail.productionOrder.id }} ·
              {{ detail.productionOrder.state }}</RouterLink
            ><span v-else>尚未申请制作</span></DescriptionsItem
          ></Descriptions
        ></Card
      ><Card title="已有退款与质量申请"
        ><Table
          size="small"
          row-key="id"
          :data-source="detail.refunds"
          :pagination="false"
          :scroll="{ x: 600 }"
          :columns="[
            { title: '退款编号', dataIndex: 'id' },
            { title: '状态', key: 'state' },
            { title: '本次退款金额', key: 'amount' },
            { title: '到账时间', dataIndex: 'completedAt' },
          ]"
          :locale="{ emptyText: '暂无退款申请' }"
          ><template #bodyCell="{ column, record }"
            ><span v-if="column.key === 'state'">{{
              financialState(record.state)
            }}</span
            ><span v-if="column.key === 'amount'">{{
              record.amount === null ? "尚未确定" : money(record.amount)
            }}</span></template
          ></Table
        ><Table
          size="small"
          row-key="id"
          :data-source="detail.qualityRequests"
          :pagination="false"
          :columns="[
            { title: '质量申请编号', dataIndex: 'id' },
            { title: '状态', dataIndex: 'state' },
          ]"
          :locale="{ emptyText: '暂无质量申请' }"
        />
        <p class="muted">售后处理功能暂未开放。</p></Card
      ><Card title="内部备注"
        ><form
          v-if="can(ADMIN_PERMISSIONS.writeOrders)"
          class="note-form"
          @submit.prevent="append"
        >
          <TextArea
            v-model:value="content"
            aria-label="内部备注"
            placeholder="记录沟通和处理依据（最多 2000 字）"
            :maxlength="2000"
            :rows="3"
          /><Button
            html-type="submit"
            type="primary"
            :loading="saving"
            :disabled="!content.trim()"
            >追加备注</Button
          >
        </form>
        <p v-else class="muted">当前账号只有查询权限。</p>
        <p v-if="!detail.notes.length" class="muted">暂无内部备注。</p>
        <article v-for="note in detail.notes" :key="note.id" class="order-note">
          <p class="note-content">{{ note.content }}</p>
          <small>{{ note.operatorName }} · {{ note.createdAt }}</small>
        </article></Card
      ><Card title="本单操作历史"
        ><Table
          size="small"
          row-key="id"
          :data-source="detail.history"
          :pagination="false"
          :scroll="{ x: 650 }"
          :columns="[
            { title: '操作', dataIndex: 'action' },
            { title: '操作人编号', dataIndex: 'operatorId' },
            { title: '结果', dataIndex: 'result' },
            { title: '时间', dataIndex: 'createdAt' },
          ]"
          :locale="{ emptyText: '暂无后台操作记录' }" /></Card></template
  ></Page>
</template>
