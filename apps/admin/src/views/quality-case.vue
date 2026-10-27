<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { Alert, Button, Input, FormItem } from "antdv-next";
import type { QualityMaterials, QualityRequestView } from "@timenook/contracts";
import { qualityApi } from "../api/admin";
import {
  qualityReasonLabels as reasonLabels,
  qualityStateLabels as stateLabels,
} from "../../../../miniprogram/services/quality-labels";
import {
  openPdfDocument,
  closePdfDocument,
} from "../../../../preview/pdf-viewer";
const props = defineProps<{ caseId: string; csrf: string }>();
const emit = defineEmits<{
  expired: [];
  changed: [];
  production: [orderId: string];
}>();
const view = ref<QualityRequestView | null>(null),
  materials = ref<QualityMaterials | null>(null),
  busy = ref(false),
  error = ref("");
const dueAt = ref(""),
  evidence = ref("");
const resolution = ref<"reprint" | "refund">("reprint"),
  mode = ref<"original" | "revised">("original");
let intent: { input: string; key: string } | null = null;
async function command(action: "assign" | "review" | "reprints") {
  const source = view.value;
  if (!active || !source || busy.value) return;
  let body: object;
  if (action === "assign") {
    const due = Date.parse(dueAt.value);
    if (!Number.isFinite(due) || !evidence.value.startsWith("synthetic:")) {
      error.value = "请记录按原 D06 核验的截止时间与证据引用。";
      return;
    }
    body = {
      expectedVersion: source.version,
      dueAt: new Date(due).toISOString(),
      evidenceRef: evidence.value,
    };
  } else if (action === "review") {
    if (!evidence.value.startsWith("synthetic:")) {
      error.value = "请记录原 D07 情形及救济的核验证据。";
      return;
    }
    body = {
      expectedVersion: source.version,
      resolution: resolution.value,
      ...(resolution.value === "reprint" ? { mode: mode.value } : {}),
      evidenceRef: evidence.value,
    };
  } else {
    const binding =
      source.reprintMode === "original" ? source.original : source.replacement;
    if (!binding) {
      error.value = "修订书稿尚未完成当前版本的双方确认，不能创建重印。";
      return;
    }
    body = {
      expectedVersion: source.version,
      bookVersionId: binding.bookVersionId,
      snapshotHash: binding.snapshotHash,
      pdfHash: binding.pdfHash,
      addressHash: binding.addressHash,
    };
  }
  const input = JSON.stringify({ caseId: props.caseId, action, body });
  if (intent?.input !== input) intent = { input, key: crypto.randomUUID() };
  const owner = ++generation;
  busy.value = true;
  error.value = "";
  try {
    const saved = await qualityApi.command(
      props.caseId,
      action,
      body,
      intent.key,
      props.csrf,
    );
    if (!active || generation !== owner) return;
    clearMaterials();
    view.value = saved;
    intent = null;
    emit("changed");
  } catch (failure) {
    if (active && generation === owner) handle(failure);
  } finally {
    if (active && generation === owner) busy.value = false;
  }
}
let active = true,
  generation = 0,
  materialGeneration = 0,
  pdfUrl = "";
const pdfSource = ref("");
const pdfOverlay = ref<HTMLElement | null>(null);
let expiry: ReturnType<typeof setTimeout> | undefined,
  watch: ReturnType<typeof setTimeout> | undefined;
