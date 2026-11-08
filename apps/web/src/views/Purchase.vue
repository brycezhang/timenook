<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { auth } from "../session";
import {
  alipayChannel,
  isWechatBrowser,
  purchaseApi,
  submitAlipay,
  type PurchaseOrder,
} from "../purchase-api";
const router = useRouter(),
  loading = ref(true),
  busy = ref(false),
  error = ref("");
const catalog = ref<Awaited<ReturnType<typeof purchaseApi.catalog>> | null>(
    null,
  ),
  pending = ref<PurchaseOrder[]>([]);
const bookTitle = ref("我的时光手记"),
  subjectName = ref(""),
  relationshipLabel = ref("家人");
const wechat = isWechatBrowser(),
  copied = ref(false);
let generation = 0,
  key = crypto.randomUUID(),
  priorInput = "";
const clear = auth.onClear(() => {
  generation++;
  catalog.value = null;
  pending.value = [];
  bookTitle.value = "";
  subjectName.value = "";
  relationshipLabel.value = "";
});
async function load() {
  const current = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const [offer, list] = await Promise.all([
      purchaseApi.catalog(),
      purchaseApi.list(),
    ]);
    if (generation === current) {
      catalog.value = offer;
      pending.value = list.orders.filter((order) => order.state === "pending");
    }
  } catch (reason) {
    if (generation === current)
      error.value =
        reason instanceof Error ? reason.message : "购买信息读取失败，请重试。";
  } finally {
    if (generation === current) loading.value = false;
  }
}
async function buy() {
  if (!catalog.value?.version || busy.value || wechat) return;
  busy.value = true;
  error.value = "";
  const current = generation;
  try {
    const input = {
      packageVersionId: catalog.value.version.id,
      recipient: { relationshipLabel: relationshipLabel.value.trim() },
      subjectName: subjectName.value.trim() || undefined,
      bookTitle: bookTitle.value.trim(),
      channel: alipayChannel(),
    };
    if (priorInput && priorInput !== JSON.stringify(input))
      key = crypto.randomUUID();
    priorInput = JSON.stringify(input);
    const order = await purchaseApi.create(input, key);
    if (current !== generation) return;
    const prepared = await purchaseApi.prepare(order.id);
    if (current !== generation) return;
    await router.replace(`/purchase/return/${order.id}`);
    if (prepared.status === "prepared" && prepared.form)
      submitAlipay(prepared.form);
  } catch (reason) {
    if (current === generation)
      error.value =
        reason instanceof Error ? reason.message : "付款暂未发起，请重试。";
  } finally {
    busy.value = false;
  }
}
async function copyLink() {
  try {
    await navigator.clipboard.writeText(location.href);
    copied.value = true;
  } catch {
    error.value = "请使用浏览器菜单复制当前网页链接。";
  }
}
onMounted(load);
onUnmounted(() => {
  generation++;
  clear();
});
</script>
<template>
  <section class="page-heading">
    <p class="eyebrow">把熟悉的声音，写成家人的故事</p>
    <h1>新购一本书</h1>
    <p class="muted">一个项目，邀请家人一起记录。</p>
  </section>
  <section v-if="wechat" class="panel purchase-panel">
    <h2>请在浏览器中打开付款</h2>
    <p>点击微信右上角菜单，选择在浏览器打开，再使用同一手机号登录继续购买。</p>
    <button class="button secondary" @click="copyLink">
      {{ copied ? "链接已复制" : "复制当前链接" }}
    </button>
  </section>
  <section
    v-if="loading"
    class="panel purchase-panel"
    aria-busy="true"
    aria-label="正在读取购买信息"
  >
    <div class="skeleton skeleton-line" />
    <div class="skeleton skeleton-line" />
    <div class="skeleton skeleton-cover" />
  </section>
  <p v-if="error" class="notice error" role="alert">
    {{ error }}
    <button v-if="!catalog" class="text-button" @click="load">重试</button>
  </p>
  <form
    v-if="!loading && catalog?.purchasable && !wechat"
    class="panel purchase-panel"
    @submit.prevent="buy"
  >
    <div class="purchase-offer">
      <div>
        <p class="eyebrow">岁月成书套餐</p>
        <h2>人生故事书 · 首本一本</h2>
      </div>
      <strong>¥999</strong>
    </div>
    <p class="muted">
      语音讲述、照片与故事整理、专属书稿及首本人生书。成书后再填写收货地址。
    </p>
    <label
      >书名<input
        v-model="bookTitle"
        required
        maxlength="80"
        autocomplete="off"
        placeholder="例如：妈妈的一生"
    /></label>
    <label
      >主人公姓名<span class="muted">（选填）</span
      ><input
        v-model="subjectName"
        maxlength="40"
        autocomplete="off"
        placeholder="这本书写谁的故事"
    /></label>
    <label
      >与我的关系<input
        v-model="relationshipLabel"
        required
        maxlength="40"
        autocomplete="off"
        placeholder="例如：妈妈、伴侣、自己"
    /></label>
    <p class="muted">
      付款后，项目归当前登录账号所有。<RouterLink to="/terms"
        >查看使用条款与服务约定</RouterLink
      >
    </p>
    <button
      type="submit"
      class="button"
      :disabled="busy || !bookTitle.trim() || !relationshipLabel.trim()"
    >
      <span v-if="busy" class="spinner" />{{
        busy ? "正在发起付款" : "支付宝付款 · ¥999"
      }}
    </button>
  </form>
  <section
    v-else-if="!loading && catalog && !catalog.purchasable"
    class="panel purchase-panel"
  >
    <h2>套餐准备中</h2>
    <p class="muted">暂时无法发起新购。已有项目可以继续记录。</p>
    <RouterLink class="button secondary" to="/projects"
      >查看我的项目</RouterLink
    >
  </section>
  <section v-if="pending.length" class="panel purchase-panel">
    <h2>继续未完成的购买</h2>
    <RouterLink
      v-for="order in pending"
      :key="order.id"
      class="pending-order"
      :to="`/purchase/return/${order.id}`"
      ><span>{{ order.bookTitle }}</span
      ><span>查询 / 继续付款 →</span></RouterLink
    >
  </section>
</template>
<style scoped>
.purchase-panel {
  max-width: 700px;
  margin-bottom: 20px;
  padding: 30px;
}
.purchase-offer {
  display: flex;
  justify-content: space-between;
  gap: 16px;
  align-items: center;
}
.purchase-offer h2 {
  font-size: 22px;
}
.purchase-offer strong {
  font:
    32px Georgia,
    serif;
  color: var(--primary, #8b5d3b);
}
label {
  display: block;
  margin: 22px 0 0;
  font-weight: 500;
}
input {
  display: block;
  width: 100%;
  padding: 13px 14px;
  margin-top: 8px;
  border: 1px solid var(--border, #e9dfd5);
  border-radius: 10px;
  background: #fff;
  color: inherit;
  font: inherit;
}
.purchase-panel p {
  line-height: 1.8;
}
.purchase-panel .button {
  margin-top: 12px;
}
.pending-order {
  display: flex;
  justify-content: space-between;
  gap: 20px;
  padding: 18px 0;
  border-bottom: 1px solid var(--border, #e9dfd5);
  overflow-wrap: anywhere;
}
@media (max-width: 600px) {
  .purchase-panel {
    padding: 22px;
  }
  .purchase-offer h2 {
    font-size: 18px;
  }
  .pending-order {
    flex-wrap: wrap;
    gap: 6px;
  }
}
</style>
