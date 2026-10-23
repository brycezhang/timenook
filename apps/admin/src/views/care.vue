<script setup lang="ts">
import { ref, onMounted, onUnmounted } from "vue";
import { Alert, Button, Form, FormItem, Input } from "antdv-next";
import type { CareCase, StoryView } from "@timenook/contracts";
import { careApi } from "../api/admin";
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
const emit = defineEmits<{ expired: [] }>();
const cases = ref<CareCase[]>([]),
  selected = ref<CareCase | null>(null),
  busy = ref(false),
  error = ref(""),
  evidence = ref("");
const intakeProject = ref(""),
  intakeKind = ref<"withdraw" | "export" | "delete">("withdraw"),
  intakeVersion = ref(0),
  notice = ref("");
const kindLabel = (kind: string) =>
  kind === "correction"
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
      version: intakeVersion.value,
    });
    if (intent?.input !== input) intent = { input, key: crypto.randomUUID() };
    const care = await careApi.open(
      intakeProject.value,
      intakeKind.value,
      intakeVersion.value,
      intent.key,
      props.csrf,
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
        v-if="selected.state === 'completed'"
        type="success"
        message="工单已完成，原账号权限已撤销，新账号须重新授权。"
      />
      <Alert
        v-else-if="selected.state === 'verified'"
        type="info"
        :message="
          selected.kind === 'correction'
            ? '本次限时故事校对已核验；新版本仍须本人重新确认。'
            : '本人申请已核验，导出交付、删除执行与后续联动仍待对应流程处理。'
        "
      />
      <Form v-else layout="vertical" class="section"
        ><FormItem label="D08 核验证据引用"
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
                ? "核验本人真实意愿后撤回当前三项用途许可；后续任务与生产联动由对应流程处理。"
                : "核验通过仅记录申请，导出交付和删除执行仍须后续流程。"
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
