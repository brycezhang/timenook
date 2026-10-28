<script setup lang="ts">
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { Alert, Button, Input } from "antdv-next";
import type { DeletionStatus, DeletionItemView } from "@timenook/contracts";
import { deletionApi } from "../api/admin";
import {
  DELETION_CATEGORY_LABELS as categoryLabels,
  DELETION_LAYER_LABELS as layerLabels,
} from "@timenook/contracts";
const props = defineProps<{ caseId: string; csrf: string }>();
const emit = defineEmits<{ expired: [] }>();
const value = ref<DeletionStatus | null>(null),
  busy = ref(false),
  error = ref(""),
  evidence = ref(""),
  selectedItem = ref<DeletionItemView | null>(null),
  notice = ref("");
let active = true,
  generation = 0,
  intent: { input: string; key: string } | null = null;
const reasonLabels: Record<string, string> = {
  NO_PLATFORM_TARGETS: "本层没有待清理的活动文件",
  RETRY_REQUIRED: "活动清理待重试",
  RULE_NOT_FROZEN: "处理规则尚待冻结",
  EXTERNAL_RECEIPT_REQUIRED: "等待独立核验回执",
};
const rows = computed(
  () => value.value?.changes.flatMap((change) => change.items) || [],
);
const editable = (item: DeletionItemView) =>
  ["object_history", "backup", "supplier"].includes(item.layer) &&
  item.state !== "completed";
