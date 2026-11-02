<script setup lang="ts">
import { onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { Alert, Button } from "antdv-next";
import { adminApi } from "../api/admin";
import { refreshSession, session, sessionError } from "../session";
import { safeReturn } from "../router";
const route = useRoute(),
  router = useRouter(),
  busy = ref(false);
onMounted(() => {
  if (route.query.login_error) {
    sessionError.value =
      route.query.login_error === "denied"
        ? "飞书登录未完成，请重试或联系管理员。"
        : "飞书登录暂不可用，请稍后重试。";
    const query = { ...route.query };
    delete query.login_error;
    void router.replace({ path: route.path, query });
  }
});
async function reconnect() {
  busy.value = true;
  sessionError.value = "";
  try {
    await refreshSession();
    if (session.value?.authenticated)
      await router.replace(safeReturn(route.query.redirect));
  } catch {
    sessionError.value = "暂时无法连接运营入口，请重试。";
  } finally {
    busy.value = false;
  }
}
async function login() {
  if (busy.value) return;
  busy.value = true;
  sessionError.value = "";
  try {
    await refreshSession();
    sessionStorage.setItem(
      "timenook-admin-return",
      safeReturn(route.query.redirect),
    );
    const result = await adminApi.feishuLogin(session.value!.csrfToken);
    window.location.assign(result.authorizationUrl);
  } catch {
    sessionError.value = "飞书登录未完成，请稍后重试。";
    busy.value = false;
  }
}
</script>
<template>
  <section class="login-form">
    <h1>运营登录</h1>
    <p>使用已获授权的飞书账号登录。</p>
    <Alert
      v-if="sessionError"
      role="alert"
      type="error"
      :message="sessionError"
    /><Alert
      v-if="session && !session.loginAvailable"
      type="info"
      message="飞书登录尚未配置，请联系管理员。"
    /><Button
      block
      type="primary"
      size="large"
      :loading="busy"
      :disabled="!session?.loginAvailable"
      @click="login"
      >飞书登录</Button
    >
  </section>
</template>
