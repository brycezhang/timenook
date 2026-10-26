<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { Button, Alert, Input, FormItem } from "antdv-next";
import type { RefundView } from "@timenook/contracts";
import { REFUND_REASON_LABELS, REFUND_STATE_LABELS } from "@timenook/contracts";
import { refundApi } from "../api/admin";
const creationLabels = { retain: "保留", suspend: "暂停", terminate: "终止" };
const copyLabels = {
  retain: "保留",
  cancel: "取消",
  consumed: "保留已消费事实",
  quality_remedy: "原订单质量救济",
};
const props = defineProps<{ caseId: string; csrf: string }>();
const emit = defineEmits<{ expired: []; changed: [] }>();
const view = ref<RefundView | null>(null),
  busy = ref(false),
  error = ref(""),
  evidence = ref(""),
  failureAt = ref("");
let active = true,
  generation = 0,
  intent: { input: string; key: string } | null = null;
onUnmounted(() => {
  active = false;
  ++generation;
  view.value = null;
  intent = null;
});
async function refresh() {
  const token = ++generation;
  busy.value = true;
  error.value = "";
  try {
    const result = await refundApi.forCase(props.caseId);
    if (active && token === generation) view.value = result;
  } catch (failure) {
    if (active && token === generation) handle(failure);
  } finally {
    if (active && token === generation) busy.value = false;
  }
}
function handle(failure: unknown) {
  const code = (failure as { error?: { code?: string } }).error?.code;
  if (code === "UNAUTHENTICATED") {
    view.value = null;
    emit("expired");
  } else
    error.value =
      code === "CONFLICT"
        ? "金额、原生产状态或政策尚未满足，请查询原工单核实。"
        : "操作结果未确认，请查询原退款；重试保留同一意图。";
}
async function command(
  action: "approve" | "reject" | "submit" | "reconcile" | "production-review",
) {
  const current = view.value;
  if (!current || busy.value) return;
  const body =
    action === "approve"
      ? {
          amountFen: current.rule?.refundAmount.value,
          evidenceRef: evidence.value,
          ...(current.reason === "platformUnableDeliver"
            ? {
                failureNotifiedAt: failureAt.value
                  ? new Date(failureAt.value).toISOString()
                  : undefined,
              }
            : {}),
        }
      : action === "production-review"
        ? {
            attemptId: current.productionAttemptId,
            evidenceRef: evidence.value,
          }
        : action === "reject"
          ? { evidenceRef: evidence.value }
          : {};
  const input = JSON.stringify({ id: current.id, action, body });
  if (intent?.input !== input) intent = { input, key: crypto.randomUUID() };
  const token = ++generation;
  busy.value = true;
  error.value = "";
  try {
    const result = await refundApi.command(
      current.id,
      action,
      body,
      intent.key,
      props.csrf,
    );
    if (active && token === generation) {
      view.value = result;
      intent = null;
      emit("changed");
    }
  } catch (failure) {
    if (active && token === generation) handle(failure);
  } finally {
    if (active && token === generation) busy.value = false;
  }
}
onMounted(refresh);
</script>
<template>
  <section class="section" aria-label="退款处理">
    <h3>退款核验与原单对账</h3>
    <Alert v-if="error" type="error" :message="error" role="alert" />
    <Button :disabled="busy" @click="refresh">查询原退款</Button>
    <div v-if="view">
      <p>
        {{ REFUND_REASON_LABELS[view.reason] }} ·
        {{ REFUND_STATE_LABELS[view.state] }}
      </p>
      <p>申请说明：{{ view.requestDescription }}</p>
      <p>原订单：{{ view.orderId }}</p>
      <p>固定退款单号：{{ view.outRefundNo }}</p>
      <p>
        已批准金额：{{
          view.amountFen === null
            ? "待核验"
            : `¥${(view.amountFen / 100).toFixed(2)}`
        }}
      </p>
      <p v-if="view.rule">
        购买时的固定金额：¥{{
          (view.rule.refundAmount.value / 100).toFixed(2)
        }}；政策：{{ view.rule.policyRef }}；制作权益：{{
          creationLabels[view.rule.entitlementEffect.creation]
        }}；首本处理：{{ copyLabels[view.rule.entitlementEffect.firstCopy] }}
      </p>
      <p v-else>原购买政策不完整或当前执行路径不支持，不能批准。</p>
      <p v-if="view.approvedBy">
        实际处理人：{{ view.approvedBy }}；处理期限：{{ view.dueAt }}
      </p>
      <p v-if="view.completedAt">核实结果时间：{{ view.completedAt }}</p>
      <Alert
        v-if="view.processingState === 'overdue'"
        type="warning"
        message="已超过购买时约定的处理期限，请跟进原退款；重试不会延长原截止时间。"
      />
      <p>
        批准后暂停新投产；已发给印厂的原文件先核实实际接单或取消。退款不清除资料，不重置原始付款事实。
      </p>
      <FormItem label="退款核验证据"
        ><Input
          v-model:value="evidence"
          aria-label="退款核验证据"
          placeholder="synthetic:核验记录引用"
          :disabled="busy"
      /></FormItem>
      <label v-if="view.reason === 'platformUnableDeliver'"
        >已核实的故障告知时间<input
          v-model="failureAt"
          type="datetime-local"
          aria-label="已核实的故障告知时间"
          :disabled="busy"
      /></label>
      <Button
        v-if="view.state === 'requested'"
        type="primary"
        :disabled="busy || !view.rule || !evidence.startsWith('synthetic:')"
        @click="command('approve')"
        >按购买政策批准退款</Button
      >
      <Button
        v-if="view.state === 'requested' || view.state === 'approved'"
        :disabled="busy || !evidence.startsWith('synthetic:')"
        @click="command('reject')"
        >结束尚未执行的申请</Button
      >
      <div v-if="view.productionReviewRequired">
        <p>原交接结果须先在生产与物流中核实，未知结果不能执行退款。</p>
        <Button
          :disabled="busy || !evidence.startsWith('synthetic:')"
          @click="command('production-review')"
          >记录原生产核验结果</Button
        >
      </div>
      <Button
        v-if="view.state === 'approved' || view.state === 'unknown'"
        :disabled="busy || view.productionReviewRequired"
        @click="command('submit')"
        >执行原退款</Button
      >
      <Button
        v-if="['unknown', 'processing', 'abnormal'].includes(view.state)"
        :disabled="busy"
        @click="command('reconcile')"
        >向微信查询原退款</Button
      >
    </div>
  </section>
</template>
