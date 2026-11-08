<script setup lang="ts">
import { onUnmounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { auth } from "../session";
import { projectApi, projectError } from "../project-api";
import Icon from "../components/Icon.vue";
import ModalDialog from "../components/ModalDialog.vue";
import InviteDialog from "../components/InviteDialog.vue";
import { workspace } from "../workspace";
defineEmits<{ login: [target?: string] }>();
const editing = ref(false),
  nickname = ref(""),
  nicknameError = ref(""),
  saving = ref(false);
const inviting = ref(false),
  canInvite = ref(false);
let generation = 0;
const clear = auth.onClear(() => {
  generation++;
  editing.value = false;
  inviting.value = false;
  canInvite.value = false;
  nickname.value = "";
  nicknameError.value = "";
  saving.value = false;
});
watch(
  [workspace.selectedId, () => auth.account.value?.session.id],
  async ([id]) => {
    canInvite.value = false;
    if (!id) return;
    const version = generation;
    try {
      const value = await projectApi.overview(id);
      if (version === generation && id === workspace.selectedId.value)
        canInvite.value = value.canInvite;
    } catch {
      /* Other profile actions remain available. */
    }
  },
  { immediate: true },
);
onUnmounted(() => {
  generation++;
  clear();
});
function editNickname(event: MouseEvent) {
  (event.currentTarget as HTMLButtonElement).focus();
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
  <section class="page-heading"><h1>我的</h1></section>
  <section class="profile-card panel">
    <div class="account-avatar">
      <span v-if="auth.account.value">{{
        auth.account.value.user.nickname?.slice(-1) || "我"
      }}</span
      ><Icon v-else name="user" :size="27" />
    </div>
    <div class="profile-identity">
      <h2>{{ auth.account.value?.user.nickname ?? "欢迎来到时光故事" }}</h2>
      <button
        v-if="auth.account.value"
        class="icon-button"
        aria-label="修改昵称"
        @click="editNickname"
      >
        <Icon name="pencil" :size="17" />
      </button>
    </div>
    <button v-if="!auth.account.value" class="button" @click="$emit('login')">
      手机号登录<Icon name="arrow" :size="16" />
    </button>
  </section>
  <div class="account-links panel">
    <RouterLink v-if="auth.account.value" to="/projects"
      ><Icon name="projects" /><span>我的项目</span
      ><Icon name="arrow" :size="17"
    /></RouterLink>
    <button v-if="canInvite && workspace.active.value" @click="inviting = true">
      <Icon name="users" /><span>邀请家人</span><Icon name="arrow" :size="17" />
    </button>
    <RouterLink to="/sample"
      ><Icon name="book" /><span>翻阅公开样书</span
      ><Icon name="arrow" :size="17"
    /></RouterLink>
    <RouterLink to="/terms"
      ><Icon name="lock" /><span>使用条款与隐私说明</span
      ><Icon name="arrow" :size="17"
    /></RouterLink>
  </div>
  <button
    v-if="auth.account.value || error"
    class="account-logout panel"
    :disabled="busy"
    @click="logout"
  >
    {{ busy ? "正在退出" : error ? "重试退出登录" : "退出登录"
    }}<span v-if="busy" class="spinner" />
  </button>
  <ModalDialog
    v-if="editing"
    title="修改昵称"
    close-label="关闭昵称修改"
    :busy="saving"
    @close="editing = false"
  >
    <form @submit.prevent="saveNickname">
      <label class="field-label"
        >昵称<input
          v-model="nickname"
          autofocus
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
  </ModalDialog>
  <InviteDialog
    v-if="inviting && canInvite && workspace.active.value"
    :key="workspace.selectedId.value"
    :project-id="workspace.selectedId.value"
    @close="inviting = false"
  />
  <p v-if="error" class="error" role="alert">{{ error }}</p>
  <footer class="profile-brand">时光故事</footer>
</template>
