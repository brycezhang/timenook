<script setup lang="ts">
import { computed, onUnmounted, reactive, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import type {
  FirstCopyBlocker,
  FirstCopyContext,
  FulfillmentAttemptView,
  FulfillmentView,
} from "../../../../packages/contracts/src";
import { WebApiError } from "../api";
import { auth } from "../session";
import { productionApi, productionError } from "../production-api";
import Icon from "../components/Icon.vue";
import "../production.css";
const route = useRoute(),
  id = computed(() => String(route.params.projectId));
const context = ref<FirstCopyContext | null>(null),
  progress = ref<FulfillmentView | null>(null);
const loading = ref(false),
  busy = ref(""),
  error = ref(""),
  message = ref(""),
  actionError = ref("");
const needsRefresh = ref(false),
  unknown = ref(false),
  dirty = ref(false);
const address = reactive({
  recipientName: "",
  phone: "",
  regionCode: "",
  detail: "",
});
let generation = 0;
let submitIntent: { fact: string; key: string } | undefined;
let addressIntent: { fact: string; key: string } | undefined;
const clear = auth.onClear(() => {
  generation++;
  context.value = null;
  progress.value = null;
  Object.assign(address, {
    recipientName: "",
    phone: "",
    regionCode: "",
    detail: "",
  });
  submitIntent = addressIntent = undefined;
});
function acceptAddress(value: FirstCopyContext) {
  Object.assign(
    address,
    value.address.value ?? {
      recipientName: "",
      phone: "",
      regionCode: "",
      detail: "",
    },
  );
  dirty.value = false;
}
async function load() {
  if (busy.value) return;
  const current = ++generation;
  loading.value = true;
  error.value = "";
  message.value = "";
  try {
    const result = await productionApi.read(id.value);
    if (current !== generation) return;
    context.value = result.firstCopy;
    progress.value = result.fulfillment;
    acceptAddress(result.firstCopy);
    needsRefresh.value = unknown.value = false;
    actionError.value = "";
  } catch (reason) {
    if (current === generation) error.value = productionError(reason);
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(
  id,
  () => {
    context.value = progress.value = null;
    busy.value = message.value = actionError.value = "";
    submitIntent = addressIntent = undefined;
    needsRefresh.value = unknown.value = dirty.value = false;
    void load();
  },
  { immediate: true },
);
onUnmounted(() => {
  generation++;
  clear();
});
const blockers: Record<FirstCopyBlocker, string> = {
  PHYSICAL_PRODUCTION_UNAVAILABLE: "当前项目没有实体书制作权益。",
  PRODUCTION_PDF_UNAPPROVED: "书稿等待印前检查，暂时不能提交制作。",
  BOOK_NOT_READY: "请先生成完整书稿，再提交制作。",
  ADDRESS_REQUIRED: "请填写并保存收货地址。",
  NARRATOR_CONFIRMATION_REQUIRED: "请读取最新制作状态。",
  INITIATOR_CONFIRMATION_REQUIRED: "请读取最新制作状态。",
  POLICY_PENDING: "套餐制作暂未开放，请联系客服。",
  SPECIFICATION_MISMATCH: "当前书稿规格需要调整，请联系客服。",
  ENTITLEMENT_UNAVAILABLE: "首本制作权益当前不可用。",
  PROJECT_FROZEN: "当前项目已停止制作。",
  ALREADY_SUBMITTED: "已提交印刷。",
};
const canEdit = computed(
  () =>
    !!context.value &&
    (!context.value.production || context.value.canReviseProduction) &&
    !context.value.blockers.some((b) =>
      ["PHYSICAL_PRODUCTION_UNAVAILABLE", "PROJECT_FROZEN"].includes(b),
    ),
);
const blockerMessages = computed(
  () =>
    context.value?.blockers
      .filter((b) => b !== "ALREADY_SUBMITTED")
      .map((b) => blockers[b]) ?? [],
);
const currentAttempt = computed(() => {
  const attempt = progress.value?.current;
  return attempt?.state === "cancelled" &&
    context.value?.production &&
    !context.value.canReviseProduction
    ? null
    : attempt;
});
const pastAttempts = computed(
  () =>
    progress.value?.attempts.filter(
      (attempt) => attempt.id !== currentAttempt.value?.id,
    ) ?? [],
);
function status(attempt?: FulfillmentAttemptView | null) {
  if (!attempt) return "已提交，等待制作";
  return {
    approved: "已提交，等待制作",
    handoff_pending: "正在核实制作安排",
    in_production: attempt.printedAt ? "已印好，等待发货" : "正在印制",
    shipped: "已发货",
    delivered: "已送达",
    cancellation_pending: "正在核实取消结果",
    cancelled: "本次制作已取消",
  }[attempt.state];
}
const submitted = computed(
  () => !!context.value?.production || !!progress.value?.reservation,
);
const fixedBookId = computed(
  () =>
    currentAttempt.value?.bookVersionId ??
    context.value?.production?.bookVersionId ??
    context.value?.book?.id,
);
const bookPath = computed(
  () =>
    `/projects/${id.value}/book${fixedBookId.value ? `?version=${encodeURIComponent(fixedBookId.value)}` : ""}`,
);
const editableBookPath = computed(() =>
  canEdit.value && context.value?.book
    ? `/projects/${id.value}/book?version=${encodeURIComponent(context.value.book.id)}`
    : bookPath.value,
);
const displayBook = computed(() => {
  const book = context.value?.book;
  return canEdit.value || book?.id === fixedBookId.value ? book : null;
});
function date(value: string) {
  return new Intl.DateTimeFormat("zh-CN", {
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(value));
}
async function saveAddress() {
  const c = context.value;
  if (!c || busy.value || loading.value || needsRefresh.value || !canEdit.value)
    return;
  const value = {
    recipientName: address.recipientName.trim(),
    phone: address.phone.trim(),
    regionCode: address.regionCode,
    detail: address.detail.trim(),
  };
  if (
    !value.recipientName ||
    !/^1\d{10}$/.test(value.phone) ||
    !value.detail ||
    !c.shipping.regionCodes.includes(value.regionCode)
  ) {
    actionError.value = "请填写收件人、11位手机号、配送地区和详细地址。";
    return;
  }
  const fact = JSON.stringify({ expectedVersion: c.address.version, ...value });
  if (addressIntent?.fact !== fact)
    addressIntent = { fact, key: crypto.randomUUID() };
  const current = generation;
  busy.value = "address";
  actionError.value = message.value = "";
  try {
    const saved = await productionApi.saveAddress(
      id.value,
      c.address.version,
      value,
      addressIntent.key,
    );
    if (current !== generation) return;
    context.value = saved;
    acceptAddress(saved);
    addressIntent = undefined;
    message.value = "收货地址已保存。";
  } catch (reason) {
    if (current === generation) {
      actionError.value = productionError(reason);
      needsRefresh.value =
        reason instanceof WebApiError &&
        [403, 409, 422].includes(reason.status);
    }
  } finally {
    if (current === generation) busy.value = "";
  }
}
async function submit() {
  const c = context.value,
    book = c?.book;
  if (
    !c?.canSubmit ||
    !book?.pdf ||
    !c.address.hash ||
    busy.value ||
    loading.value ||
    dirty.value ||
    unknown.value ||
    needsRefresh.value
  )
    return;
  const binding = {
    bookVersionId: book.id,
    snapshotHash: book.snapshotHash,
    pdfHash: book.pdf.sha256,
    addressHash: c.address.hash,
  };
  const fact = JSON.stringify(binding);
  if (submitIntent?.fact !== fact)
    submitIntent = { fact, key: crypto.randomUUID() };
  const current = generation;
  busy.value = "submit";
  actionError.value = message.value = "";
  try {
    const saved = await productionApi.submit(
      id.value,
      binding,
      submitIntent.key,
    );
    if (current !== generation) return;
    context.value = saved;
    if (saved.production) {
      // A revised reservation may precede the next operational attempt.
      if (progress.value)
        progress.value = { ...progress.value, reservation: saved.production };
      message.value = "已提交印刷，可在这里查看最新进度。";
    } else unknown.value = true;
  } catch (reason) {
    if (current !== generation) return;
    if (
      reason instanceof WebApiError &&
      reason.status > 0 &&
      reason.status < 500
    ) {
      actionError.value = productionError(reason);
      needsRefresh.value = true;
    } else {
      unknown.value = true;
      actionError.value = "提交结果尚未确认，请先查询提交结果。";
    }
  } finally {
    if (current === generation) busy.value = "";
  }
}
</script>
<template>
  <div class="production-page">
    <RouterLink class="text-button" :to="`/projects/${id}/book`"
      >← 返回书稿</RouterLink
    >
    <header class="production-heading">
      <p class="eyebrow">从回忆，到可以捧在手里的书</p>
      <h1>让故事，成为一本书</h1>
      <p class="muted">书稿和收货地址就绪后，就可以安排首本制作。</p>
    </header>
    <section
      v-if="loading && !context"
      class="production-layout"
      aria-busy="true"
      aria-label="正在读取制作信息"
    >
      <div v-for="i in 2" :key="i" class="panel production-card">
        <div class="skeleton skeleton-cover" />
        <div class="skeleton skeleton-line" />
        <div class="skeleton skeleton-line" />
      </div>
    </section>
    <div v-if="error" class="notice error" role="alert">
      {{ error
      }}<button class="text-button" :disabled="loading" @click="load">
        重新读取
      </button>
    </div>
    <template v-if="context">
      <section
        v-if="submitted"
        class="panel production-progress"
        aria-label="制作与物流进度"
      >
        <div class="row-between">
          <span class="badge">制作与物流</span
          ><button
            class="text-button"
            :disabled="loading || !!busy"
            @click="load"
          >
            <span v-if="loading" class="spinner" />刷新进度
          </button>
        </div>
        <h2>{{ status(currentAttempt) }}</h2>
        <p class="muted">
          {{
            currentAttempt?.state === "delivered"
              ? "书已经送达，愿这些回忆陪伴你们很久。"
              : currentAttempt?.state === "cancelled"
                ? "确认取消后，可修改书稿或地址，再次提交制作。"
                : "我们会在这里更新实际制作与配送进展。"
          }}
        </p>
        <ol
          v-if="
            currentAttempt &&
            !['cancelled', 'cancellation_pending'].includes(
              currentAttempt.state,
            )
          "
          class="production-steps"
        >
          <li class="complete">
            <Icon name="check" :size="16" /><span>已提交</span>
          </li>
          <li :class="{ complete: !!currentAttempt.printedAt }">
            <Icon name="book" :size="16" /><span>已生产</span>
          </li>
          <li :class="{ complete: !!currentAttempt.tracking }">
            <Icon name="arrow" :size="16" /><span>已发货</span>
          </li>
          <li :class="{ complete: currentAttempt.state === 'delivered' }">
            <Icon name="check" :size="16" /><span>已送达</span>
          </li>
        </ol>
        <dl v-if="currentAttempt?.tracking" class="production-facts">
          <div>
            <dt>承运公司</dt>
            <dd>{{ currentAttempt.tracking.carrier }}</dd>
          </div>
          <div>
            <dt>物流单号</dt>
            <dd>{{ currentAttempt.tracking.number }}</dd>
          </div>
          <div>
            <dt>发货时间</dt>
            <dd>{{ date(currentAttempt.tracking.shippedAt) }}</dd>
          </div>
        </dl>
        <p v-if="currentAttempt?.printedAt" class="muted text-small">
          完成印制：{{ date(currentAttempt.printedAt) }}
        </p>
        <p v-if="currentAttempt?.deliveredAt" class="muted text-small">
          送达时间：{{ date(currentAttempt.deliveredAt) }}
        </p>
        <p
          v-if="
            currentAttempt &&
            ['cancellation_pending', 'cancelled'].includes(currentAttempt.state)
          "
          class="production-notice"
        >
          {{ currentAttempt.cancellationNotice }}
        </p>
        <RouterLink class="text-button" :to="bookPath"
          >查看本次提交的书稿 <Icon name="arrow" :size="15"
        /></RouterLink>
      </section>
      <div class="production-layout">
        <section class="panel production-card">
          <div class="production-card-title">
            <span class="production-number">01</span>
            <h2>
              {{
                submitted && !context.canReviseProduction
                  ? "本次制作的书稿"
                  : "当前书稿"
              }}
            </h2>
          </div>
          <template v-if="context.book">
            <div class="production-book-cover">
              <Icon name="book" :size="34" />
              <h3>
                {{ displayBook?.snapshot.cover.title || "已固定提交时的书稿" }}
              </h3>
              <small v-if="displayBook"
                >第 {{ displayBook.version }} 版 ·
                {{ displayBook.pageCount ?? "—" }} 页</small
              >
            </div>
            <p class="muted">
              {{
                submitted && !context.canReviseProduction
                  ? "制作采用提交时固定的文件。"
                  : context.book.state === "ready"
                    ? "书稿已生成，提交后按这一版制作。"
                    : "书稿尚未就绪，请返回书稿页继续。"
              }}
            </p>
            <RouterLink class="text-button" :to="editableBookPath"
              >阅读书稿 <Icon name="arrow" :size="15"
            /></RouterLink>
          </template>
          <template v-else
            ><p class="muted">先把故事整理成书稿，再来安排制作。</p>
            <RouterLink class="button secondary" :to="`/projects/${id}/book`"
              >前往书稿</RouterLink
            ></template
          >
          <div
            v-if="!context.blockers.includes('PHYSICAL_PRODUCTION_UNAVAILABLE')"
            class="production-entitlement"
          >
            <span>套餐首本</span><strong>1 本</strong
            ><small>本次无需额外付款</small>
          </div>
        </section>
        <section class="panel production-card">
          <div class="production-card-title">
            <span class="production-number">02</span>
            <h2>收货地址</h2>
          </div>
          <form
            v-if="canEdit"
            class="production-address"
            @submit.prevent="saveAddress"
            @input="dirty = true"
            @change="dirty = true"
          >
            <fieldset :disabled="!!busy || loading || needsRefresh">
              <label class="field-label"
                >收件人<input
                  v-model="address.recipientName"
                  required
                  maxlength="80"
                  autocomplete="shipping name"
                  placeholder="收件人姓名"
              /></label>
              <label class="field-label"
                >收货手机号<input
                  v-model="address.phone"
                  required
                  type="tel"
                  inputmode="numeric"
                  pattern="1[0-9]{10}"
                  maxlength="11"
                  autocomplete="shipping tel-national"
                  placeholder="11位手机号"
              /></label>
              <label class="field-label"
                >配送地区<select
                  v-model="address.regionCode"
                  aria-label="配送地区"
                  required
                >
                  <option disabled value="">请选择配送地区</option>
                  <option
                    v-for="code in context.shipping.regionCodes"
                    :key="code"
                    :value="code"
                  >
                    {{ context.shipping.regionLabels[code] || code }}
                  </option>
                </select></label
              >
              <label class="field-label"
                >详细地址<textarea
                  v-model="address.detail"
                  required
                  maxlength="300"
                  rows="3"
                  autocomplete="shipping street-address"
                  placeholder="市、区县、街道及门牌号"
                />
              </label>
              <button class="button secondary full-width">
                <span v-if="busy === 'address'" class="spinner" />保存收货地址
              </button>
            </fieldset>
          </form>
          <address
            v-else-if="context.address.value"
            class="production-address-summary"
          >
            <strong>{{ context.address.value.recipientName }}</strong
            ><span>{{ context.address.value.phone }}</span>
            <p>
              {{
                context.shipping.regionLabels[
                  context.address.value.regionCode
                ] || context.address.value.regionCode
              }}
              {{ context.address.value.detail }}
            </p>
            <small class="muted">本次地址已随提交固定。</small>
          </address>
          <p v-else class="muted">
            {{
              context.blockers.includes("PHYSICAL_PRODUCTION_UNAVAILABLE")
                ? "当前项目没有实体书制作权益。"
                : "尚未填写收货地址。"
            }}
          </p>
        </section>
      </div>
      <p v-if="message" class="production-feedback" role="status">
        <Icon name="check" :size="17" />{{ message }}
      </p>
      <div v-if="actionError || unknown" class="notice error" role="alert">
        {{ actionError || "提交结果尚未确认，请先查询提交结果。"
        }}<button
          v-if="needsRefresh || unknown"
          class="text-button"
          :disabled="loading || !!busy"
          @click="load"
        >
          {{ unknown ? "查询提交结果" : "读取最新状态" }}
        </button>
      </div>
      <section
        v-if="!submitted || context.canReviseProduction"
        class="production-submit panel"
      >
        <div>
          <h2>准备好，就让它成书</h2>
          <p class="muted">
            提交当前书稿与已保存的收货地址，安排套餐内首本制作。
          </p>
        </div>
        <ul v-if="blockerMessages.length" class="production-blockers">
          <li v-for="item in blockerMessages" :key="item">{{ item }}</li>
        </ul>
        <p v-if="dirty" class="muted text-small">收货地址已修改，请先保存。</p>
        <button
          v-if="canEdit"
          class="button"
          :disabled="
            !context.canSubmit ||
            !!busy ||
            loading ||
            dirty ||
            unknown ||
            needsRefresh
          "
          @click="submit"
        >
          <span v-if="busy === 'submit'" class="spinner" />提交印刷<Icon
            v-if="busy !== 'submit'"
            name="arrow"
            :size="17"
          />
        </button>
      </section>
      <p class="production-help">
        如需变更制作安排或处理配送问题，请按<RouterLink to="/terms"
          >使用条款中的联系方式</RouterLink
        >联系客服。取消与实物进度以核实结果为准。
      </p>
      <details v-if="pastAttempts.length" class="production-history">
        <summary>查看以往制作记录</summary>
        <article v-for="attempt in pastAttempts" :key="attempt.id">
          <h3>第 {{ attempt.sequence }} 次制作 · {{ status(attempt) }}</h3>
          <p v-if="attempt.tracking" class="muted">
            {{ attempt.tracking.carrier }} · {{ attempt.tracking.number }}
          </p>
          <RouterLink
            class="text-button"
            :to="`/projects/${id}/book?version=${attempt.bookVersionId}`"
            >查看该次书稿</RouterLink
          >
        </article>
      </details>
    </template>
  </div>
</template>
