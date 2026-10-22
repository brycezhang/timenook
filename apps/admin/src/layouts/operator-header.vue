<script setup lang="ts">
import { Button } from "antdv-next";
defineProps<{ username: string; busy: boolean }>();
const emit = defineEmits<{ logout: [] }>();
</script>
<template>
  <header class="app-header">
    <strong>运营管理</strong>
    <div class="operator">
      <span>{{ username }}</span
      ><Button :loading="busy" @click="emit('logout')">退出登录</Button>
    </div>
  </header>
</template>
