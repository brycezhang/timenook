<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute } from "vue-router";
import { auth } from "../session";
import {
  isWechatBrowser,
  purchaseApi,
  submitAlipay,
  type PurchaseOrder,
} from "../purchase-api";
const route = useRoute(),
  order = ref<PurchaseOrder | null>(null),
  loading = ref(true),
  busy = ref(false),
  error = ref("");
const wechat = isWechatBrowser(),
  copied = ref(false);
let generation = 0;
const clear = auth.onClear(() => {
  generation++;
  order.value = null;
});
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const result = await purchaseApi.get(String(route.params.orderId));
    if (generation === current) order.value = result;
  } catch (reason) {
    if (generation === current)
      error.value =
        reason instanceof Error ? reason.message : "查询失败，请重试。";
  } finally {
    if (generation === current) loading.value = false;
  }
}
async function pay() {
  if (!order.value || busy.value || wechat) return;
  busy.value = true;
  error.value = "";
  const current = generation;
  try {
    const result = await purchaseApi.prepare(order.value.id);
    if (current !== generation) return;
    if (result.status === "prepared" && result.form) submitAlipay(result.form);
    else await load();
  } catch (reason) {
    if (generation === current)
      error.value =
        reason instanceof Error ? reason.message : "暂时无法发起付款。";
  } finally {
    busy.value = false;
  }
}
async function close() {
  if (!order.value || busy.value) return;
  busy.value = true;
  error.value = "";
  const current = generation;
  try {
    const result = await purchaseApi.close(order.value.id);
    if (generation === current) order.value = result;
  } catch (reason) {
    if (generation === current)
      error.value =
        reason instanceof Error ? reason.message : "暂时无法关闭订单。";
  } finally {
    busy.value = false;
  }
}
async function copyLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    copied.value = true;
  } catch {
    error.value = "请使用微信菜单在浏览器打开当前网页。";
  }
}
watch(() => route.params.orderId, load);
onMounted(load);
onUnmounted(() => {
  generation++;
  clear();
});
</script>
<template>
  <section class="page-heading">
    <p class="eyebrow">岁月成书 · 购买确认</p>
    <h1>
      {{
        order?.state === "paid" && order.project
          ? "付款已确认"
          : order?.state === "closed"
            ? "本次购买已关闭"
            : "确认付款结果"
      }}
    </h1>
  </section>
  <section
    v-if="loading && !order"
    class="panel payment-panel"
    aria-busy="true"
    aria-label="正在查询付款结果"
  >
    <div class="skeleton skeleton-cover" />
    <div class="skeleton skeleton-line" />
  </section>
  <p v-if="error" class="notice error" role="alert">
    {{ error }}
    <button class="text-button" :disabled="loading" @click="load">
      重新查询
    </button>
  </p>
  <section v-if="order" class="panel payment-panel">
    <p class="eyebrow">{{ order.bookTitle }}</p>
    <h2>人生故事书 · ¥999</h2>
    <template v-if="order.state === 'paid' && order.project"
      ><p>项目已开通，可以开始留下第一段故事。</p>
      <RouterLink class="button" :to="`/projects/${order.project.id}`"
        >进入我的故事书</RouterLink
      ></template
    >
    <template v-else-if="order.state === 'closed'"
      ><p class="muted">尚未完成付款。如需购买，请重新填写购买信息。</p>
      <RouterLink class="button secondary" to="/purchase"
        >重新购买</RouterLink
      ></template
    >
    <template v-else>
      <p v-if="order.paymentStatus === 'unknown'" role="status">
        付款结果暂未确认。若已付款，请稍后再次查询，暂勿重复购买。
      </p>
      <p v-else class="muted">暂未确认付款。完成支付宝付款后，回到这里查询。</p>
      <div v-if="wechat" class="notice">
        <p>
          请点击微信右上角菜单，在浏览器中打开本页，再使用同一手机号登录继续。
        </p>
        <button class="text-button" @click="copyLink">
          {{ copied ? "链接已复制" : "复制当前链接" }}
        </button>
      </div>
      <div class="payment-actions">
        <button class="button" :disabled="loading || busy" @click="load">
          <span v-if="loading" class="spinner" />{{
            loading ? "正在查询" : "我已完成付款，查询状态"
          }}</button
        ><button
          v-if="!wechat && order.paymentStatus !== 'unknown'"
          class="button secondary"
          :disabled="busy || loading"
          @click="pay"
        >
          <span v-if="busy" class="spinner" />继续支付宝付款</button
        ><button class="text-button" :disabled="busy || loading" @click="close">
          关闭未付款订单
        </button>
      </div>
    </template>
  </section>
  <RouterLink class="text-button" to="/projects">返回我的项目</RouterLink>
</template>
<style scoped>
.payment-panel {
  max-width: 700px;
  padding: 32px;
  margin-bottom: 20px;
}
.payment-panel p {
  line-height: 1.8;
}
.payment-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 12px;
  margin: 24px 0;
}
.payment-panel .notice {
  margin: 20px 0;
}
.payment-panel h2 {
  overflow-wrap: anywhere;
}
@media (max-width: 600px) {
  .payment-panel {
    padding: 24px;
  }
  .payment-actions {
    flex-direction: column;
    align-items: stretch;
  }
}
</style>
