<script setup lang="ts">
import {
  formatAdminTime,
  parseAdminTimeInput,
  formatAdminTimeInput,
} from "../utils/time";
import { ref, onMounted, onUnmounted } from "vue";
import { Alert, Button } from "antdv-next";
import type {
  FulfillmentView,
  FulfillmentMaterials,
  FulfillmentState,
  FulfillmentReceiptCommand,
  FulfillmentShippingCommand,
  FulfillmentDeliveryCommand,
} from "@timenook/contracts";
import { fulfillmentApi } from "../api/admin";
const props = defineProps<{
  csrf: string;
  initialOrderId?: string;
  returnPath?: string;
}>();
const emit = defineEmits<{ expired: [] }>();
const rows = ref<FulfillmentView[]>([]),
  selected = ref<FulfillmentView | null>(null),
  busy = ref(false),
  error = ref(""),
  notice = ref(""),
  supplierRef = ref(""),
  dueAt = ref(""),
  materials = ref<FulfillmentMaterials | null>(null);
const evidence = ref(""),
  carrier = ref(""),
  trackingNumber = ref(""),
  shippedAt = ref(""),
  shippingEvidence = ref(""),
  wechatEvidence = ref(""),
  wechatResult = ref<"recorded" | "pending" | "failed">("pending"),
  deliveredAt = ref(""),
  deliveryEvidence = ref(""),
  printedAt = ref(""),
  printingEvidence = ref("");
let generation = 0,
  active = true;
