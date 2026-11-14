<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import { Alert, Button, Card, Input, Table, Tag } from "antdv-next";
import type {
  AdminChannelGiftView,
  CreateChannelGiftCommand,
} from "@timenook/contracts";
import { adminRequest, errorText, session, sessionEpoch } from "../session";
import { formatAdminTime } from "../utils/time";
const rows = ref<AdminChannelGiftView[]>([]),
  loading = ref(false),
  saving = ref(false),
  error = ref(""),
  result = ref<AdminChannelGiftView | null>(null);
const phone = ref(""),
  external = ref(""),
  amount = ref(""),
  paidAt = ref("");
const submission = ref<{ key: string; body: CreateChannelGiftCommand } | null>(
  null,
);
let serial = 0;
const money = (n: number | null) =>
  n === null ? "未提供" : `¥${(n / 100).toFixed(2)}`;
const storageKey = () =>
  `timenook.channel-gift.submit:${session.value?.operator?.id ?? ""}`;
const columns = [
  { title: "内部编号 / 购买者", key: "purchase", width: 280 },
  { title: "套餐与实付", key: "amount", width: 200 },
  { title: "来源", key: "source", width: 240 },
  { title: "关联与使用", key: "state", width: 240 },
  { title: "购买与录入时间", key: "date", width: 230 },
];
async function load() {
  const n = ++serial,
    epoch = sessionEpoch;
  loading.value = true;
  try {
    const next = await adminRequest<AdminChannelGiftView[]>("/channel-gifts");
    if (n === serial && epoch === sessionEpoch) rows.value = next;
  } catch (e) {
    if (n === serial) error.value = errorText(e);
  } finally {
    if (n === serial) loading.value = false;
  }
}
function newPurchase() {
  submission.value = null;
  result.value = null;
  phone.value = "";
  external.value = "";
  amount.value = "";
  paidAt.value = "";
  error.value = "";
  sessionStorage.removeItem(storageKey());
}
async function submit() {
  if (saving.value || result.value) return;
  error.value = "";
  if (!submission.value) {
    if (!/^(?:\+?86)?1[3-9]\d{9}$/.test(phone.value.trim())) {
      error.value = "请填写有效的购买者手机号。";
      return;
    }
    if (
      amount.value &&
      (!/^\d+(?:\.\d{1,2})?$/.test(amount.value) ||
        Math.round(Number(amount.value) * 100) > 2147483647)
    ) {
      error.value = "实付金额最多保留两位小数。";
      return;
    }
    if (paidAt.value && !Number.isFinite(Date.parse(paidAt.value))) {
      error.value = "请填写有效的付款时间。";
      return;
    }
    submission.value = {
      key: crypto.randomUUID(),
      body: {
        buyerPhone: phone.value.trim(),
        ...(external.value.trim() ? { externalOrderNo: external.value } : {}),
        ...(amount.value
          ? { paidAmount: Math.round(Number(amount.value) * 100) }
          : {}),
        ...(paidAt.value
          ? { paidAt: new Date(paidAt.value).toISOString() }
          : {}),
      },
    };
    sessionStorage.setItem(storageKey(), JSON.stringify(submission.value));
  }
  saving.value = true;
  const epoch = sessionEpoch;
  try {
    const next = await adminRequest<AdminChannelGiftView>("/channel-gifts", {
      method: "POST",
      headers: {
        "x-csrf-token": session.value!.csrfToken,
        "idempotency-key": submission.value.key,
      },
      body: JSON.stringify(submission.value.body),
    });
    if (epoch !== sessionEpoch) return;
    result.value = next;
    sessionStorage.removeItem(storageKey());
    await load();
  } catch (e) {
    if (epoch === sessionEpoch)
      error.value = `${errorText(e)} 使用“重试本次录入”查询或完成原提交。`;
  } finally {
    saving.value = false;
  }
}
watch(
  () => session.value?.operator?.id,
  () => {
    serial++;
    rows.value = [];
    const saved = sessionStorage.getItem(storageKey());
    newPurchase();
    if (saved) {
      try {
        const draft = JSON.parse(saved);
        if (draft.key && draft.body?.buyerPhone) {
          submission.value = draft;
          sessionStorage.setItem(storageKey(), saved);
          phone.value = draft.body.buyerPhone;
          external.value = draft.body.externalOrderNo ?? "";
          amount.value =
            draft.body.paidAmount === undefined
              ? ""
              : String(draft.body.paidAmount / 100);
          paidAt.value = draft.body.paidAt ?? "";
        }
      } catch {
        sessionStorage.removeItem(storageKey());
      }
    }
    if (session.value?.authenticated) void load();
  },
  { immediate: true },
);
onBeforeUnmount(() => {
  serial++;
  rows.value = [];
});
</script>
<template>
  <Card title="录入订单" class="channel-card">
    <form class="channel-form" @submit.prevent="submit">
      <label
        >购买者手机号<Input
          v-model:value="phone"
          aria-label="购买者手机号"
          placeholder="11 位手机号"
          :disabled="!!submission || saving"
          :maxlength="14"
      /></label>
      <details>
        <summary>补充购买信息（选填）</summary>
        <div class="channel-extra">
          <label
            >原订单号<Input
              v-model:value="external"
              aria-label="原订单号"
              :disabled="!!submission || saving"
              :maxlength="200"
          /></label>
          <label
            >实付金额（元）<Input
              v-model:value="amount"
              aria-label="实付金额（元）"
              placeholder="未提供"
              :disabled="!!submission || saving"
          /></label>
          <label
            >付款时间<input
              v-model="paidAt"
              aria-label="付款时间"
              type="datetime-local"
              :disabled="!!submission || saving"
          /></label>
        </div>
      </details>
      <Button
        v-if="!result"
        html-type="submit"
        type="primary"
        :loading="saving"
        >{{ submission ? "重试本次录入" : "确认购买并录入" }}</Button
      >
    </form>
    <Alert v-if="error" type="error" :message="error" role="alert" />
    <div v-if="result" class="channel-result" role="status">
      <Alert
        type="success"
        :message="`录入成功 · ${result.internalNumber} · ${result.maskedBuyerPhone}`"
      /><Button @click="newPurchase">录入新的一笔</Button>
    </div>
  </Card>
  <Card title="渠道购买记录" class="channel-card"
    ><template #extra
      ><Button :loading="loading" @click="load">刷新</Button></template
    >
    <Table
      :columns="columns"
      :data-source="rows"
      row-key="id"
      :loading="loading"
      :scroll="{ x: 1190 }"
      :pagination="{ pageSize: 20 }"
      :locale="{ emptyText: '暂无渠道购买记录' }"
    >
      <template #bodyCell="{ column, record }">
        <template v-if="column.key === 'purchase'"
          ><div>{{ record.internalNumber }}</div>
          <div>
            {{ record.buyerPhone || record.maskedBuyerPhone }}
          </div></template
        >
        <template v-else-if="column.key === 'amount'"
          ><div>{{ record.packageTitle }} × 1</div>
          <div>套餐标价 {{ money(record.listAmount) }}</div>
          <div>实付金额 {{ money(record.paidAmount) }}</div></template
        >
        <template v-else-if="column.key === 'source'"
          ><div>录入账号 {{ record.operatorName }}</div>
          <div>原订单号 {{ record.externalOrderNo ?? "未提供" }}</div></template
        >
        <template v-else-if="column.key === 'state'"
          ><Tag>{{
            record.state === "void"
              ? "已作废"
              : record.projectId
                ? "已开通"
                : record.buyerId
                  ? "待送出"
                  : "待关联"
          }}</Tag>
          <div v-if="record.buyerId">账号 {{ record.buyerId }}</div>
          <div v-if="record.projectId">
            故事书 {{ record.projectId }}
          </div></template
        >
        <template v-else-if="column.key === 'date'"
          ><div>
            付款时间
            {{ record.paidAt ? formatAdminTime(record.paidAt) : "未提供" }}
          </div>
          <div>录入时间 {{ formatAdminTime(record.createdAt) }}</div></template
        >
      </template>
    </Table>
  </Card>
</template>
<style scoped>
.channel-card {
  margin-bottom: 16px;
}
.channel-form {
  display: grid;
  gap: 16px;
  max-width: 640px;
}
.channel-form label {
  display: grid;
  gap: 6px;
}
.channel-extra {
  display: grid;
  gap: 12px;
  margin-top: 12px;
}
.channel-extra input[type="datetime-local"] {
  border: 1px solid #d9d9d9;
  border-radius: 6px;
  padding: 6px 10px;
}
.channel-result {
  display: grid;
  gap: 12px;
  margin-top: 16px;
}
</style>
