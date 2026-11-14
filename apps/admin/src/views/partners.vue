<script setup lang="ts">
import { onMounted, ref } from "vue";
import { Page } from "@vben/common-ui";
import { Alert, Button, Card, Modal, Popconfirm, Table, Tag } from "antdv-next";
import type {
  AdminPartner,
  AdminPartnerCredentials,
} from "@timenook/contracts";
import { adminRequest, errorText, session } from "../session";
const items = ref<AdminPartner[]>([]),
  credentials = ref<AdminPartnerCredentials | null>(null),
  loading = ref(false),
  creating = ref(false),
  revoking = ref<string | null>(null),
  error = ref("");
const columns = [
  { title: "用户名", dataIndex: "username" },
  { title: "状态", key: "state", width: 90 },
  { title: "操作", key: "actions", width: 110 },
];
async function load() {
  loading.value = true;
  error.value = "";
  try {
    items.value = await adminRequest<AdminPartner[]>("/partners");
  } catch (e) {
    error.value = errorText(e);
  } finally {
    loading.value = false;
  }
}
async function create() {
  if (creating.value || revoking.value) return;
  creating.value = true;
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
    creating.value = false;
  }
}
async function revoke(id: string) {
  if (creating.value || revoking.value) return;
  revoking.value = id;
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
    revoking.value = null;
  }
}
onMounted(load);
</script>
<template>
  <Page description="生成和撤销用于渠道录单的后台账号。">
    <template #title><h1>第三方账号</h1></template>
    <Card title="账号列表">
      <template #extra>
        <Button
          type="primary"
          :loading="creating"
          :disabled="!!revoking"
          @click="create"
        >
          生成第三方账号
        </Button>
      </template>
      <Alert
        v-if="error"
        type="error"
        :message="error"
        role="alert"
        class="mb-4"
      >
        <template #action
          ><Button size="small" @click="load">刷新列表</Button></template
        >
      </Alert>
      <Table
        :columns="columns"
        :data-source="items"
        :loading="loading"
        :scroll="{ x: 340 }"
        :pagination="{ pageSize: 20, hideOnSinglePage: true }"
        :locale="{ emptyText: '暂无第三方账号' }"
        row-key="id"
      >
        <template #bodyCell="{ column, record }">
          <span v-if="column.dataIndex === 'username'" class="identifier">{{
            record.username
          }}</span>
          <Tag
            v-else-if="column.key === 'state'"
            :color="record.disabled ? 'default' : 'green'"
          >
            {{ record.disabled ? "已撤销" : "可使用" }}
          </Tag>
          <Popconfirm
            v-else-if="column.key === 'actions' && !record.disabled"
            title="撤销该账号？"
            description="账号将无法继续登录或录单，历史记录会保留。"
            ok-text="确认撤销"
            :ok-button-props="{ danger: true }"
            @confirm="revoke(record.id)"
          >
            <Button
              type="link"
              danger
              :loading="revoking === record.id"
              :disabled="creating || !!revoking"
            >
              撤销账号
            </Button>
          </Popconfirm>
        </template>
      </Table>
    </Card>
    <Modal
      :open="!!credentials"
      title="账号已生成"
      :closable="false"
      :mask-closable="false"
      :keyboard="false"
    >
      <template #footer>
        <Button type="primary" @click="credentials = null">已保存，关闭</Button>
      </template>
      <div v-if="credentials">
        <Alert
          type="info"
          message="密码仅展示这一次，请保存并交付给使用人。"
          show-icon
          class="mb-4"
        />
        <dl class="credentials">
          <dt>用户名</dt>
          <dd data-testid="issued-username">{{ credentials.username }}</dd>
          <dt>初始密码</dt>
          <dd data-testid="issued-password">{{ credentials.password }}</dd>
        </dl>
      </div>
    </Modal>
  </Page>
</template>
<style scoped>
.credentials dd {
  font-family: ui-monospace, monospace;
  overflow-wrap: anywhere;
  margin: 4px 0 12px;
}
</style>
