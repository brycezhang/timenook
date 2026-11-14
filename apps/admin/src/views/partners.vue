<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref } from "vue";
import { Page } from "@vben/common-ui";
import {
  Alert,
  Button,
  Card,
  Modal,
  Popconfirm,
  Space,
  Table,
  Tag,
} from "antdv-next";
import type {
  AdminPartner,
  AdminPartnerCredentials,
} from "@timenook/contracts";
import { adminRequest, errorText, session } from "../session";
const items = ref<AdminPartner[]>([]),
  credentials = ref<AdminPartnerCredentials | null>(null),
  loading = ref(false),
  creating = ref(false),
  updating = ref<string | null>(null),
  passwordAccount = ref<AdminPartner | null>(null),
  passwordLoading = ref(false),
  passwordError = ref(""),
  error = ref("");
let passwordRequest = 0;
const columns = [
  { title: "用户名", dataIndex: "username" },
  { title: "状态", key: "state", width: 90 },
  { title: "操作", key: "actions", width: 280 },
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
  if (creating.value || updating.value) return;
  creating.value = true;
  error.value = "";
  closePassword();
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
async function removeAccess(id: string, action: "revoke" | "delete") {
  if (creating.value || updating.value) return;
  updating.value = id;
  error.value = "";
  try {
    await adminRequest(
      `/partners/${id}${action === "revoke" ? "/revoke" : ""}`,
      {
        method: action === "revoke" ? "POST" : "DELETE",
        body: "{}",
        headers: { "X-CSRF-Token": session.value!.csrfToken },
      },
    );
    await load();
  } catch (e) {
    error.value = errorText(e);
  } finally {
    updating.value = null;
  }
}
function closePassword() {
  passwordRequest++;
  passwordAccount.value = null;
  credentials.value = null;
  passwordError.value = "";
  passwordLoading.value = false;
}
async function fetchPassword(
  id: string,
  action: "password" | "reset-password",
) {
  const request = ++passwordRequest;
  passwordLoading.value = true;
  passwordError.value = "";
  credentials.value = null;
  try {
    const result = await adminRequest<AdminPartnerCredentials>(
      `/partners/${id}/${action}`,
      {
        method: "POST",
        body: "{}",
        headers: { "X-CSRF-Token": session.value!.csrfToken },
      },
    );
    if (request === passwordRequest) credentials.value = result;
    if (action === "reset-password") await load();
  } catch (e) {
    if (request === passwordRequest) {
      passwordError.value =
        (e as { error?: { code?: string } })?.error?.code === "CONFLICT"
          ? "当前密码无法查看。重置后可查看新密码。"
          : errorText(e);
    }
  } finally {
    if (request === passwordRequest) passwordLoading.value = false;
  }
}
function showPassword(account: AdminPartner) {
  closePassword();
  passwordAccount.value = account;
  if (account.passwordAvailable) void fetchPassword(account.id, "password");
}
onMounted(load);
onBeforeUnmount(closePassword);
</script>
<template>
  <Page description="管理用于渠道录单的后台账号。">
    <template #title><h1>第三方账号</h1></template>
    <Card title="账号列表">
      <template #extra>
        <Button
          type="primary"
          :loading="creating"
          :disabled="!!updating"
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
        :scroll="{ x: 500 }"
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
          <Space v-else-if="column.key === 'actions'" :size="0">
            <template v-if="!record.disabled">
              <Button
                type="link"
                :disabled="creating || !!updating"
                @click="showPassword(record as AdminPartner)"
              >
                查看密码
              </Button>
              <Popconfirm
                title="撤销该账号？"
                description="账号将无法继续登录或录单，历史记录会保留。"
                ok-text="确认撤销"
                :ok-button-props="{ danger: true }"
                @confirm="removeAccess(record.id, 'revoke')"
              >
                <Button type="link" :disabled="creating || !!updating"
                  >撤销账号</Button
                >
              </Popconfirm>
            </template>
            <Popconfirm
              title="删除该账号？"
              description="账号将从列表移除，密码及会话立即失效，历史录单保留。"
              ok-text="确认删除"
              :ok-button-props="{ danger: true }"
              @confirm="removeAccess(record.id, 'delete')"
            >
              <Button type="link" danger :disabled="creating || !!updating"
                >删除账号</Button
              >
            </Popconfirm>
          </Space>
        </template>
      </Table>
    </Card>
    <Modal
      :open="!!passwordAccount || !!credentials"
      :title="passwordAccount ? '查看密码' : '账号已生成'"
      :mask-closable="false"
      :closable="!passwordLoading"
      :keyboard="!passwordLoading"
      @cancel="closePassword"
    >
      <template #footer>
        <Space>
          <Popconfirm
            v-if="passwordAccount && !credentials && !passwordLoading"
            title="重置该账号密码？"
            description="旧密码和该账号的现有登录将立即失效。"
            ok-text="确认重置"
            @confirm="fetchPassword(passwordAccount.id, 'reset-password')"
          >
            <Button>重置密码</Button>
          </Popconfirm>
          <Button
            type="primary"
            :disabled="passwordLoading"
            @click="closePassword"
          >
            {{ passwordAccount ? "关闭" : "已保存，关闭" }}
          </Button>
        </Space>
      </template>
      <div v-if="credentials">
        <Alert
          type="info"
          message="请将密码交付给账号使用人。"
          show-icon
          class="mb-4"
        />
        <dl class="credentials">
          <dt>用户名</dt>
          <dd data-testid="issued-username">{{ credentials.username }}</dd>
          <dt>密码</dt>
          <dd data-testid="issued-password">{{ credentials.password }}</dd>
        </dl>
      </div>
      <p v-else-if="passwordLoading" role="status">正在读取密码…</p>
      <Alert
        v-else-if="passwordAccount"
        :type="passwordError ? 'error' : 'info'"
        :message="passwordError || '此账号原密码无法查看，请重置后交付新密码。'"
      />
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
