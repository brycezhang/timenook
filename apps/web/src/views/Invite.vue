<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { auth } from "../session";
import { projectApi, projectError, type Invitation } from "../project-api";
import Icon from "../components/Icon.vue";
const emit = defineEmits<{ login: [target?: string] }>();
const route = useRoute(),
  router = useRouter();
const invitation = ref<Invitation | null>(null),
  loading = ref(true),
  busy = ref(false),
  agreed = ref(false),
  relationship = ref(""),
  error = ref("");
let generation = 0,
  controller: AbortController | undefined;
const clear = auth.onClear(() => {
  agreed.value = false;
  relationship.value = "";
  busy.value = false;
  generation++;
});
async function load() {
  controller?.abort();
  controller = new AbortController();
  const current = ++generation;
  loading.value = true;
  error.value = "";
  try {
    const result = await projectApi.invitation(
      String(route.params.token),
      controller.signal,
    );
    if (current === generation) invitation.value = result;
  } catch {
    if (current === generation) {
      invitation.value = null;
      error.value = "邀请链接已失效或暂时不可用，请联系家人重新发送。";
    }
  } finally {
    if (current === generation) loading.value = false;
  }
}
watch(() => route.params.token, load, { immediate: true });
watch(
  () => auth.restoring.value,
  (restoring) => {
    if (!restoring && !invitation.value) void load();
  },
);
onUnmounted(() => {
  generation++;
  controller?.abort();
  clear();
});
async function accept() {
  if (!agreed.value || busy.value) return;
  if (!relationship.value.trim()) {
    error.value = "请填写你是主讲人的谁";
    return;
  }
  const current = generation;
  busy.value = true;
  error.value = "";
  try {
    const result = await projectApi.accept(
      String(route.params.token),
      relationship.value.trim(),
    );
    if (current === generation)
      await router.push(`/projects/${result.projectId}`);
  } catch (reason) {
    if (current === generation) error.value = projectError(reason);
  } finally {
    if (current === generation) busy.value = false;
  }
}
</script>
<template>
  <section class="invitation-panel panel">
    <span class="empty-icon"><Icon name="users" :size="35" /></span>
    <p class="eyebrow">家人的故事，一起珍藏</p>
    <h1>一起把故事写完整</h1>
    <div
      v-if="loading && !invitation"
      aria-busy="true"
      aria-label="正在读取邀请"
    >
      <div class="skeleton skeleton-line" />
      <div class="skeleton skeleton-line" />
    </div>
    <template v-if="invitation"
      ><p class="invitation-title">{{ invitation.bookTitle }}</p>
      <p class="muted">
        家人邀请你加入这本故事书。接受后，可以一起记录、编辑故事、制作书稿和提交印刷。
      </p>
      <div class="invitation-steps">
        <span><Icon name="mic" />记录故事</span
        ><span><Icon name="pencil" />一起编辑</span
        ><span><Icon name="book" />岁月成书</span>
      </div>
      <template v-if="auth.account.value"
        ><p class="muted text-small">
          以「{{ auth.account.value.user.nickname || "我的账号" }}」加入
        </p>
        <label class="field"
          >你是主讲人的谁（必填）
          <input
            v-model="relationship"
            maxlength="32"
            placeholder="例如：女儿、孙子或自定义关系"
          />
        </label>
        <label class="agreement"
          ><input v-model="agreed" type="checkbox" /><span
            >我已阅读并同意<RouterLink to="/terms" target="_blank"
              >《使用条款与隐私说明》</RouterLink
            >，接受邀请加入此项目。</span
          ></label
        ><button
          class="button full-width"
          :disabled="!agreed || busy"
          @click="accept"
        >
          <span v-if="busy" class="spinner" />接受邀请
        </button></template
      ><button
        v-else
        class="button full-width"
        :disabled="auth.restoring.value"
        @click="emit('login', route.fullPath)"
      >
        登录后接受邀请
      </button>
      <p class="muted text-small invitation-footnote">
        登录后会回到这里，由你确认接受邀请。
      </p></template
    >
    <div v-if="error" class="error" role="alert">{{ error }}</div>
    <button
      v-if="!invitation && !loading"
      class="button secondary"
      @click="load"
    >
      重新读取</button
    ><RouterLink class="text-button invitation-footnote" to="/"
      >了解时光故事<Icon name="arrow" :size="15"
    /></RouterLink>
  </section>
</template>