let intent: { input: string; key: string } | null = null;
const labels: Record<FulfillmentState, string> = {
  approved: "已审核，等待交接",
  handoff_pending: "交接结果待核实",
  in_production: "印厂已确认接单",
  shipped: "已发货",
  delivered: "已交付",
  cancellation_pending: "取消待人工核实",
  cancelled: "已确认取消",
};
const recordLabels: Record<string, string> = {
  handoff: "开始交接",
  receipt_accepted: "核实印厂接单",
  receipt_unknown: "结果待核实",
  receipt_cancelled: "确认取消",
  receipt_cancellation_rejected: "核实取消未成功",
  cancel: "请求取消",
  printing_completed: "完成印制",
  shipping: "实际发货",
  wechat: "微信处理结果",
  delivery: "实际交付",
};
let materialsGeneration = 0;
let materialsPollTimer: ReturnType<typeof setTimeout> | undefined;
let pdfUrl = "";
function clearMaterials() {
  ++materialsGeneration;
  if (materialsPollTimer) clearTimeout(materialsPollTimer);
  materialsPollTimer = undefined;
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = "";
  materials.value = null;
}
function validMaterials(
  owner: number,
  view: FulfillmentView,
  materialOwner: number,
) {
  return (
    current(owner) &&
    selected.value === view &&
    materialOwner === materialsGeneration
  );
}
function watchMaterials(
  owner: number,
  view: FulfillmentView,
  materialOwner: number,
) {
  materialsPollTimer = setTimeout(async () => {
    if (!validMaterials(owner, view, materialOwner)) {
      if (
        current(owner) &&
        selected.value === view &&
        materialOwner === materialsGeneration
      )
        clearMaterials();
      return;
    }
    try {
      await fulfillmentApi.materials(
        view.orderId!,
        view.current!.id,
        props.csrf,
      );
      if (validMaterials(owner, view, materialOwner))
        watchMaterials(owner, view, materialOwner);
    } catch {
      if (
        current(owner) &&
        selected.value === view &&
        materialOwner === materialsGeneration
      ) {
        clearMaterials();
        error.value = "本次生产资料访问已变化，请重新核验。";
      }
    }
  }, 1000);
}
async function loadMaterials() {
  const view = selected.value,
    attempt = view?.current;
  if (!view?.orderId || !attempt || busy.value) return;
  await perform(async (owner) => {
    clearMaterials();
    const materialOwner = materialsGeneration;
    const value = await fulfillmentApi.materials(
      view.orderId!,
      attempt.id,
      props.csrf,
    );
    if (!validMaterials(owner, view, materialOwner)) return;
    if (
      value.handoffId !== attempt.handoffId ||
      value.pdf.sha256 !== attempt.pdfHash
    )
      throw new Error("生产资料与本次交接不一致");
    materials.value = value;
    watchMaterials(owner, view, materialOwner);
  });
}
async function downloadPdf() {
  const view = selected.value,
    attempt = view?.current,
    value = materials.value;
  if (!view?.orderId || !attempt || !value || busy.value) return;
  await perform(async (owner) => {
    const materialOwner = materialsGeneration;
    if (!validMaterials(owner, view, materialOwner)) {
      clearMaterials();
      error.value = "本次资料访问已变化，请重新查询。";
      return;
    }
    try {
      const bytes = await fulfillmentApi.pdf(
        view.orderId!,
        attempt.id,
        props.csrf,
      );
      if (!validMaterials(owner, view, materialOwner)) return;
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (!validMaterials(owner, view, materialOwner)) return;
      if (hash !== value.pdf.sha256 || bytes.byteLength !== value.pdf.bytes)
        throw new Error("生产PDF校验未通过");
      pdfUrl = URL.createObjectURL(
        new Blob([bytes], { type: "application/pdf" }),
      );
      const link = document.createElement("a");
      link.href = pdfUrl;
      link.download = `${attempt.handoffId}.pdf`;
      link.click();
      URL.revokeObjectURL(pdfUrl);
      pdfUrl = "";
      notice.value =
        "本次确定 PDF 已下载，文件完整性已核验，请人工核对交接编号和书稿内容。下载副本不会远程回收。";
    } catch (error) {
      if (current(owner) && materialOwner === materialsGeneration)
        clearMaterials();
      throw error;
    }
  });
}
async function downloadAddress() {
  const view = selected.value,
    attempt = view?.current,
    cached = materials.value;
  if (!view?.orderId || !attempt || !cached || busy.value) return;
  await perform(async (owner) => {
    const materialOwner = materialsGeneration;
    const value = await fulfillmentApi.materials(
      view.orderId!,
      attempt.id,
      props.csrf,
    );
    if (!validMaterials(owner, view, materialOwner)) return;
    if (
      value.handoffId !== attempt.handoffId ||
      value.pdf.sha256 !== attempt.pdfHash
    )
      throw new Error("本次资料访问已变化");
    const address = value.address;
    const url = URL.createObjectURL(
      new Blob(
        [
          `交接编号：${value.handoffId}\n收件人：${address.recipientName}\n电话：${address.phone}\n地区：${address.regionCode}\n地址：${address.detail}\n`,
        ],
        { type: "text/plain;charset=utf-8" },
      ),
    );
    const link = document.createElement("a");
    link.href = url;
    link.download = `${attempt.handoffId}-address.txt`;
    link.click();
    URL.revokeObjectURL(url);
    notice.value = "本次配送地址已下载，仅用于本次确定书稿的寄送。";
  });
}
function accept(value: FulfillmentView) {
  selected.value = value;
  rows.value = rows.value.map((row) =>
    row.orderId === value.orderId ? value : row,
  );
}
function current(owner: number) {
  return active && owner === generation;
}
function key(input: unknown) {
  const serialized = JSON.stringify(input);
  if (intent?.input !== serialized)
    intent = { input: serialized, key: crypto.randomUUID() };
  return intent.key;
}
async function perform(work: (owner: number) => Promise<void>) {
  if (busy.value || !active) return;
  const owner = generation;
  busy.value = true;
  error.value = "";
  notice.value = "";
  try {
    await work(owner);
  } catch (failure) {
    if (!current(owner)) return;
    const code = (failure as { error?: { code?: string } }).error?.code;
    if (code === "UNAUTHENTICATED") {
      selected.value = null;
      rows.value = [];
      clearMaterials();
      emit("expired");
    } else {
      if (code === "FORBIDDEN") {
        selected.value = null;
        clearMaterials();
      }
      error.value =
        code === "FORBIDDEN"
          ? "当前授权未生效或已到期，请重新核验。"
          : "操作结果未确认，请重新查询核对；相同意图重试沿用原标识。";
    }
  } finally {
    if (current(owner)) busy.value = false;
  }
}
const refresh = () =>
  props.initialOrderId ? open(props.initialOrderId) : Promise.resolve();
