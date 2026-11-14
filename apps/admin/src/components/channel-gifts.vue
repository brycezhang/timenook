<script setup lang="ts">
import { ref, watch, onBeforeUnmount } from "vue";
import {
  Alert,
  Button,
  Card,
  Input,
  Table,
  Tag,
  Modal,
  TextArea,
} from "antdv-next";
import type {
  AdminChannelGiftView,
  AdminChannelGiftDetail,
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
const detail = ref<AdminChannelGiftDetail | null>(null);
const detailOpen = ref(false),
  changing = ref(false),
  changeError = ref("");
const changeMode = ref<"correct" | "void" | null>(null),
  nextPhone = ref(""),
  reason = ref("");
const canChange = (row: AdminChannelGiftView) =>
  row.state === "active" && row.usageStatus !== "activated" && !row.projectId;
async function openDetail(id: string) {
  const epoch = sessionEpoch;
  changeError.value = "";
  changeMode.value = null;
  try {
    const next = await adminRequest<AdminChannelGiftDetail>(
      `/channel-gifts/${id}`,
    );
    if (epoch !== sessionEpoch) return;
    detail.value = next;
    detailOpen.value = true;
  } catch (e) {
    if (epoch === sessionEpoch) error.value = errorText(e);
  }
}
function beginChange(mode: "correct" | "void") {
  changeMode.value = mode;
  nextPhone.value = "";
  reason.value = "";
  changeError.value = "";
}
async function change() {
  if (changing.value || !detail.value || !changeMode.value) return;
  if (!reason.value.trim()) {
    changeError.value = "请填写操作原因。";
    return;
  }
  if (
    changeMode.value === "correct" &&
    !/^(?:\+?86)?1[3-9]\d{9}$/.test(nextPhone.value.trim())
  ) {
    changeError.value = "请填写有效的新购买者手机号。";
    return;
  }
  changing.value = true;
  changeError.value = "";
  const epoch = sessionEpoch,
    id = detail.value.id;
  try {
    const next = await adminRequest<AdminChannelGiftDetail>(
      `/channel-gifts/${id}/${changeMode.value}`,
      {
        method: "POST",
        headers: { "x-csrf-token": session.value!.csrfToken },
        body: JSON.stringify({
          reason: reason.value.trim(),
          ...(changeMode.value === "correct"
            ? { buyerPhone: nextPhone.value.trim() }
            : {}),
        }),
      },
    );
    if (epoch !== sessionEpoch) return;
    detail.value = next;
    changeMode.value = null;
  } catch (e) {
    if (epoch !== sessionEpoch) return;
    changeError.value = `${errorText(e)} 已重新读取当前记录。`;
    try {
      const current = await adminRequest<AdminChannelGiftDetail>(
        `/channel-gifts/${id}`,
      );
      if (epoch !== sessionEpoch) return;
      detail.value = current;
    } catch {
      detailOpen.value = false;
    }
    if (detail.value && !canChange(detail.value)) changeMode.value = null;
  } finally {
    changing.value = false;
    if (epoch === sessionEpoch) await load();
  }
}
let serial = 0;
const money = (n: number | null) =>
  n === null ? "未提供" : `¥${(n / 100).toFixed(2)}`;
const storageKey = () =>
  `timenook.channel-gift.submit:${session.value?.operator?.id ?? ""}`;
const columns = [
  { title: "操作", key: "actions", width: 100 },
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
    detailOpen.value = false;
    detail.value = null;
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
        <template v-if="column.key === 'actions'"
          ><Button @click="openDetail(record.id)">详情</Button></template
        >
        <template v-else-if="column.key === 'purchase'"
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
              : record.usageStatus === "activated" || record.projectId
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
  <Modal
    v-model:open="detailOpen"
    title="渠道订单详情"
    :footer="null"
    :mask-closable="!changing"
    :closable="!changing"
  >
    <div v-if="detail" class="channel-detail">
      <div>内部编号 {{ detail.internalNumber }}</div>
      <div>购买者 {{ detail.buyerPhone || detail.maskedBuyerPhone }}</div>
      <div>录入账号 {{ detail.operatorName }}</div>
      <Tag>{{
        detail.state === "void"
          ? "已作废"
          : canChange(detail)
            ? "待送出"
            : "已开通"
      }}</Tag>
      <div v-if="!canChange(detail)">
        {{
          detail.state === "void"
            ? "该记录已作废。"
            : "已创建故事书，购买者归属已锁定。"
        }}
      </div>
      <div v-if="canChange(detail) && !changeMode" class="channel-actions">
        <Button @click="beginChange('correct')">更正手机号</Button>
        <Button danger @click="beginChange('void')">录入错误作废</Button>
      </div>
      <form
        v-if="changeMode && canChange(detail)"
        class="channel-form"
        @submit.prevent="change"
      >
        <label v-if="changeMode === 'correct'"
          >新购买者手机号<Input
            v-model:value="nextPhone"
            aria-label="新购买者手机号"
            :maxlength="14"
            :disabled="changing"
        /></label>
        <label
          >操作原因<TextArea
            v-model:value="reason"
            aria-label="操作原因"
            :maxlength="500"
            :disabled="changing"
        /></label>
        <div class="channel-actions">
          <Button
            html-type="submit"
            type="primary"
            :danger="changeMode === 'void'"
            :loading="changing"
            >{{ changeMode === "correct" ? "确认更正" : "确认作废" }}</Button
          ><Button :disabled="changing" @click="changeMode = null">取消</Button>
        </div>
      </form>
      <Alert
        v-if="changeError"
        type="error"
        :message="changeError"
        role="alert"
      />
      <h3>操作记录</h3>
      <div v-if="!detail.operations.length">暂无更正或作废记录</div>
      <div
        v-for="operation in detail.operations"
        :key="operation.id"
        class="channel-operation"
      >
        <div>
          {{ operation.action === "correct" ? "更正手机号" : "录入错误作废" }} ·
          {{ operation.operatorName }} ·
          {{ formatAdminTime(operation.createdAt) }}
        </div>
        <div v-if="operation.action === 'correct'">
          {{ operation.beforePhone }} → {{ operation.afterPhone }}
        </div>
        <div>原因：{{ operation.reason }}</div>
      </div>
    </div>
  </Modal>
</template>
<style scoped>
.channel-detail {
  display: grid;
  gap: 12px;
  overflow-wrap: anywhere;
}
.channel-actions {
  display: flex;
  gap: 8px;
}
.channel-operation {
  border-top: 1px solid #eee;
  padding-top: 12px;
}
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
