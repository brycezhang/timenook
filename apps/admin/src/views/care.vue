<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { Alert, Button, Form, FormItem, Input } from "antdv-next";
import type { CareCase, StoryView } from "@timenook/contracts";
import { careApi } from "../api/admin";
import CompleteExport from "./complete-export.vue";
import RefundCase from "./refund-case.vue";
import DeletionCase from "./deletion-case.vue";
import QualityCase from "./quality-case.vue";
const correction = ref<StoryView | null>(null),
  correctionTitle = ref(""),
  correctionParagraphs = ref<{ text: string; sourceRefs: string[] }[]>([]),
  reviewReasons = ref<{ item: string; reason: string }[]>([]);
let correctionTimer: ReturnType<typeof setTimeout> | undefined;
let correctionGeneration = 0;
let intent: { input: string; key: string } | null = null;
function clearCorrection() {
  ++correctionGeneration;
  if (correctionTimer) clearTimeout(correctionTimer);
  correctionTimer = undefined;
  correction.value = null;
  correctionTitle.value = "";
  correctionParagraphs.value = [];
  reviewReasons.value = [];
  intent = null;
}
onUnmounted(clearCorrection);
const props = defineProps<{ csrf: string }>();
const emit = defineEmits<{ expired: []; production: [orderId: string] }>();
const cases = ref<CareCase[]>([]),
  selected = ref<CareCase | null>(null),
  busy = ref(false),
  error = ref(""),
  evidence = ref("");
const intakeProject = ref(""),
  intakeKind = ref<"withdraw" | "export" | "delete">("withdraw"),
  intakeVersion = ref(0),
  intakePurpose = ref<"all" | "collection" | "ai" | "sharing">("all"),
  notice = ref("");
const kindLabel = (kind: string) =>
  kind === "quality"
    ? "质量售后申请"
    : kind === "refund"
      ? "退款申请"
      : kind === "production_handoff"
        ? "生产交接核验"
        : kind === "first_copy_expiry"
          ? "制作期限人工审核"
          : kind === "correction"
            ? "故事限时校对"
            : kind === "rebind"
              ? "账号换绑"
              : kind === "withdraw"
                ? "本人撤回申请"
                : kind === "export"
                  ? "本人资料导出申请"
                  : "本人删除申请";
function currentCorrection(
  care: CareCase,
  generation: number,
  expires: number,
) {
  return (
    selected.value === care &&
    correctionGeneration === generation &&
    Number.isFinite(expires) &&
    Date.now() < expires
  );
}
async function perform(work: () => Promise<void>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await work();
  } catch (failure) {
    const code = (failure as { error?: { code?: string } }).error?.code;
    if (code === "UNAUTHENTICATED") {
      clearCorrection();
      selected.value = null;
      cases.value = [];
      emit("expired");
    } else {
      if (code === "FORBIDDEN") clearCorrection();
      error.value =
        code === "CONFLICT"
          ? "绑定或工单已变化，请重新查询后核验。"
          : code === "FORBIDDEN"
            ? "当前工单内容授权已失效或未授予，请重新核验。"
            : "操作未确认，请核对工单与证据后重试；相同意图保留原请求。";
    }
  } finally {
    busy.value = false;
  }
}
const refresh = () =>
  perform(async () => {
    cases.value = (await careApi.list()).requests;
  });
const open = (id: string) =>
  perform(async () => {
    clearCorrection();
    selected.value = null;
    evidence.value = "";
    intent = null;
    selected.value = await careApi.read(id);
  });
