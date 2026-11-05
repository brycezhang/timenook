<script setup lang="ts">
import { ConfigProvider } from "antdv-next";
import zhCN from "antdv-next/locale/zh_CN";
</script>
<template>
  <ConfigProvider :locale="zhCN" :button="{ autoInsertSpace: false }"
    ><RouterView
  /></ConfigProvider>
</template>
