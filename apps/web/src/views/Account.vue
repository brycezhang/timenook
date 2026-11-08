<script setup lang="ts">
import { onUnmounted, ref } from "vue";
import { RouterLink } from "vue-router";
import { auth } from "../session";
import { projectApi, projectError } from "../project-api";
import Icon from "../components/Icon.vue";
defineEmits<{ login: [target?: string] }>();
const editing = ref(false),
  nickname = ref(""),
  nicknameError = ref(""),
  saving = ref(false);
let generation = 0;
const clear = auth.onClear(() => {
  generation++;
  editing.value = false;
  nickname.value = "";
  nicknameError.value = "";
  saving.value = false;
});
onUnmounted(() => {
  generation++;
  clear();
});
function editNickname() {
  nickname.value = auth.account.value?.user.nickname ?? "";
  nicknameError.value = "";
  editing.value = true;
}
async function saveNickname() {
  if (!nickname.value.trim()) return;
  const current = generation;
  saving.value = true;
  nicknameError.value = "";
  try {
    const result = await projectApi.nickname(nickname.value.trim());
    if (current === generation) {
      auth.updateNickname(result.nickname);
      editing.value = false;
    }
  } catch (reason) {
    if (current === generation) nicknameError.value = projectError(reason);
  } finally {
    if (current === generation) saving.value = false;
  }
}
const busy = ref(false),
  error = ref("");
async function logout() {
  busy.value = true;
  error.value = "";
  try {
    await auth.logout();
  } catch {
    error.value = "退出尚未完成，请重试。";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <section class="page-heading">
    <h1>我的</h1>
  </section>
  <section class="account-panel panel">
    <div class="account-avatar"><Icon name="user" :size="30" /></div>
    <h2>{{ auth.account.value?.user.nickname ?? "欢迎来到时光故事" }}</h2>
    <button
      v-if="auth.account.value"
      class="text-button nickname-button"
      aria-label="修改昵称"
      @click="editNickname"
    >
      修改昵称<Icon name="pencil" :size="15" />
    </button>
    <RouterLink v-if="auth.account.value" class="button" to="/projects"
      >我的项目<Icon name="arrow" :size="16" /></RouterLink
    ><button v-else class="button" @click="$emit('login')">
      手机号登录<Icon name="arrow" :size="16" />
    </button>
  </section>
  <section class="panel account-purchase">
    <h2>为重要的人，新做一本书</h2>
    <RouterLink
      v-if="auth.account.value"
      class="button secondary"
      to="/purchase"
      >新购一本书</RouterLink
    >
    <button
      v-else
      class="button secondary"
      @click="$emit('login', '/purchase')"
    >
      新购一本书
    </button>
  </section>
  <div class="account-links panel">
    <RouterLink to="/sample"
      ><span>翻阅公开样书</span><Icon name="arrow" :size="17" /></RouterLink
    ><RouterLink to="/terms"
      ><span>使用条款与隐私说明</span
      ><Icon name="arrow" :size="17" /></RouterLink
    ><button
      v-if="auth.account.value || error"
      :disabled="busy"
      @click="logout"
    >
      <span>{{ busy ? "正在退出" : error ? "重试退出登录" : "退出登录" }}</span
      ><span v-if="busy" class="spinner" />
    </button>
  </div>
  <dialog
    :open="editing"
    class="edit-dialog"
    aria-label="修改昵称"
    @cancel.prevent="editing = false"
  >
    <form class="edit-dialog-body" @submit.prevent="saveNickname">
      <button
        type="button"
        class="icon-button close-dialog"
        aria-label="关闭昵称修改"
        :disabled="saving"
        @click="editing = false"
      >
        <Icon name="x" />
      </button>
      <h2>修改昵称</h2>
      <label class="field-label"
        >昵称<input
          v-model="nickname"
          required
          maxlength="32"
          autocomplete="nickname"
      /></label>
      <p v-if="nicknameError" class="error" role="alert">{{ nicknameError }}</p>
      <div class="hero-actions">
        <button class="button" :disabled="saving || !nickname.trim()">
          <span v-if="saving" class="spinner" />保存昵称</button
        ><button
          type="button"
          class="button secondary"
          :disabled="saving"
          @click="editing = false"
        >
          取消
        </button>
      </div>
    </form>
  </dialog>
  <div
    v-if="editing"
    class="dialog-shade"
    @click="!saving && (editing = false)"
  />
  <p v-if="error" class="error" role="alert">{{ error }}</p>
</template>
