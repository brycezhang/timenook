<script setup lang="ts">
import { BasicLayout, UserDropdown } from "@vben/layouts";
import type { AdminPermission } from "@timenook/contracts";
import { Alert } from "antdv-next";
import { useRoute, useRouter } from "vue-router";
import { adminApi } from "../api/admin";
import {
  clearPrivateState,
  can,
  refreshSession,
  session,
  sessionError,
} from "../session";
import { computed, ref } from "vue";
const route = useRoute(),
  router = useRouter(),
  busy = ref(false);
const canRenderProtected = computed(() => {
  const permission = route.meta.permission as AdminPermission | undefined;
  return (
    session.value?.authenticated === true && (!permission || can(permission))
  );
});
async function logout() {
  if (busy.value) return;
  busy.value = true;
  sessionError.value = "";
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
  <BasicLayout v-if="canRenderProtected" @clear-preferences-and-logout="logout">
    <template #user-dropdown>
      <UserDropdown
        :text="session?.operator?.username"
        :enable-shortcut-key="false"
        @logout="logout"
      />
    </template>
    <template #extra
      ><Alert
        v-if="sessionError"
        role="alert"
        type="error"
        :message="sessionError"
        class="session-error" /></template
  ></BasicLayout>
</template>
