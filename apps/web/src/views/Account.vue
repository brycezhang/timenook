<script setup lang="ts">
import { ref } from "vue";
import { RouterLink } from "vue-router";
import { auth } from "../session";
import Icon from "../components/Icon.vue";
defineEmits<{ login: [] }>();
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
    <p class="eyebrow">让回忆有一个安心的归处</p>
    <h1>我的</h1>
  </section>
  <section class="account-panel panel">
    <div class="account-avatar"><Icon name="user" :size="30" /></div>
    <h2>{{ auth.account.value?.user.nickname ?? "欢迎来到时光故事" }}</h2>
    <p class="muted">
      {{
        auth.account.value
          ? "同一手机号，网页和小程序接着记录。"
          : "登录后，查看你购买和受邀参与的故事书。"
      }}
    </p>
    <RouterLink v-if="auth.account.value" class="button" to="/projects"
      >我的项目<Icon name="arrow" :size="16" /></RouterLink
    ><button v-else class="button" @click="$emit('login')">
      手机号登录<Icon name="arrow" :size="16" />
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
  <p v-if="error" class="error" role="alert">{{ error }}</p>
</template>
