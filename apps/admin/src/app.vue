<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { Alert, Button } from "antdv-next";
import { ADMIN_PERMISSIONS } from "@timenook/contracts";
import type {
  AdminState,
  AdminAuditEntry,
  AdminRuntime,
} from "@timenook/contracts";
import { adminApi } from "./api/admin";
import Auth from "./views/auth.vue";
import BasicLayout from "./layouts/basic.vue";
import Runtime from "./views/runtime.vue";
import Catalog from "./views/catalog.vue";
import ServiceTerms from "./views/service-terms.vue";
import Care from "./views/care.vue";
import Tasks from "./views/tasks.vue";
const view = ref("runtime");
const state = ref<AdminState | null>(null),
  secret = ref(""),
  busy = ref(false),
  error = ref(""),
  status = ref<AdminRuntime["status"] | "">("");
const audits = ref<AdminAuditEntry[] | null>(null);
const canManageTerms = computed(
  () =>
    state.value?.operator?.permissions.includes(
      ADMIN_PERMISSIONS.writeServiceTerms,
    ) ?? false,
);
const canManageCare = computed(
  () =>
    state.value?.operator?.permissions.includes(ADMIN_PERMISSIONS.writeCare) ??
    false,
);
const canReadRuntime = computed(
  () =>
    state.value?.operator?.permissions.includes(
      ADMIN_PERMISSIONS.readRuntime,
    ) ?? false,
);
const canReadAudit = computed(
  () =>
    state.value?.operator?.permissions.includes(ADMIN_PERMISSIONS.readAudit) ??
    false,
);
const canReadCatalog = computed(
  () =>
    state.value?.operator?.permissions.includes(
      ADMIN_PERMISSIONS.readCatalog,
    ) ?? false,
);
function clearSession() {
  view.value = "runtime";
  state.value = null;
  secret.value = "";
  audits.value = null;
  status.value = "";
}
async function sync() {
  state.value = await adminApi.session();
  secret.value = "";
  if (state.value.enrollmentRequired)
    secret.value = (await adminApi.enrollment()).secret;
  if (state.value.authenticated && canReadRuntime.value)
    status.value = (await adminApi.runtime()).status;
  return state.value;
}
async function perform(action: () => Promise<unknown>) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await action();
  } catch (failure) {
    const code = (failure as { error?: { code?: string } }).error?.code;
    if (code === "UNAUTHENTICATED") {
      clearSession();
      const refreshed = await sync().catch(() => null);
      error.value = refreshed?.mfaRequired
        ? "验证码无效或已使用，请等待新验证码。"
        : "登录或验证已到期，请重新登录。";
    } else
      error.value =
        code === "RATE_LIMITED"
          ? "尝试次数较多，请稍后重试。"
          : "验证或请求未完成，请检查输入后重试。";
  } finally {
    busy.value = false;
  }
}
function login(username: string, password: string) {
  void perform(async () => {
    state.value = await adminApi.login(
      username,
      password,
      state.value!.csrfToken,
    );
    if (state.value.enrollmentRequired)
      secret.value = (await adminApi.enrollment()).secret;
  });
}
function mfa(code: string) {
  void perform(async () => {
    state.value = await adminApi.mfa(code, state.value!.csrfToken);
    secret.value = "";
    if (canReadRuntime.value) status.value = (await adminApi.runtime()).status;
  });
}
function logout() {
  void perform(async () => {
    await adminApi.logout(state.value!.csrfToken);
    clearSession();
    await sync();
  });
}
onMounted(() => {
  void perform(sync);
});
</script>
<template>
  <BasicLayout
    v-if="state?.authenticated"
    :username="state.operator!.username"
    :busy="busy"
    @logout="logout"
  >
    <Alert
      v-if="error"
      type="error"
      :message="error"
      class="notice"
      role="alert"
    />
    <nav
      v-if="canReadCatalog || canManageTerms || canManageCare || canReadRuntime"
      class="catalog-navigation"
    >
      <Button
        :type="view === 'runtime' ? 'primary' : 'default'"
        @click="view = 'runtime'"
        >运行信息</Button
      ><Button
        v-if="canReadCatalog"
        :type="view === 'catalog' ? 'primary' : 'default'"
        @click="view = 'catalog'"
        >关系与套餐</Button
      >
      <Button
        v-if="canManageTerms"
        :type="view === 'terms' ? 'primary' : 'default'"
        @click="view = 'terms'"
        >服务期限</Button
      >
      <Button
        v-if="canReadRuntime"
        :type="view === 'tasks' ? 'primary' : 'default'"
        @click="view = 'tasks'"
        >处理任务</Button
      >
      <Button
        v-if="canManageCare"
        :type="view === 'care' ? 'primary' : 'default'"
        @click="view = 'care'"
        >客服工单</Button
      >
    </nav>
    <Catalog
      v-if="view === 'catalog' && canReadCatalog"
      :csrf="state.csrfToken"
      :permissions="state.operator!.permissions"
      @expired="
        perform(async () => {
          throw { error: { code: 'UNAUTHENTICATED' } };
        })
      "
    />
    <ServiceTerms
      v-else-if="view === 'terms' && canManageTerms"
      :csrf="state.csrfToken"
      @expired="
        perform(async () => {
          throw { error: { code: 'UNAUTHENTICATED' } };
        })
      "
    />
    <Care
      v-else-if="view === 'care' && canManageCare"
      :csrf="state.csrfToken"
      @expired="
        perform(async () => {
          throw { error: { code: 'UNAUTHENTICATED' } };
        })
      "
    />
    <Tasks
      v-else-if="view === 'tasks' && canReadRuntime"
      :csrf="state.csrfToken"
      :permissions="state.operator!.permissions"
      @expired="
        perform(async () => {
          throw { error: { code: 'UNAUTHENTICATED' } };
        })
      "
    />
    <Runtime
      v-else
      :status="status"
      :can-read-runtime="canReadRuntime"
      :can-read-audit="canReadAudit"
      :audits="audits"
      :busy="busy"
      @refresh="
        perform(async () => {
          status = (await adminApi.runtime()).status;
        })
      "
      @audit="
        perform(async () => {
          audits = await adminApi.audit();
        })
      "
    />
  </BasicLayout>
  <Auth
    v-else-if="state"
    :mfa="state.mfaRequired"
    :secret="secret"
    :busy="busy"
    :error="error"
    @login="login"
    @verify="mfa"
    @cancel="logout"
  />
  <main v-else class="auth-page">
    <div>
      <p>{{ error || "正在连接运营入口…" }}</p>
      <button v-if="error" @click="perform(sync)">重试连接</button>
    </div>
  </main>
</template>
