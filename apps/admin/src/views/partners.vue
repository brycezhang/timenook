<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Alert, Button } from "antdv-next";
import type {
  AdminPartner,
  AdminPartnerCredentials,
} from "@timenook/contracts";
import { adminRequest, errorText, session } from "../session";
const items = ref<AdminPartner[]>([]),
  credentials = ref<AdminPartnerCredentials | null>(null),
  busy = ref(false),
  error = ref("");
async function load() {
  items.value = await adminRequest<AdminPartner[]>("/partners");
}
async function create() {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  credentials.value = null;
  try {
    credentials.value = await adminRequest<AdminPartnerCredentials>(
      "/partners",
      {
        method: "POST",
        body: "{}",
        headers: { "X-CSRF-Token": session.value!.csrfToken },
      },
    );
    await load();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
async function revoke(id: string) {
  if (busy.value) return;
  busy.value = true;
  error.value = "";
  try {
    await adminRequest(`/partners/${id}/revoke`, {
      method: "POST",
      body: "{}",
      headers: { "X-CSRF-Token": session.value!.csrfToken },
    });
    if (credentials.value?.id === id) credentials.value = null;
    await load();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    busy.value = false;
  }
}
onMounted(() =>
  load().catch((e) => {
    error.value = errorText(e);
  }),
);
</script>
<template>
  <main class="page">
    <h1>第三方账号</h1>
    <Alert v-if="error" type="error" :message="error" />
    <Button type="primary" :loading="busy" @click="create"
      >生成第三方账号</Button
    >
    <section v-if="credentials" class="credentials" aria-label="账号交付信息">
      <h2>账号已生成</h2>
      <p>密码仅展示这一次，请保存并交付给使用人。</p>
      <dl>
        <dt>用户名</dt>
        <dd data-testid="issued-username">{{ credentials.username }}</dd>
        <dt>初始密码</dt>
        <dd data-testid="issued-password">{{ credentials.password }}</dd>
      </dl>
      <Button @click="credentials = null">已保存，关闭</Button>
    </section>
    <div class="table-scroll">
      <table>
        <thead>
          <tr>
            <th>用户名</th>
            <th>状态</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="item in items" :key="item.id">
            <td>{{ item.username }}</td>
            <td>{{ item.disabled ? "已撤销" : "可使用" }}</td>
            <td>
              <Button
                v-if="!item.disabled"
                danger
                :disabled="busy"
                @click="revoke(item.id)"
                >撤销账号</Button
              >
            </td>
          </tr>
        </tbody>
      </table>
    </div>
  </main>
</template>
<style scoped>
.credentials {
  margin: 20px 0;
  padding: 20px;
  background: var(--background, #fff);
  border: 1px solid #ddd;
}
dd {
  overflow-wrap: anywhere;
  margin: 8px 0 16px;
}
table {
  width: 100%;
  margin-top: 24px;
}
th,
td {
  padding: 12px;
  text-align: left;
}
.table-scroll {
  overflow-x: auto;
}
</style>
