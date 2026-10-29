<script setup lang="ts">
import { Alert, Button } from "antdv-next";
defineProps<{ available: boolean; busy: boolean; error: string }>();
const emit = defineEmits<{ login: [] }>();
</script>
<template>
  <main class="auth-page">
    <section class="auth-panel">
      <div class="brand">时光里 <span>运营管理</span></div>
      <h1>运营登录</h1>
      <p class="description">使用已获授权的飞书账号登录。</p>
      <Alert
        v-if="error"
        type="error"
        :message="error"
        show-icon
        class="notice"
        role="alert"
      />
      <Alert
        v-if="!available"
        type="info"
        message="飞书登录尚未配置，请联系管理员。"
        show-icon
        class="notice"
        role="status"
      />
      <Button
        type="primary"
        block
        size="large"
        :loading="busy"
        :disabled="!available"
        @click="emit('login')"
        >飞书登录</Button
      >
    </section>
  </main>
</template>