function clearMaterials() {
  ++materialGeneration;
  materials.value = null;
  if (expiry) clearTimeout(expiry);
  if (watch) clearTimeout(watch);
  expiry = undefined;
  watch = undefined;
  if (pdfUrl) {
    closePdfDocument(pdfUrl);
    URL.revokeObjectURL(pdfUrl);
  }
  pdfUrl = "";
  pdfSource.value = "";
}
onUnmounted(() => {
  active = false;
  ++generation;
  clearMaterials();
  view.value = null;
});
function current(owner: number, source: QualityRequestView, expires: number) {
  return (
    active &&
    owner === materialGeneration &&
    view.value === source &&
    Number.isFinite(expires) &&
    Date.now() < expires
  );
}
function handle(failure: unknown) {
  const code = (failure as { error?: { code?: string } }).error?.code;
  clearMaterials();
  if (code === "UNAUTHENTICATED") {
    view.value = null;
    emit("expired");
  } else
    error.value =
      code === "FORBIDDEN"
        ? "当前本人授权已失效或未授予，请重新核验。"
        : "操作结果未确认，请重新查询；未知结果保留原意图。";
}
function checkMaterials(
  value: QualityMaterials,
  source: QualityRequestView,
  expires: number,
) {
  const returned = Date.parse(value.grantExpiresAt);
  if (
    !Number.isFinite(returned) ||
    returned <= Date.now() ||
    returned > expires ||
    (value.description !== null &&
      !source.grant?.scopes.includes("evidence")) ||
    (value.pdf !== null &&
      (!source.grant?.scopes.includes("pdf") ||
        value.pdf.sha256 !== source.original.pdfHash))
  )
    throw Error("本次资料与限时授权不一致");
  return returned;
}
function watchMaterials(
  owner: number,
  source: QualityRequestView,
  expires: number,
) {
  watch = setTimeout(
    async () => {
      if (!current(owner, source, expires)) {
        clearMaterials();
        return;
      }
      try {
        const value = await qualityApi.materials(props.caseId, props.csrf);
        if (!current(owner, source, expires)) return;
        checkMaterials(value, source, expires);
        materials.value = value;
        watchMaterials(owner, source, expires);
      } catch (failure) {
        if (current(owner, source, expires)) handle(failure);
      }
    },
    Math.min(1000, Math.max(1, expires - Date.now())),
  );
}
async function loadMaterials() {
  const source = view.value;
  if (!source || busy.value) return;
  clearMaterials();
  const owner = materialGeneration,
    expires = Date.parse(source.grant?.expiresAt || "");
  if (!current(owner, source, expires)) {
    error.value = "请先由本人完成本工单的资料限时授权。";
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const value = await qualityApi.materials(props.caseId, props.csrf);
    if (!current(owner, source, expires)) return;
    const until = checkMaterials(value, source, expires);
    materials.value = value;
    expiry = setTimeout(
      () => {
        if (owner === materialGeneration) clearMaterials();
      },
      Math.max(0, until - Date.now()),
    );
    watchMaterials(owner, source, until);
  } catch (failure) {
    if (current(owner, source, expires)) handle(failure);
  } finally {
    if (active) busy.value = false;
  }
}
async function previewPdf() {
  const source = view.value,
    value = materials.value;
  if (!source || !value?.pdf || busy.value) return;
  const owner = materialGeneration,
    expires = Date.parse(value.grantExpiresAt);
  if (!current(owner, source, expires)) {
    clearMaterials();
    return;
  }
  busy.value = true;
  error.value = "";
  try {
    const bytes = await qualityApi.pdf(props.caseId, props.csrf);
    if (!current(owner, source, expires)) return;
    const digest = Array.from(
      new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)),
    )
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("");
    if (!current(owner, source, expires)) return;
    if (digest !== value.pdf.sha256 || bytes.byteLength !== value.pdf.bytes)
      throw Error("PDF校验不一致");
    if (pdfUrl) URL.revokeObjectURL(pdfUrl);
    pdfUrl = URL.createObjectURL(
      new Blob([bytes], { type: "application/pdf" }),
    );
    pdfSource.value = pdfUrl;
    if (!pdfOverlay.value) throw Error("PDF预览入口不可用");
    await openPdfDocument(
      pdfOverlay.value,
      {
        filePath: pdfUrl,
        fileType: "pdf",
        success: () => {
          if (!current(owner, source, expires)) clearMaterials();
        },
        fail: () => {
          if (current(owner, source, expires))
            error.value = "PDF预览未完成，请重新核验后打开。";
        },
      },
      (path) => {
        URL.revokeObjectURL(path);
        if (pdfUrl === path) {
          pdfUrl = "";
          pdfSource.value = "";
        }
      },
    );
  } catch (failure) {
    if (current(owner, source, expires)) handle(failure);
  } finally {
    if (active) busy.value = false;
  }
}
async function refresh() {
  if (!active || busy.value) return;
  const owner = ++generation;
  busy.value = true;
  error.value = "";
  clearMaterials();
  try {
    const value = await qualityApi.read(props.caseId);
    if (active && generation === owner) view.value = value;
  } catch (failure) {
    if (active && generation === owner) handle(failure);
  } finally {
    if (active && generation === owner) busy.value = false;
  }
}
onMounted(refresh);
</script>
<template>
  <section class="section quality-case" aria-label="质量售后处理">
    <h3>质量核验与原单重印</h3>
    <Alert v-if="error" type="error" :message="error" role="alert" />
    <Button :disabled="busy" @click="refresh">查询原质量工单</Button>
    <div v-if="view">
      <p>{{ reasonLabels[view.reason] }} · {{ stateLabels[view.state] }}</p>
      <p>
        原订单：{{ view.orderId }}；原首本生产单：{{ view.productionOrderId }}
      </p>
      <p>
        原制作第{{ view.original.sequence }}次；书稿第{{
          view.original.bookVersion
        }}版；原交付：{{ view.original.deliveredAt }}
      </p>
      <p>原 PDF hash：{{ view.original.pdfHash }}</p>
      <p v-if="view.original.tracking">
        原物流：{{ view.original.tracking.carrier }} /
        {{ view.original.tracking.number }}
      </p>
      <p>
        处理人：{{ view.ownerLabel || "待领取" }}；实际处理截止：{{
          view.dueAt || "待按原 D06 核验"
        }}
      </p>
      <p>
        质量政策与处理时限以原销售快照为准。当前仅合成验证，真实 D06/D07
        和印厂责任流程仍待冻结。
      </p>
      <FormItem label="质量政策核验证据"
        ><Input
          v-model:value="evidence"
          aria-label="质量政策核验证据"
          placeholder="synthetic:原政策与实际情况核验引用"
          :disabled="busy"
      /></FormItem>
      <div v-if="view.state === 'requested'">
        <label
          >按原 D06 核验的实际处理截止<input
            v-model="dueAt"
            type="datetime-local"
            aria-label="质量处理截止"
            :disabled="busy"
        /></label>
        <Button
          type="primary"
          :disabled="busy || !dueAt || !evidence.startsWith('synthetic:')"
          @click="command('assign')"
          >领取本次质量工单</Button
        >
      </div>
      <div v-if="view.ownerLabel">
        <p>
          本人授权截止：{{ view.grant?.expiresAt || "尚无当前有效授权" }}。PDF
          和问题说明分别授权，不包含地址。
        </p>
        <Button :disabled="busy || !view.grant" @click="loadMaterials"
          >查看本次获授权资料</Button
        >
        <Button v-if="materials" :disabled="busy" @click="clearMaterials"
          >关闭并清理本次资料</Button
        >
        <div v-if="materials" class="section quality-materials">
          <p v-if="materials.description !== null">
            本次质量说明：{{ materials.description }}
          </p>
          <p v-else>本次未授权查看问题说明。</p>
          <Button v-if="materials.pdf" :disabled="busy" @click="previewPdf"
            >校验并临时预览原 PDF</Button
          >
          <div
            ref="pdfOverlay"
            v-show="pdfSource"
            class="quality-pdf"
            aria-label="本次限时质量 PDF"
          />
          <p>预览到期或离开时清理。主动保存的文件副本不能远程收回。</p>
        </div>
      </div>
      <div v-if="view.state === 'assigned'" class="section">
        <label
          >按原 D07 核验的救济<select
            v-model="resolution"
            aria-label="质量处理方案"
            :disabled="busy"
          >
            <option value="reprint">原订单重印</option>
            <option value="refund">原订单质量赔付退款</option>
          </select></label
        >
        <label v-if="resolution === 'reprint'"
          >重印文件<select
            v-model="mode"
            aria-label="重印文件方式"
            :disabled="busy"
          >
            <option value="original">原确定文件</option>
            <option value="revised">修订后重新确认的文件</option>
          </select></label
        >
        <Button
          type="primary"
          :disabled="busy || !evidence.startsWith('synthetic:')"
          @click="command('review')"
          >记录原政策核验方案</Button
        >
      </div>
      <div
        v-if="view.state === 'reviewed' && view.resolution === 'reprint'"
        class="section"
      >
        <p v-if="view.reprintMode === 'original'">
          重用原 PDF，仍须核验当前授权及实际取消/接单状态，不重发未知交接。
        </p>
        <p v-else>
          修订后必须双方重新确认同一份新 PDF；当前{{
            view.replacement ? "已取得合格新版本" : "尚缺合格新版本或双方确认"
          }}。
        </p>
        <Button
          type="primary"
          :disabled="
            busy || (view.reprintMode === 'revised' && !view.replacement)
          "
          @click="command('reprints')"
          >创建原订单重印尝试</Button
        >
      </div>
      <p v-if="view.resolution === 'refund'">
        由付款发起人继续本工单的退款申请，再由原退款流程批准、执行和核实，不手写成功状态。
      </p>
      <p v-if="view.refund">
        已关联原退款：{{ view.refund.id }} ·
        {{ view.refund.state }}。请在同一共享工单列表打开对应退款申请处理。
      </p>
      <Button
        v-if="view.productionAttemptId"
        :disabled="busy"
        @click="emit('production', view.productionOrderId)"
        >继续原单生产与物流</Button
      >
      <p v-if="view.productionAttemptId">
        重印仍沿原首本生产单处理，不新增购买或首本权益，首次交付和 D03
        期限不会重置。
      </p>
    </div>
  </section>
</template>
<style scoped>
.quality-case {
  overflow-wrap: anywhere;
}
.quality-case input,
.quality-case select {
  max-width: 100%;
  min-height: 40px;
}
.quality-case button {
  margin: 6px 8px 6px 0;
  white-space: normal;
}
.quality-pdf {
  display: block;
  width: 100%;
  margin-top: 16px;
  border: 1px solid #d9d9d9;
  box-sizing: border-box;
}
.quality-materials {
  padding: 16px;
  background: #faf7f2;
}
</style>
