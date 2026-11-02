<script setup lang="ts">
import { BasicLayout } from "@vben/layouts";
import { Alert, Button } from "antdv-next";
import { useRouter } from "vue-router";
import { adminApi } from "../api/admin";
import {
  clearPrivateState,
  refreshSession,
  session,
  sessionError,
} from "../session";
import { ref } from "vue";
const router = useRouter(),
  busy = ref(false);
async function logout() {
  if (busy.value) return;
  busy.value = true;
  try {
    await adminApi.logout(session.value!.csrfToken);
    clearPrivateState();
    sessionStorage.removeItem("timenook-admin-return");
    await refreshSession();
    await router.replace("/auth/login");
  } catch {
    sessionError.value = "退出未完成，请重试。";
  } finally {
    busy.value = false;
  }
}
</script>
<template>
  <BasicLayout @clear-preferences-and-logout="logout">
    <template #logo-text><span class="font-semibold">时光里</span></template>
    <template #user-dropdown
      ><div class="operator-actions">
        <span>{{ session?.operator?.username }}</span
        ><Button :loading="busy" @click="logout">退出登录</Button>
      </div></template
    >
    <template #extra
      ><Alert
        v-if="sessionError"
        role="alert"
        type="error"
        :message="sessionError"
        class="session-error" /></template
  ></BasicLayout>
</template>
