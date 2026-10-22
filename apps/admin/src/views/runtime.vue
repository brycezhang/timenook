<script setup lang="ts">
import { Alert, Button, Tag } from "antdv-next";
import type { AdminAuditEntry, AdminRuntime } from "@timenook/contracts";
defineProps<{
  status: AdminRuntime["status"] | "";
  canReadRuntime: boolean;
  canReadAudit: boolean;
  audits: AdminAuditEntry[] | null;
  busy: boolean;
}>();
const emit = defineEmits<{ refresh: []; audit: [] }>();
</script>
<template>
  <section class="runtime">
    <div class="page-title">
      <div>
        <h1>运行信息</h1>
        <p>TimeNook 服务与依赖状态</p>
      </div>
      <Button v-if="canReadRuntime" :loading="busy" @click="emit('refresh')"
        >刷新状态</Button
      >
    </div>
    <Alert
      v-if="!canReadRuntime"
      type="info"
      message="当前账号暂无运行信息查看权限，请联系管理员。"
      show-icon
    />
    <div v-else class="status-row">
      <div>
        <h2>TimeNook API</h2>
        <p>数据库与任务调度依赖</p>
      </div>
      <Tag :color="status === 'ready' ? 'success' : 'warning'">{{
        status === "ready"
          ? "服务可用"
          : status === "unavailable"
            ? "依赖暂不可用"
            : "正在检查"
      }}</Tag>
    </div>
    <section v-if="canReadAudit" class="audit-section">
      <div class="page-title">
        <div>
          <h2>操作审计</h2>
          <p>最近 100 条管理操作记录</p>
        </div>
        <Button :loading="busy" @click="emit('audit')">{{
          audits ? "刷新审计" : "查看操作审计"
        }}</Button>
      </div>
      <div v-if="audits" class="audit-table">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>操作人</th>
              <th>动作</th>
              <th>结果</th>
              <th>请求标识</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="entry in audits" :key="entry.id">
              <td>{{ new Date(entry.createdAt).toLocaleString("zh-CN") }}</td>
              <td>{{ entry.operatorId ?? "未认证 / 受控命令" }}</td>
              <td>{{ entry.action }}</td>
              <td>{{ entry.result }}</td>
              <td>{{ entry.requestId }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </section>
</template>
