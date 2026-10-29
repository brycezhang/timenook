<script setup lang="ts">
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
const props = defineProps<{ csrf: string; initialOrderId?: string }>();
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
  deliveryEvidence = ref("");
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
let materialsGeneration = 0;
let materialsTimer: ReturnType<typeof setTimeout> | undefined;
let pdfUrl = "";
function clearMaterials() {
  ++materialsGeneration;
  if (materialsTimer) clearTimeout(materialsTimer);
  materialsTimer = undefined;
  if (pdfUrl) URL.revokeObjectURL(pdfUrl);
  pdfUrl = "";
  materials.value = null;
}
function validMaterials(
  owner: number,
  view: FulfillmentView,
  materialOwner: number,
  expires: number,
) {
  return (
    current(owner) &&
    selected.value === view &&
    materialOwner === materialsGeneration &&
    Number.isFinite(expires) &&
    Date.now() < expires
  );
}
async function loadMaterials() {
  const view = selected.value,
    attempt = view?.current;
  if (!view?.orderId || !attempt || busy.value) return;
  await perform(async (owner) => {
    clearMaterials();
    const materialOwner = materialsGeneration,
      expires = Date.parse(attempt.grantExpiresAt || "");
    if (!validMaterials(owner, view, materialOwner, expires)) {
      error.value = "请先由讲述者完成当前有效的本次资料限时授权。";
      return;
    }
    const value = await fulfillmentApi.materials(
      view.orderId!,
      attempt.id,
      props.csrf,
    );
    if (!validMaterials(owner, view, materialOwner, expires)) return;
    const returnedExpiry = Date.parse(value.grantExpiresAt);
    if (
      !Number.isFinite(returnedExpiry) ||
      returnedExpiry <= Date.now() ||
      returnedExpiry > expires ||
      value.handoffId !== attempt.handoffId ||
      value.pdf.sha256 !== attempt.pdfHash
    )
      throw new Error("生产资料与本次授权不一致");
    materials.value = value;
    materialsTimer = setTimeout(
      () => {
        if (
          current(owner) &&
          selected.value === view &&
          materialOwner === materialsGeneration
        )
          clearMaterials();
      },
      Math.min(2147483647, Math.max(0, returnedExpiry - Date.now())),
    );
  });
}
async function downloadPdf() {
  const view = selected.value,
    attempt = view?.current,
    value = materials.value;
  if (!view?.orderId || !attempt || !value || busy.value) return;
  await perform(async (owner) => {
    const materialOwner = materialsGeneration,
      expires = Date.parse(value.grantExpiresAt);
    if (!validMaterials(owner, view, materialOwner, expires)) {
      clearMaterials();
      error.value = "本次资料授权已到期，请重新查询。";
      return;
    }
    try {
      const bytes = await fulfillmentApi.pdf(
        view.orderId!,
        attempt.id,
        props.csrf,
      );
      if (!validMaterials(owner, view, materialOwner, expires)) return;
      const hash = Array.from(
        new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
      )
        .map((b) => b.toString(16).padStart(2, "0"))
        .join("");
      if (!validMaterials(owner, view, materialOwner, expires)) return;
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
        "本次确定 PDF 已下载，请人工核对交接编号和文件 hash。下载副本不会远程回收。";
    } finally {
      if (
        current(owner) &&
        materialOwner === materialsGeneration &&
        Date.now() >= expires
      )
        clearMaterials();
    }
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
function localTime(value: string | null | undefined) {
  if (!value) return "";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "";
  return new Date(date.getTime() - date.getTimezoneOffset() * 60000)
    .toISOString()
    .slice(0, -1);
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
  perform(async (owner) => {
    selected.value = null;
    clearMaterials();
    intent = null;
    const values = await fulfillmentApi.list();
    if (current(owner)) rows.value = values;
  });
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
      shippedAt.value = localTime(value.current?.tracking?.shippedAt);
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
  const deadline = Date.parse(dueAt.value);
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
  action: "handoff" | "receipt" | "cancel" | "shipping" | "delivery",
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
  const shipped = Date.parse(shippedAt.value);
  if (
    !carrier.value.trim() ||
    !trackingNumber.value.trim() ||
    !Number.isFinite(shipped) ||
    !shippingEvidence.value.trim() ||
    !wechatEvidence.value.trim()
  ) {
    error.value = "请填写物流公司、单号、发货时间、物流证据和微信发货证据。";
    return;
  }
  return command("shipping", {
    carrier: carrier.value.trim(),
    number: trackingNumber.value.trim(),
    shippedAt: new Date(shipped).toISOString(),
    evidenceRef: shippingEvidence.value.trim(),
    wechat: {
      handling: "implemented_and_verified",
      evidenceRef: wechatEvidence.value.trim(),
      result: wechatResult.value,
    },
  });
}
function deliver() {
  const delivered = Date.parse(deliveredAt.value);
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
  await refresh();
  if (active && props.initialOrderId) await open(props.initialOrderId);
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
        <h1>生产与物流</h1>
        <p>人工核对回执与物流，按确定版本交接。当前为隔离合成验证。</p>
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
    <section class="catalog-card">
      <h2>首本生产单</h2>
      <p v-if="!rows.length">当前没有可查询的首本生产单。</p>
      <div
        v-for="row in rows"
        :key="row.orderId || row.projectId"
        class="production-row"
      >
        <p>
          生产单：{{ row.orderId }} ·
          {{ row.current ? labels[row.current.state] : "等待审核与安排" }}
        </p>
        <Button :disabled="busy || !row.orderId" @click="open(row.orderId!)"
          >查看此生产单</Button
        >
      </div>
    </section>
    <section v-if="selected" class="catalog-card">
      <h2>当前生产记录</h2>
      <p>生产单：{{ selected.orderId }}</p>
      <p>项目：{{ selected.projectId }}</p>
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
            :disabled="busy"
        /></label>
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
        <h2>{{ labels[selected.current.state] }}</h2>
        <p>交接编号：{{ selected.current.handoffId }}</p>
        <p>
          第 {{ selected.current.sequence }} 次尝试 · 处理期限：{{
            selected.current.dueAt
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
            >查看限时生产资料</Button
          ><Button :disabled="busy || !materials" @click="downloadPdf"
            >下载本次生产 PDF</Button
          >
        </div>
        <div v-if="materials" class="production-materials">
          <p>本次生产 PDF：{{ materials.pdf.sha256 }}</p>
          <p>交接编号：{{ materials.handoffId }}</p>
          <p>授权截止：{{ materials.grantExpiresAt }}</p>
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
              placeholder="synthetic:独立核对回执引用"
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
            ['in_production', 'shipped', 'delivered'].includes(
              selected.current.state,
            )
          "
          class="production-form"
        >
          <h2>物流与微信发货</h2>
          <p>
            按原订单冻结的微信发货路径执行并记录结果；物流发货不代表平台核验成功。
          </p>
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
              step="0.001"
              :disabled="busy || !!selected.current.tracking"
          /></label>
          <label
            >物流证据<input
              v-model="shippingEvidence"
              :disabled="busy"
              placeholder="synthetic:物流回执"
          /></label>
          <label
            >微信发货证据<input
              v-model="wechatEvidence"
              :disabled="busy"
              placeholder="synthetic:平台处理证据"
          /></label>
          <label
            >微信发货处理结果<select v-model="wechatResult" :disabled="busy">
              <option value="pending">待核实</option>
              <option value="recorded">已核实记录</option>
              <option value="failed">处理失败</option>
            </select></label
          >
          <Button :disabled="busy" @click="saveShipping"
            >保存物流与微信发货记录</Button
          >
        </div>
        <div v-if="selected.current.tracking" class="section">
          <p>
            物流：{{ selected.current.tracking.carrier }} ·
            {{ selected.current.tracking.number }}
          </p>
          <p>发货：{{ selected.current.tracking.shippedAt }}</p>
          <p>
            微信发货记录：{{ selected.current.wechat?.result || "尚未记录" }}
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
              step="0.001"
              :disabled="busy"
          /></label>
          <label
            >交付证据<input
              v-model="deliveryEvidence"
              :disabled="busy"
              placeholder="synthetic:交付回执"
          /></label>
          <Button :disabled="busy" @click="deliver">记录交付完成</Button>
          <p>交付事实只记录一次，资料服务长期有效。</p>
        </div>
        <p v-if="selected.current.deliveredAt" class="section">
          交付完成：{{ selected.current.deliveredAt }}
        </p>
      </div>
    </section>
  </section>
</template>