const open = (id: string) =>
  perform(async (owner) => {
    selected.value = null;
    clearMaterials();
    intent = null;
    const value = await fulfillmentApi.read(id);
    if (current(owner)) {
      accept(value);
      supplierRef.value = value.approvedSupplierRef || "";
      dueAt.value = "";
      evidence.value = "";
      carrier.value = value.current?.tracking?.carrier || "";
      trackingNumber.value = value.current?.tracking?.number || "";
      shippedAt.value = formatAdminTimeInput(
        value.current?.tracking?.shippedAt,
      );
      shippingEvidence.value = "";
      wechatEvidence.value = "";
      wechatResult.value = value.current?.wechat?.result || "pending";
      deliveredAt.value = "";
      deliveryEvidence.value = "";
    }
  });
async function approve() {
  const view = selected.value;
  if (!view?.orderId || !view.reservation) return;
  await perform(async (owner) => {
    await fulfillmentApi.approve(
      view.orderId!,
      view.reservation!,
      key({ action: "approve", orderId: view.orderId, ...view.reservation }),
      props.csrf,
    );
    const value = await fulfillmentApi.read(view.orderId!);
    if (current(owner) && selected.value === view) {
      accept(value);
      intent = null;
      notice.value = "审核结果已记录；建立尝试仍会再次核验。";
    }
  });
}
async function createAttempt() {
  const view = selected.value;
  if (
    !view?.orderId ||
    !view.reservation ||
    !view.approvedSupplierRef ||
    (view.current && view.current.state !== "cancelled")
  )
    return;
  const deadline = parseAdminTimeInput(dueAt.value);
  if (
    !view.approvedSupplierRef ||
    !Number.isFinite(deadline) ||
    deadline <= Date.now()
  ) {
    error.value = "请填写印厂引用与未来的本次处理期限。";
    return;
  }
  const input = {
    ...view.reservation,
    supplierRef: view.approvedSupplierRef,
    dueAt: new Date(deadline).toISOString(),
  };
  await perform(async (owner) => {
    const value = await fulfillmentApi.attempt(
      view.orderId!,
      input,
      key({ action: "attempt", orderId: view.orderId, ...input }),
      props.csrf,
    );
    if (current(owner) && selected.value === view) {
      accept(value);
      intent = null;
      clearMaterials();
      notice.value = "本次生产尝试已建立，请由讲述者授权本次资料交接。";
    }
  });
}
async function command(
  action:
    | "handoff"
    | "receipt"
    | "cancel"
    | "printing"
    | "shipping"
    | "wechat"
    | "delivery",
  input:
    | {}
    | FulfillmentReceiptCommand
    | FulfillmentShippingCommand
    | FulfillmentDeliveryCommand,
) {
  const view = selected.value,
    attempt = view?.current;
  if (!view?.orderId || !attempt) return;
  await perform(async (owner) => {
    const value = await fulfillmentApi.command(
      view.orderId!,
      attempt.id,
      action,
      input,
      key({ orderId: view.orderId, attemptId: attempt.id, action, ...input }),
      props.csrf,
    );
    if (current(owner) && selected.value === view) {
      accept(value);
      intent = null;
      clearMaterials();
      notice.value = "本次记录已保存，请按当前阶段继续核对。";
    }
  });
}
function handoff() {
  return command("handoff", {});
}
function receipt(outcome: FulfillmentReceiptCommand["outcome"]) {
  if (!evidence.value.trim()) {
    error.value = "请填写回执或处理证据。";
    return;
  }
  return command("receipt", { outcome, evidenceRef: evidence.value.trim() });
}
function continueProduction() {
  if (selected.value?.current?.state !== "cancellation_pending") return;
  return receipt("cancellation_rejected");
}
function cancel() {
  if (!evidence.value.trim()) {
    error.value = "请填写回执或处理证据。";
    return;
  }
  return command("cancel", { evidenceRef: evidence.value.trim() });
}
function saveShipping() {
  const shipped = parseAdminTimeInput(shippedAt.value);
  if (
    !carrier.value.trim() ||
    !trackingNumber.value.trim() ||
    !Number.isFinite(shipped) ||
    !shippingEvidence.value.trim()
  ) {
    error.value = "请填写物流公司、单号、发货时间和物流证据。";
    return;
  }
  return command("shipping", {
    carrier: carrier.value.trim(),
    number: trackingNumber.value.trim(),
    shippedAt: new Date(shipped).toISOString(),
    evidenceRef: shippingEvidence.value.trim(),
  });
}
function completePrinting() {
  const at = parseAdminTimeInput(printedAt.value);
  if (!Number.isFinite(at) || !printingEvidence.value.trim()) {
    error.value = "请填写实际完成印制时间和核实证据。";
    return;
  }
  return command("printing", {
    printedAt: new Date(at).toISOString(),
    evidenceRef: printingEvidence.value.trim(),
  });
}
function saveWechat() {
  if (!wechatEvidence.value.trim()) {
    error.value = "请填写微信平台处理证据。";
    return;
  }
  return command("wechat", {
    evidenceRef: wechatEvidence.value.trim(),
    result: wechatResult.value,
  });
}
function deliver() {
  const delivered = parseAdminTimeInput(deliveredAt.value);
  if (!Number.isFinite(delivered) || !deliveryEvidence.value.trim()) {
    error.value = "请填写交付时间与交付证据。";
    return;
  }
  return command("delivery", {
    deliveredAt: new Date(delivered).toISOString(),
    evidenceRef: deliveryEvidence.value.trim(),
  });
}
onMounted(async () => {
  if (props.initialOrderId) await open(props.initialOrderId);
});
onUnmounted(() => {
  active = false;
  ++generation;
  selected.value = null;
  rows.value = [];
  busy.value = false;
  intent = null;
  clearMaterials();
});
</script>
<template>
  <section class="catalog-page fulfillment-page">
    <div class="page-title">
      <div>
        <h2>生产与物流</h2>
        <p>人工核对回执、完成印制和物流，按确定版本交接。</p>
      </div>
      <Button :disabled="busy" @click="refresh">重新查询生产单</Button>
    </div>
    <Alert
      v-if="error"
      type="error"
      :message="error"
      role="alert"
      class="notice"
    />
    <Alert
      v-if="notice"
      type="success"
      :message="notice"
      role="status"
      class="notice"
    />
    <section v-if="selected" class="catalog-card">
      <h2>当前生产记录</h2>
      <p>生产单：{{ selected.orderId }}</p>
      <p>项目：{{ selected.projectId }}</p>
      <div class="catalog-actions">
        <RouterLink
          v-if="selected.paymentOrderId"
          :to="{
            path: `/orders/${selected.paymentOrderId}`,
            query: { from: props.returnPath ?? '/production' },
          }"
          ><Button>查看原订单</Button></RouterLink
        >
        <RouterLink
          :to="{
            path: `/users/projects/${selected.projectId}`,
            query: { from: props.returnPath ?? '/production' },
          }"
          ><Button>查看用户项目与服务</Button></RouterLink
        >
      </div>
      <p>制作服务长期有效 · 当前状态：{{ selected.creation.state }}</p>
      <div
        v-if="!selected.current || selected.current.state === 'cancelled'"
        class="production-form"
      >
        <Button :disabled="busy" @click="approve">审核当前首本制作</Button
        ><label
          >印厂引用<input
            v-model="supplierRef"
            disabled
            placeholder="原订单印厂准入尚未冻结" /></label
        ><label
          >本次处理期限<input
            v-model="dueAt"
            type="datetime-local"
            title="北京时间（UTC+8）"
            :disabled="busy"
        /></label>
        <p>日期与时间均按北京时间（UTC+8）显示和填写。</p>
        <p>请按购买时约定的人工时限与适用日历填写本次期限。</p>
        <p>
          印厂仅使用原订单已核验的供应商引用，不能在交接时另选未经准入的供应商。
        </p>
        <Button
          :disabled="busy || !selected.approvedSupplierRef"
          @click="createAttempt"
          >建立生产尝试</Button
        >
      </div>
      <div v-if="selected.current" class="section">
        <h2>
          {{
            selected.current.state === "in_production" &&
            selected.current.printedAt
              ? "已生产"
              : labels[selected.current.state]
          }}
        </h2>
        <p v-if="selected.current.printedAt">
          完成印制：{{ formatAdminTime(selected.current.printedAt) }} ·
          操作人：{{ selected.current.printedBy }}
        </p>
        <p>交接编号：{{ selected.current.handoffId }}</p>
        <p>
          第 {{ selected.current.sequence }} 次尝试 · 处理期限：{{
            formatAdminTime(selected.current.dueAt)
          }}
        </p>
        <p>
          工单：{{ selected.current.caseId }} · 负责人：{{
            selected.current.ownerAdminId
          }}
        </p>
        <p>{{ selected.current.cancellationNotice }}</p>
        <div class="catalog-actions">
          <Button
            :disabled="busy || selected.current.state !== 'approved'"
            @click="loadMaterials"
            >查看本次生产资料</Button
          ><Button :disabled="busy || !materials" @click="downloadPdf"
            >下载本次生产 PDF</Button
          ><Button :disabled="busy || !materials" @click="downloadAddress"
            >下载本次配送地址</Button
          >
        </div>
        <div v-if="materials" class="production-materials">
          <p>本次生产 PDF：{{ materials.pdf.sha256 }}</p>
          <p>交接编号：{{ materials.handoffId }}</p>
          <p>仅供负责本次交接的运营人员办理印刷与寄送。</p>
          <p>
            收件人：{{ materials.address.recipientName }} ·
            {{ materials.address.phone }}
          </p>
          <p>
            配送：{{ materials.address.regionCode }}
            {{ materials.address.detail }}
          </p>
        </div>
        <div
          v-if="selected.current.state === 'approved'"
          class="production-form"
        >
          <p>
            先下载并人工核对本次
            PDF、地址和交接编号，再记录开始交接。记录后结果保持待核实，不允许新交接或释放权益。
          </p>
          <Button :disabled="busy" @click="handoff">记录人工交接已开始</Button>
        </div>
        <div
          v-if="
            [
              'approved',
              'handoff_pending',
              'cancellation_pending',
              'in_production',
              'shipped',
            ].includes(selected.current.state)
          "
          class="production-form"
        >
          <label
            >回执或处理证据<input
              v-model="evidence"
              :disabled="busy"
              placeholder="record:独立核对回执引用"
          /></label>
          <div class="catalog-actions">
            <Button
              v-if="
                ['handoff_pending', 'cancellation_pending'].includes(
                  selected.current.state,
                )
              "
              :disabled="busy"
              @click="receipt('unknown')"
              >记录接单结果待核实</Button
            >
            <Button
              v-if="
                ['handoff_pending', 'cancellation_pending'].includes(
                  selected.current.state,
                )
              "
              :disabled="busy"
              @click="receipt('accepted')"
              >记录印厂确认接单</Button
            >
            <Button
              v-if="selected.current.state !== 'cancellation_pending'"
              :disabled="busy"
              @click="cancel"
              >请求取消本次生产</Button
            >
            <Button
              v-if="selected.current.state === 'cancellation_pending'"
              :disabled="busy"
              @click="receipt('cancelled')"
              >记录印厂确认取消</Button
            >
            <Button
              v-if="selected.current.state === 'cancellation_pending'"
              :disabled="busy"
              @click="continueProduction"
              >核实取消未成功，继续实际履约</Button
            >
          </div>
          <p>
            交接中的取消必须等待人工核验印厂回执，不承诺自动撤销文件副本或实物制作。
            核实取消未成功后，沿同次生产和原物流继续，不释放首本权益或新建交接。
          </p>
        </div>
        <div
          v-if="
            selected.current.state === 'in_production' &&
            !selected.current.printedAt
          "
          class="production-form"
        >
          <h2>实际完成印制</h2>
          <p>印厂接单仅表示开始制作；核实实体书完成印制后登记已生产。</p>
          <label
            >完成印制时间<input
              v-model="printedAt"
              type="datetime-local"
              title="北京时间（UTC+8）"
              step="0.001"
              :disabled="busy"
          /></label>
          <label
            >完成印制证据<input
              v-model="printingEvidence"
              :disabled="busy"
              placeholder="record:印厂完成印制回执"
          /></label>
          <Button :disabled="busy" @click="completePrinting"
            >记录完成印制</Button
          >
        </div>
        <div
          v-if="
            ['in_production', 'shipped', 'delivered'].includes(
              selected.current.state,
            )
          "
          class="production-form"
        >
          <h2>实际发货</h2>
          <p>按实际物流登记。微信平台处理结果独立记录。</p>
          <label
            >物流公司<input
              v-model="carrier"
              :disabled="busy || !!selected.current.tracking"
          /></label>
          <label
            >物流单号<input
              v-model="trackingNumber"
              :disabled="busy || !!selected.current.tracking"
          /></label>
          <label
            >发货时间<input
              v-model="shippedAt"
              type="datetime-local"
              title="北京时间（UTC+8）"
              step="0.001"
              :disabled="busy || !!selected.current.tracking"
          /></label>
          <label
            >物流证据<input
              v-model="shippingEvidence"
              :disabled="busy"
              placeholder="record:物流回执"
          /></label>
          <Button
            :disabled="
              busy || !selected.current.printedAt || !!selected.current.tracking
            "
            @click="saveShipping"
            >保存实际发货记录</Button
          >
        </div>
        <div v-if="selected.current.tracking" class="production-form">
          <h2>微信发货处理</h2>
          <label
            >微信发货证据<input
              v-model="wechatEvidence"
              :disabled="busy"
              placeholder="record:平台处理证据"
          /></label>
          <label
            >微信发货处理结果<select
              v-model="wechatResult"
              aria-label="微信发货处理结果"
              :disabled="busy"
            >
              <option value="pending">待核实</option>
              <option value="recorded">已核实记录</option>
              <option value="failed">处理失败</option>
            </select></label
          >
          <Button :disabled="busy" @click="saveWechat">保存微信处理结果</Button>
        </div>
        <div v-if="selected.current.tracking" class="section">
          <p>
            物流：{{ selected.current.tracking.carrier }} ·
            {{ selected.current.tracking.number }}
          </p>
          <p>
            发货：{{ formatAdminTime(selected.current.tracking.shippedAt) }}
          </p>
          <p>
            微信发货记录：{{
              selected.current.wechat
                ? {
                    pending: "待核实",
                    failed: "处理失败",
                    recorded: "已核实记录",
                  }[selected.current.wechat.result]
                : "尚未记录"
            }}
          </p>
        </div>
        <div
          v-if="selected.current.state === 'shipped'"
          class="production-form"
        >
          <label
            >交付时间<input
              v-model="deliveredAt"
              type="datetime-local"
              title="北京时间（UTC+8）"
              step="0.001"
              :disabled="busy"
          /></label>
          <label
            >交付证据<input
              v-model="deliveryEvidence"
              :disabled="busy"
              placeholder="record:交付回执"
          /></label>
          <Button :disabled="busy" @click="deliver">记录交付完成</Button>
          <p>交付事实只记录一次，资料服务长期有效。</p>
        </div>
        <p v-if="selected.current.deliveredAt" class="section">
          交付完成：{{ formatAdminTime(selected.current.deliveredAt) }}
        </p>
      </div>
      <section class="section">
        <h2>各次制作记录</h2>
        <div
          v-for="attempt in selected.attempts"
          :key="attempt.id"
          class="production-row"
        >
          <p>
            第 {{ attempt.sequence }} 次 · {{ labels[attempt.state] }} ·
            交接编号 {{ attempt.handoffId }}
          </p>
          <p>
            PDF 版本 {{ attempt.bookVersionId }} · 印厂
            {{ attempt.supplierRef }}
          </p>
          <p v-if="attempt.printedAt">
            完成印制：{{ formatAdminTime(attempt.printedAt) }} · 操作人：{{
              attempt.printedBy
            }}
          </p>
          <p v-for="(record, index) in attempt.records" :key="index">
            {{ recordLabels[record.kind] || record.kind }} ·
            {{ formatAdminTime(record.createdAt) }} · 操作人：{{
              record.operatorAdminId
            }}
          </p>
        </div>
      </section>
    </section>
  </section>
</template>