function stateLabel(item: DeletionItemView) {
  return item.state === "completed"
    ? "本层已完成"
    : item.state === "running"
      ? "清理执行中"
      : item.state === "awaiting_evidence"
        ? "等待独立核验证据"
        : "待清理或重试";
}
function reset() {
  ++generation;
  busy.value = false;
  value.value = null;
  selectedItem.value = null;
  evidence.value = "";
  intent = null;
  error.value = "";
  notice.value = "";
}
onUnmounted(() => {
  active = false;
  reset();
});
watch(
  () => props.caseId,
  () => {
    reset();
    void refresh();
  },
);
function current(id: string, g: number) {
  return active && id === props.caseId && g === generation;
}
function failure(errorValue: unknown) {
  const code = (errorValue as { error?: { code?: string } }).error?.code;
  if (code === "UNAUTHENTICATED") {
    value.value = null;
    selectedItem.value = null;
    evidence.value = "";
    intent = null;
    emit("expired");
  } else if (code === "FORBIDDEN") {
    value.value = null;
    selectedItem.value = null;
    evidence.value = "";
    intent = null;
    error.value = "本工单权限已变化，请重新核验。";
  } else
    error.value =
      code === "CONFLICT"
        ? "本层状态或原始期限不允许本次录入，请查询原记录核实。"
        : "处理结果未确认，请查询原清单；重试保留同一意图。";
}
async function refresh() {
  if (busy.value) return;
  const id = props.caseId,
    g = ++generation;
  busy.value = true;
  error.value = "";
  try {
    const result = await deletionApi.read(id);
    if (current(id, g)) {
      const selectedId = selectedItem.value?.id;
      value.value = result;
      if (selectedId) {
        const next = rows.value.find((row) => row.id === selectedId);
        if (next && editable(next)) selectedItem.value = next;
        else {
          selectedItem.value = null;
          evidence.value = "";
          intent = null;
        }
      }
    }
  } catch (errorValue) {
    if (current(id, g)) failure(errorValue);
  } finally {
    if (current(id, g)) busy.value = false;
  }
}
function select(item: DeletionItemView) {
  if (busy.value || !editable(item)) return;
  selectedItem.value = item;
  evidence.value = "";
  intent = null;
  notice.value = "";
}
async function command(state: "reconcile" | "confirmed" | "pending") {
  if (busy.value || !value.value) return;
  const item = selectedItem.value;
  if (
    state !== "reconcile" &&
    (!item ||
      !rows.value.some((row) => row === item) ||
      !editable(item) ||
      !/^record:synthetic-[-A-Za-z0-9_:]{3,120}$/.test(evidence.value))
  )
    return;
  const id = props.caseId,
    g = ++generation,
    action = state === "reconcile" ? "reconcile" : `items/${item!.id}/evidence`,
    body = state === "reconcile" ? {} : { state, evidenceRef: evidence.value };
  const input = JSON.stringify({ id, action, body });
  if (intent?.input !== input) intent = { input, key: crypto.randomUUID() };
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    const result = await deletionApi.command(
      id,
      action,
      body,
      intent.key,
      props.csrf,
    );
    if (!current(id, g)) return;
    value.value = result;
    intent = null;
    selectedItem.value = null;
    evidence.value = "";
    notice.value =
      state === "reconcile"
        ? "系统活动层已重新核对，完成与待处理项分别见清单。"
        : "本项回执已记录，其他副本仍分别核验。";
  } catch (errorValue) {
    if (current(id, g)) failure(errorValue);
  } finally {
    if (current(id, g)) busy.value = false;
  }
}
onMounted(refresh);
</script>
<template>
  <section class="section deletion-care" aria-label="逐层资料删除">
    <h3>资料删除与副本清单</h3>
    <Alert v-if="error" type="error" :message="error" role="alert" />
    <Alert v-if="notice" type="info" :message="notice" role="status" />
    <p>
      隔离合成验证：示例引用仅验证工程流程，不构成真实供应商或备份删除回执。
    </p>
    <Button :disabled="busy" @click="refresh">查询删除清单</Button>
    <template v-if="value">
      <p>
        {{
          value.onlineAccessStopped ? "在线访问已停止" : "在线访问尚未确认停止"
        }}。{{
          value.permanentProjectDeletion
            ? "全项目删除已核验且不可逆；清理结果逐项核实。"
            : value.changes.length
              ? "按类别到期清理，未表示全项目删除。独立有效的资料继续按原规则处理。"
              : "尚无已核验删除或保留期届满记录。"
        }}
      </p>
      <p>
        已传输到设备、已交付导出与纸书不能由平台收回；供应商与备份按各自证据处理。交易记录与内容删除分开。
      </p>
      <p v-if="!value.changes.length">
        本人删除申请核验前只表示待核验，不能据此声称访问已停止。
      </p>
      <Button
        v-if="value.changes.length"
        :disabled="busy"
        @click="command('reconcile')"
        >重新执行系统活动层清理</Button
      >
      <article
        v-for="item in rows"
        :key="item.id"
        class="audit-section deletion-item"
      >
        <h4>
          {{ categoryLabels[item.category] || "相关资料" }} ·
          {{ layerLabels[item.layer] }}
        </h4>
        <p>
          类别：{{ item.category }}；副本层：{{ item.layer }}；{{
            stateLabel(item)
          }}
        </p>
        <p>
          原处理截止：{{ item.deadline || "规则或起算待确认"
          }}<span
            v-if="
              item.deadline &&
              item.state !== 'completed' &&
              Date.parse(item.deadline) <= Date.now()
            "
            >；已到期，结果仍待核实</span
          >
        </p>
        <p v-if="item.reason">
          待处理原因：{{
            reasonLabels[item.reason] || "处理尚未确认，请核实原清单"
          }}
        </p>
        <p v-if="item.evidenceRef">本项回执：{{ item.evidenceRef }}</p>
        <p v-if="item.completedAt">本层完成时间：{{ item.completedAt }}</p>
        <Button v-if="editable(item)" :disabled="busy" @click="select(item)"
          >录入此项核验记录</Button
        >
        <p v-else-if="item.state !== 'completed'">
          本层由系统清理，不能人工写入完成状态。
        </p>
      </article>
      <div v-if="selectedItem" class="audit-section" aria-label="单项副本核验">
        <p>
          当前核验：{{ categoryLabels[selectedItem.category] || "相关资料" }} ·
          {{
            layerLabels[selectedItem.layer]
          }}。录入不会延长购买时固定的原始期限。
        </p>
        <label
          >受限回执引用<Input
            v-model:value="evidence"
            aria-label="删除单项回执引用"
            :disabled="busy"
            placeholder="record:synthetic-receipt"
        /></label>
        <p>仅填写受限记录引用；原始文件、路径、姓名及私人内容不进入本表单。</p>
        <Button
          :disabled="
            busy || !/^record:synthetic-[-A-Za-z0-9_:]{3,120}$/.test(evidence)
          "
          @click="command('pending')"
          >记录本项仍待核实</Button
        >
        <Button
          :disabled="
            busy || !/^record:synthetic-[-A-Za-z0-9_:]{3,120}$/.test(evidence)
          "
          @click="command('confirmed')"
          >记录本项已核验回执</Button
        >
      </div>
    </template>
  </section>
</template>
<style scoped>
.deletion-care {
  font-size: 20px;
  line-height: 1.7;
  overflow-wrap: anywhere;
}
.deletion-care :deep(button),
.deletion-care :deep(input) {
  min-height: 48px;
  min-width: 48px;
  font-size: 20px;
}
.deletion-care :deep(button) {
  height: auto;
  white-space: normal;
  margin: 8px 8px 8px 0;
}
.deletion-care h4 {
  font-size: 22px;
}
.deletion-care label {
  display: block;
}
</style>
