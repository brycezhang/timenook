<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Alert, Button, Input } from "antdv-next";
import type { CareCase, CompleteExportView } from "@timenook/contracts";
import { completeExportApi } from "../api/admin";
const props = defineProps<{ care: CareCase; csrf: string }>();
const emit = defineEmits<{ expired: [] }>();
const value = ref<CompleteExportView | null>(null),
  error = ref(""),
  busy = ref(false),
  dueAt = ref(""),
  evidence = ref(""),
  recipientRef = ref("");
const verificationRef = ref(""),
  identityVerified = ref(false),
  subjectConsented = ref(false);
const contentBlocked = computed(
  () => value.value?.missingReason === "EXPORT_CURRENT_AUTHORIZATION_REQUIRED",
);
let generation = 0,
  intent: { input: string; key: string; body?: object } | null = null;
const stateLabel: Record<string, string> = {
  requested: "待核验",
  accepted: "已受理，等待打包",
  packing: "正在打包",
  ready: "已完成，接收人可领取",
  failed: "未完成，须核对缺失原因",
  revoked: "授权变化，须重新核验",
  delivered: "替代渠道交付已留证",
};
async function perform(
  work: (id: string, generation: number) => Promise<void>,
) {
  if (busy.value) return;
  const id = props.care.id,
    g = ++generation;
  busy.value = true;
  error.value = "";
  try {
    await work(id, g);
  } catch (failure) {
    if (id !== props.care.id || g !== generation) return;
    const code = (failure as { error?: { code?: string } }).error?.code;
    if (code === "UNAUTHENTICATED") {
      value.value = null;
      emit("expired");
    } else
      error.value =
        code === "FORBIDDEN"
          ? "本工单或当前本人授权已变化，请重新核验。"
          : "处理未完成，请核对资料、范围及原申请后重试。";
  } finally {
    if (id === props.care.id && g === generation) busy.value = false;
  }
}
const refresh = () =>
  perform(async (id, g) => {
    const row = await completeExportApi.read(id);
    if (id === props.care.id && g === generation) value.value = row;
  });
