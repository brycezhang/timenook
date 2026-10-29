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
import Care from "./views/care.vue";
import Tasks from "./views/tasks.vue";
import Fulfillment from "./views/fulfillment.vue";
const view = ref("runtime");
const productionTarget = ref("");
const state = ref<AdminState | null>(null),
  busy = ref(false),
  error = ref(""),
  status = ref<AdminRuntime["status"] | "">("");
const audits = ref<AdminAuditEntry[] | null>(null);
const canManageFulfillment = computed(
  () =>
    state.value?.operator?.permissions.includes(
      ADMIN_PERMISSIONS.writeFulfillment,
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
  productionTarget.value = "";
  state.value = null;
  audits.value = null;
  status.value = "";
}
async function sync() {
  state.value = await adminApi.session();
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
      await sync().catch(() => null);
      error.value = "登录已到期，请重新使用飞书登录。";
    } else
      error.value =
        code === "RATE_LIMITED"
          ? "尝试次数较多，请稍后重试。"
          : "请求未完成，请稍后重试。";
  } finally {
    busy.value = false;
  }
}
function login() {
  void perform(async () => {
    const result = await adminApi.feishuLogin(state.value!.csrfToken);
    window.location.assign(result.authorizationUrl);
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
  const url = new URL(window.location.href);
  const callback = url.searchParams.get("login_error");
  if (callback !== null) {
    url.searchParams.delete("login_error");
    window.history.replaceState(null, "", url.pathname + url.search + url.hash);
  }
  void perform(async () => {
    await sync();
    if (callback !== null && !state.value?.authenticated)
      error.value =
        callback === "denied"
          ? "飞书登录未完成，请重试或联系管理员。"
          : "飞书登录暂不可用，请稍后重试。";
  });
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
      v-if="
        canReadCatalog ||
        canManageCare ||
        canReadRuntime ||
        canManageFulfillment
      "
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
      <Button
        v-if="canManageFulfillment"
        :type="view === 'fulfillment' ? 'primary' : 'default'"
        @click="view = 'fulfillment'"
        >生产与物流</Button
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
    <Care
      v-else-if="view === 'care' && canManageCare"
      :csrf="state.csrfToken"
      @production="
        (orderId) => {
          if (canManageFulfillment) {
            productionTarget = orderId;
            view = 'fulfillment';
          }
        }
      "
      @expired="
        perform(async () => {
          throw { error: { code: 'UNAUTHENTICATED' } };
        })
      "
    />
    <Fulfillment
      v-else-if="view === 'fulfillment' && canManageFulfillment"
      :csrf="state.csrfToken"
      :initial-order-id="productionTarget"
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
    :available="state.loginAvailable"
    :busy="busy"
    :error="error"
    @login="login"
  />
  <main v-else class="auth-page">
    <div>
      <p>{{ error || "正在连接运营入口…" }}</p>
      <button v-if="error" @click="perform(sync)">重试连接</button>
    </div>
  </main>
</template>