async function loadCorrection() {
  const care = selected.value;
  if (!care) return;
  await perform(async () => {
    clearCorrection();
    const generation = correctionGeneration,
      expires = Date.parse(care.correctionGrant?.expiresAt ?? "");
    if (!currentCorrection(care, generation, expires)) return;
    const story = await careApi.story(care.id, props.csrf);
    if (!currentCorrection(care, generation, expires)) return;
    correction.value = story;
    correctionTitle.value = story.revision!.title;
    correctionParagraphs.value = story.revision!.paragraphs.map((p) => ({
      ...p,
      sourceRefs: [...p.sourceRefs],
    }));
    reviewReasons.value = story.revision!.reviewItems.map((item) => ({
      item,
      reason:
        story.revision!.reviewResolutions?.find((r) => r.item === item)
          ?.reason ?? "",
    }));
    correctionTimer = setTimeout(
      () => {
        if (selected.value === care && correctionGeneration === generation)
          clearCorrection();
      },
      Math.min(2147483647, Math.max(0, expires - Date.now())),
    );
  });
}
async function saveCorrection() {
  const care = selected.value,
    story = correction.value;
  if (!care || !story) return;
  const generation = correctionGeneration,
    expires = Date.parse(care.correctionGrant?.expiresAt ?? "");
  try {
    await perform(async () => {
      if (!currentCorrection(care, generation, expires)) {
        clearCorrection();
        return;
      }
      const reasons = reviewReasons.value.filter((r) => r.reason.trim()),
        input = JSON.stringify({
          revision: story.revision!.id,
          title: correctionTitle.value,
          paragraphs: correctionParagraphs.value,
          reasons,
        });
      if (intent?.input !== input) intent = { input, key: crypto.randomUUID() };
      try {
        const corrected = await careApi.correct(
          care.id,
          story,
          correctionTitle.value,
          correctionParagraphs.value,
          reasons,
          intent.key,
          props.csrf,
        );
        if (!currentCorrection(care, generation, expires)) return;
        correction.value = corrected;
        intent = null;
      } catch (failure) {
        if (selected.value === care && correctionGeneration === generation)
          throw failure;
      }
    });
  } finally {
    if (
      selected.value === care &&
      correctionGeneration === generation &&
      Number.isFinite(expires) &&
      Date.now() >= expires
    )
      clearCorrection();
  }
}
async function rebind() {
  const care = selected.value;
  if (!care || care.state !== "open" || !evidence.value) return;
  await perform(async () => {
    const input = JSON.stringify({
      id: care.id,
      target: care.targetUserId,
      version: care.sourceBindingVersion,
      evidence: evidence.value,
    });
    if (intent?.input !== input) intent = { input, key: crypto.randomUUID() };
    await careApi.rebind(care, evidence.value, intent.key, props.csrf);
    intent = null;
    selected.value = await careApi.read(care.id);
    cases.value = (await careApi.list()).requests;
  });
}
async function intake() {
  if (!intakeProject.value) return;
  await perform(async () => {
    const input = JSON.stringify({
      project: intakeProject.value,
      kind: intakeKind.value,
      purpose: intakeKind.value === "withdraw" ? intakePurpose.value : null,
      version: intakeVersion.value,
    });
    if (intent?.input !== input) intent = { input, key: crypto.randomUUID() };
    const care = await careApi.open(
      intakeProject.value,
      intakeKind.value,
      intakeVersion.value,
      intent.key,
      props.csrf,
      intakeKind.value === "withdraw" && intakePurpose.value !== "all"
        ? intakePurpose.value
        : undefined,
    );
    selected.value = await careApi.read(care.id);
    evidence.value = "";
    cases.value = (await careApi.list()).requests;
    intent = null;
    notice.value = "代录申请已记录，等待独立核验。";
  });
}
async function verify() {
  const care = selected.value;
  if (!care || care.state !== "open" || !evidence.value) return;
  await perform(async () => {
    const input = JSON.stringify({
      id: care.id,
      evidence: evidence.value,
      version: care.sourceBindingVersion,
      epoch: care.sourceAccessEpoch,
    });
    if (intent?.input !== input) intent = { input, key: crypto.randomUUID() };
    await careApi.verify(care, evidence.value, intent.key, props.csrf);
    intent = null;
    selected.value = await careApi.read(care.id);
    cases.value = (await careApi.list()).requests;
  });
}
onMounted(refresh);
</script>
<template>
  <section class="runtime">
    <div class="page-title">
      <div>
        <h1>客服工单</h1>
        <p>按本人核验结果执行原项目换绑，保留同一讲述者与历史记录。</p>
      </div>
    </div>
    <Alert
      type="info"
      message="隔离合成验证：D08 真实核验与告知规则尚未冻结。本表单不得作为真实本人核验。"
      show-icon
    />
    <Alert v-if="error" type="error" :message="error" role="alert" />
    <Alert v-if="notice" type="info" :message="notice" />
    <Form layout="vertical" class="section">
      <FormItem label="代录项目编号"
        ><Input
          v-model:value="intakeProject"
          aria-label="代录项目编号"
          :disabled="busy"
      /></FormItem>
      <label
        >代录申请类型<select
          v-model="intakeKind"
          aria-label="代录申请类型"
          :disabled="busy"
        >
          <option value="withdraw">本人撤回申请</option>
          <option value="export">本人资料导出申请</option>
          <option value="delete">本人删除申请</option>
        </select></label
      >
      <label v-if="intakeKind === 'withdraw'"
        >本人申请撤回范围<select
          v-model="intakePurpose"
          aria-label="本人申请撤回范围"
          :disabled="busy"
        >
          <option value="all">全部三项用途</option>
          <option value="collection">采集保存</option>
          <option value="ai">AI 处理</option>
          <option value="sharing">向发起人共享</option>
        </select></label
      >
      <label
        >来源绑定版本<input
          v-model.number="intakeVersion"
          aria-label="代录来源绑定版本"
          type="number"
          min="0"
          :disabled="busy"
      /></label>
      <p>
        记录实际申请人是本项目讲述者、操作人是当前客服；代录不等于核验通过。真实渠道与时限待冻结。
      </p>
      <Button :disabled="busy || !intakeProject" @click="intake"
        >代录本人申请</Button
      >
    </Form>
    <Button :loading="busy" @click="refresh">重新查询工单</Button>
    <div class="section">
      <p v-if="!cases.length">暂无本人申请。</p>
      <div v-for="care in cases" :key="care.id" class="audit-section">
        <p>
          {{ kindLabel(care.kind) }} ·
          {{
            care.state === "open"
              ? "待核验"
              : care.state === "verified"
                ? "已核验，待后续处理"
                : "已完成"
          }}
        </p>
        <Button :disabled="busy" @click="open(care.id)"
          >查看 {{ care.id }}</Button
        >
      </div>
    </div>
    <section v-if="selected" class="audit-section">
      <CompleteExport
        v-if="selected.kind === 'export'"
        :care="selected"
        :csrf="props.csrf"
        @expired="emit('expired')"
      />
      <h2>
        {{
          selected.kind === "rebind" ? "本人账号换绑" : kindLabel(selected.kind)
        }}
      </h2>
      <p>共享工单：record:{{ selected.id }}</p>
      <p>项目：{{ selected.projectId }}</p>
      <p>申请主体：{{ selected.requesterSubjectId || selected.requesterId }}</p>
      <p>
        代录操作人：{{ selected.operatorRealm }} / {{ selected.operatorId }}
      </p>
      <p>目标账号：{{ selected.targetUserId }}</p>
      <p>来源绑定版本：{{ selected.sourceBindingVersion }}</p>
      <Alert
        v-if="selected.kind === 'refund' || selected.kind === 'quality'"
        type="info"
        :message="
          selected.kind === 'quality'
            ? '按原订单、确定文件和实际生产情况核验质量方案；私人资料须本人限时授权。'
            : '退款状态以本工单的微信核验与原单对账结果为准。'
        "
      />
      <Alert
        v-else-if="selected.state === 'completed'"
        type="success"
        :message="
          selected.kind === 'production_handoff'
            ? '本次生产交接工单已完成，交付或取消结果以生产与物流的具体回执记录为准。'
            : selected.kind === 'delete'
              ? '在线访问已停止；各层删除进度请按下方清单核实。'
              : selected.kind === 'export'
                ? '本次完整资料交付回执已记录。包下载期限和原始资料保留期限仍分别执行。'
                : '工单已完成，原账号权限已撤销，新账号须重新授权。'
        "
      />
      <Alert
        v-else-if="selected.state === 'verified'"
        type="info"
        :message="
          selected.kind === 'correction'
            ? '本次限时故事校对已核验；新版本仍须本人重新确认。'
            : selected.kind === 'delete'
              ? '本人删除已核验，在线访问立即停止且项目删除不可逆；各层清理按下方独立证据处理。'
              : '本人申请已核验，导出交付与后续联动仍待对应流程处理。'
        "
      />
      <Alert
        v-else-if="selected.kind === 'production_handoff'"
        type="info"
        message="请在生产与物流中核对本次交接编号、负责人、期限和印厂回执。交接未知或取消待核实时，不能重发文件或释放权益；本工单不执行本人撤回、删除或账号换绑。"
      />
      <Alert
        v-else-if="selected.kind === 'first_copy_expiry'"
        type="info"
        message="请核对原订单制作期限和冻结政策，再按服务期限流程跟进。记录本工单不会放行制作、预留首本或删除资料；后续提交与生产审核仍须通过全部核验。"
      />
      <Form v-else layout="vertical" class="section"
        ><p v-if="selected.kind === 'withdraw'">
          本人申请撤回范围：{{
            selected.withdrawalPurpose === "ai"
              ? "AI 处理"
              : selected.withdrawalPurpose === "collection"
                ? "采集保存"
                : selected.withdrawalPurpose === "sharing"
                  ? "向发起人共享"
                  : "全部三项用途"
          }}
        </p>
        <FormItem label="D08 核验证据引用"
          ><Input
            v-model:value="evidence"
            aria-label="D08 核验证据引用"
            placeholder="synthetic:隔离本人核验证据"
            :disabled="busy"
        /></FormItem>
        <p>
          {{
            selected.kind === "rebind"
              ? "核对本人、原账号与目标账号后提交。操作撤销旧授权并保留服务期限。"
              : selected.kind === "withdraw"
                ? "核验本人真实意愿后撤回所选用途许可；提交后立即拒绝相关访问，任务及生产按撤回范围联动；已交接的文件仍须核对印厂实际取消回执。"
                : selected.kind === "delete"
                  ? "核验通过将立即停止在线访问并永久删除项目，不能撤销。活动资料由系统清理，历史、备份和供应商副本分别核验。"
                  : "核验通过记录申请，导出交付仍须后续流程。"
          }}
        </p>
        <Button
          type="primary"
          :disabled="busy || !evidence.startsWith('synthetic:')"
          :loading="busy"
          @click="selected.kind === 'rebind' ? rebind() : verify()"
          >{{
            selected.kind === "rebind" ? "核验完成并换绑" : "核验本人申请"
          }}</Button
        ></Form
      >
      <DeletionCase
        v-if="selected.kind === 'delete'"
        :key="selected.id + ':' + selected.state"
        :case-id="selected.id"
        :csrf="props.csrf"
        @expired="emit('expired')"
      />
      <RefundCase
        v-if="selected.kind === 'refund'"
        :key="selected.id"
        :case-id="selected.id"
        :csrf="props.csrf"
        @expired="emit('expired')"
        @changed="refresh"
      />
      <QualityCase
        v-if="selected.kind === 'quality'"
        :key="selected.id"
        :case-id="selected.id"
        :csrf="props.csrf"
        @expired="emit('expired')"
        @changed="refresh"
        @production="(orderId) => emit('production', orderId)"
      />
      <section
        v-if="selected.kind === 'correction' && selected.correctionGrant"
        class="section"
      >
        <h3>本次受控故事校对</h3>
        <p>
          本人授权到期：{{
            selected.correctionGrant.expiresAt
          }}。仅核验本次工单的客服可读取和校对；新稿仍需本人重新确认。
        </p>
        <Button
          :disabled="busy || selected.state !== 'verified'"
          @click="loadCorrection"
          >读取获授权故事</Button
        >
        <div v-if="correction && correction.revision">
          <FormItem label="校对标题"
            ><Input v-model:value="correctionTitle" :disabled="busy"
          /></FormItem>
          <div
            v-for="(paragraph, index) in correctionParagraphs"
            :key="index"
            class="section"
          >
            <label
              >第 {{ index + 1 }} 段<textarea
                v-model="paragraph.text"
                :disabled="busy"
                rows="5"
              />
            </label>
            <p>原有讲述来源保留。</p>
          </div>
          <div
            v-for="(review, index) in reviewReasons"
            :key="index"
            class="section"
          >
            <p>核对项：{{ review.item }}</p>
            <label
              >处理依据<textarea
                v-model="review.reason"
                :disabled="busy"
                rows="3"
              />
            </label>
          </div>
          <Button :disabled="busy" @click="saveCorrection"
            >保存新版本，交本人确认</Button
          >
          <p>
            第 {{ correction.version }} 版；运营校对不代表本人确认或入书许可。
          </p>
        </div>
      </section>
      <section v-if="selected.withdrawal?.changes.length" class="section">
        <h3>撤回与账号变更处置</h3>
        <p>{{ selected.withdrawal.boundary }}</p>
        <p v-if="selected.withdrawal.production">
          生产阶段：{{ selected.withdrawal.production.state }}；负责人：{{
            selected.withdrawal.production.ownerAdminId
          }}；处理期限：{{ selected.withdrawal.production.dueAt }}
        </p>
        <p v-for="change in selected.withdrawal.changes" :key="change.id">
          范围：{{
            change.purpose === "ai"
              ? "AI 处理"
              : change.purpose === "collection"
                ? "采集保存"
                : change.purpose === "sharing"
                  ? "向发起人共享"
                  : change.purpose === "binding"
                    ? "账号换绑"
                    : "全部三项用途"
          }}；{{
            change.applied ? "系统联动已执行" : "访问已撤销，系统联动待补扫"
          }}。{{
            change.productionAction === "supplier_pending"
              ? "供应商取消结果待人工核实"
              : change.productionAction === "already_delivered"
                ? "纸书已交付，不能远程收回"
                : ""
          }}
        </p>
      </section>
      <div v-if="selected.verification" class="section">
        <p>核验证据：{{ selected.verification.evidenceRef }}</p>
        <p>核验客服：{{ selected.verification.operatorAdminId }}</p>
      </div>
      <div
        v-for="change in selected.changes"
        :key="change.requestId"
        class="section"
      >
        <p>
          绑定版本：{{ change.bindingVersion }} · 访问版本：{{
            change.accessEpoch
          }}
        </p>
        <p>核验证据：{{ change.evidenceRef }}</p>
        <p>处理人：{{ change.operatorId }}</p>
      </div>
    </section>
  </section>
</template>