watch(
  () => [props.care.id, props.care.state],
  () => {
    ++generation;
    busy.value = false;
    value.value = null;
    error.value = "";
    intent = null;
    evidence.value = "";
    recipientRef.value = "";
    dueAt.value = "";
    verificationRef.value = "";
    identityVerified.value = false;
    subjectConsented.value = false;
    if (props.care.state !== "open") void refresh();
  },
  { immediate: true },
);
async function command(action: "accept" | "pack" | "delivery") {
  const body =
    action === "pack"
      ? {}
      : action === "delivery"
        ? { evidenceRef: evidence.value }
        : {
            dueAt: new Date(dueAt.value).toISOString(),
            evidenceRef: evidence.value,
            ...(!value.value ? { recipientRef: recipientRef.value } : {}),
          };
  await perform(async (id, g) => {
    const input = JSON.stringify({ id, action, body });
    if (intent?.input !== input) intent = { input, key: crypto.randomUUID() };
    const row = await completeExportApi.command(
      id,
      action,
      body,
      intent.key,
      props.csrf,
    );
    if (id !== props.care.id || g !== generation) return;
    const current = await completeExportApi.read(id);
    if (id !== props.care.id || g !== generation) return;
    value.value = current;
    intent = null;
  });
}
async function verifyAccess() {
  const row = value.value,
    scope = row?.staffAccess;
  if (
    !scope ||
    !identityVerified.value ||
    !subjectConsented.value ||
    !recipientRef.value ||
    !/^record:synthetic-[-A-Za-z0-9_:]{3,120}$/.test(verificationRef.value)
  )
    return;
  await perform(async (id, g) => {
    // Freeze the selected human verification and deadline before the request.
    const selection = JSON.stringify({
      id,
      recipient: recipientRef.value,
      verification: verificationRef.value,
    });
    if (intent?.input !== selection)
      intent = {
        input: selection,
        key: crypto.randomUUID(),
        body: {
          expectedBindingVersion: scope.bindingVersion,
          expectedAccessEpoch: scope.accessEpoch,
          purpose: "complete_export_delivery",
          noticeVersion: "synthetic-d08-v1",
          identityVerified: true,
          subjectConsented: true,
          identityProcedureRef: scope.identityProcedureRef,
          confirmationChannelRef: scope.confirmationChannelRef,
          recipientRef: recipientRef.value,
          verificationRef: verificationRef.value,
          expiresAt: new Date(Date.now() + 15 * 60000).toISOString(),
        },
      };
    await completeExportApi.verifyAccess(
      id,
      intent.body!,
      intent.key,
      props.csrf,
    );
    if (id !== props.care.id || g !== generation) return;
    const current = await completeExportApi.read(id);
    if (id !== props.care.id || g !== generation) return;
    value.value = current;
    intent = null;
    identityVerified.value = false;
    subjectConsented.value = false;
    verificationRef.value = "";
  });
}
async function download() {
  await perform(async (id, g) => {
    const before = await completeExportApi.read(id);
    if (
      !before?.staffAccess?.available ||
      !before.staffAccess.expiresAt ||
      Date.parse(before.staffAccess.expiresAt) <= Date.now()
    )
      throw { error: { code: "FORBIDDEN" } };
    if (id !== props.care.id || g !== generation) return;
    const bytes = await completeExportApi.download(id);
    if (id !== props.care.id || g !== generation) return;
    const current = await completeExportApi.read(id);
    if (
      id !== props.care.id ||
      g !== generation ||
      !current?.staffAccess?.available ||
      current.staffAccess.id !== before.staffAccess.id ||
      current.sha256 !== before.sha256 ||
      !current.staffAccess.expiresAt ||
      Date.parse(current.staffAccess.expiresAt) <= Date.now()
    )
      return;
    const url = URL.createObjectURL(
        new Blob([bytes], { type: "application/zip" }),
      ),
      link = document.createElement("a");
    link.href = url;
    link.download = "岁月成书-完整资料.zip";
    link.click();
    URL.revokeObjectURL(url);
  });
}
</script>
<template>
  <section class="section export-care">
    <h3>完整资料导出</h3>
    <Alert v-if="error" type="error" :message="error" role="alert" />
    <p>
      先核验本人和本次完整范围；只有本工单核验客服可处理。金额已包含，不能默认把无微信讲述者的资料交给付款人。
    </p>
    <p v-if="care.state === 'open'">请先完成本工单本人及范围核验。</p>
    <template v-else
      ><Button :disabled="busy" @click="refresh">查询导出进展</Button
      ><template v-if="value"
        ><p>
          状态：{{
            contentBlocked
              ? "当前本人授权不可用，请重新核验"
              : stateLabel[value.state]
          }}
        </p>
        <p>
          接收方式：{{
            value.recipient === "verified_alternative"
              ? "按本人核验的替代交付渠道"
              : value.recipient === "self"
                ? "本人领取"
                : "本人明确授权发起人领取"
          }}
        </p>
        <p v-if="value.ownerId">处理人：{{ value.ownerId }}</p>
        <p v-if="value.dueAt">处理截止：{{ value.dueAt }}</p>
        <p>已完成的资料包长期有效，可依当前授权领取。</p>
        <p v-if="value.missingReason">
          缺失或待处理原因：{{ value.missingReason }}
        </p>
        <p v-if="value.sha256" class="export-hash">
          ZIP SHA256：{{ value.sha256 }}
        </p></template
      >
      <div v-if="!value || value.state === 'requested'" class="section">
        <label
          >按原订单工作日历核算的处理截止<input
            v-model="dueAt"
            type="datetime-local"
            aria-label="导出处理截止"
            :disabled="busy" /></label
        ><label
          >本次核验及处理证据<Input
            v-model:value="evidence"
            aria-label="导出核验证据"
            :disabled="busy" /></label
        ><label v-if="!value"
          >无微信本人核验的具体接收人及渠道引用<Input
            v-model:value="recipientRef"
            aria-label="导出替代接收人"
            :disabled="busy" /></label
        ><Button
          :disabled="
            busy ||
            !dueAt ||
            !evidence.startsWith('synthetic:') ||
            (!value && !recipientRef.startsWith('synthetic:'))
          "
          @click="command('accept')"
          >核验范围与接收人并受理</Button
        >
      </div>
      <Button
        v-if="value && ['accepted', 'failed', 'packing'].includes(value.state)"
        :disabled="busy || contentBlocked"
        @click="command('pack')"
        >打包并核对完整 ZIP</Button
      ><template
        v-if="
          value &&
          value.recipient === 'verified_alternative' &&
          ['ready', 'delivered'].includes(value.state)
        "
        ><p>
          客服私人资料授权截止：{{
            value.staffAccess?.expiresAt || "尚无本次授权"
          }}。资料包本身长期有效。
        </p>
        <details class="section">
          <summary>记录新的本人核验与客服领取授权</summary>
          <p>
            仅无微信替代交付。本工单原核验客服须重新核验本人身份、具体接收人和渠道，并告知本次完整资料交付用途与15分钟权限；登录和历史工单不能代替本次核验。
          </p>
          <p>
            身份核验流程：{{
              value.staffAccess?.identityProcedureRef
            }}；本人确认渠道：{{ value.staffAccess?.confirmationChannelRef }}
          </p>
          <label
            >具体接收人及渠道引用<Input
              v-model:value="recipientRef"
              aria-label="临时领取接收人"
              :disabled="busy"
          /></label>
          <label
            >本次受控核验记录引用<Input
              v-model:value="verificationRef"
              aria-label="临时领取核验记录"
              :disabled="busy"
          /></label>
          <label
            ><input
              v-model="identityVerified"
              type="checkbox"
              :disabled="busy"
            />已按指定流程重新核验本人身份</label
          >
          <label
            ><input
              v-model="subjectConsented"
              type="checkbox"
              :disabled="busy"
            />已告知用途、接收范围、15分钟权限并取得本人本次明确同意</label
          >
          <Button
            :disabled="
              busy ||
              !identityVerified ||
              !subjectConsented ||
              !verificationRef ||
              !recipientRef
            "
            @click="verifyAccess"
            >记录本人核验并取得临时领取权限</Button
          >
        </details>
        <Button
          :disabled="busy || contentBlocked || !value.staffAccess?.available"
          @click="download"
          >按核验渠道领取资料包</Button
        ><label
          >实际交付回执引用<Input
            v-model:value="evidence"
            aria-label="导出交付回执"
            :disabled="busy" /></label
        ><Button
          :disabled="
            busy || contentBlocked || !evidence.startsWith('synthetic:')
          "
          @click="command('delivery')"
          >记录替代渠道实际交付回执</Button
        ></template
      >
      <p>
        ZIP 含原声、原始转录、指定版本确认稿、照片、可交付 PDF、manifest
        和可读说明。缺失或 hash
        不符不会标为可领取。资料包期限从首次完成起算，重试不延长；资料原件保留与删除另行处理。
      </p></template
    >
  </section>
</template>
<style scoped>
.export-care label {
  display: block;
  margin: 16px 0;
}
.export-care input {
  display: block;
  max-width: 100%;
}
.export-hash {
  overflow-wrap: anywhere;
}
</style>
